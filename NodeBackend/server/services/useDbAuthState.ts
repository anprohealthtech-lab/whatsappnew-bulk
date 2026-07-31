import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, SignalDataSet } from '@whiskeysockets/baileys';
import { db } from '../db';
import { baileysAuthKeys } from '@shared/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';

// ─── Per-session diagnostics exposed for logging in disconnect handlers ───
export interface DbAuthDiagnostics {
  sessionId: string;
  writeFailures: number;
  readFailures: number;
  lastWriteFailure: { category: string; keyId: string; error: string; at: string } | null;
  lastReadFailure: { category: string; keyId: string; error: string; at: string } | null;
  totalWrites: number;
  totalReads: number;
  credsWriteCount: number;
  lastCredsWriteAt: string | null;
  slowQueries: number; // queries taking > 2s
}

const sessionDiagnostics = new Map<string, DbAuthDiagnostics>();

export function getDbAuthDiagnostics(sessionId: string): DbAuthDiagnostics | null {
  return sessionDiagnostics.get(sessionId) || null;
}

function getDiag(sessionId: string): DbAuthDiagnostics {
  if (!sessionDiagnostics.has(sessionId)) {
    sessionDiagnostics.set(sessionId, {
      sessionId,
      writeFailures: 0,
      readFailures: 0,
      lastWriteFailure: null,
      lastReadFailure: null,
      totalWrites: 0,
      totalReads: 0,
      credsWriteCount: 0,
      lastCredsWriteAt: null,
      slowQueries: 0,
    });
  }
  return sessionDiagnostics.get(sessionId)!;
}

/**
 * Database-backed Baileys auth state.
 * Drop-in replacement for useMultiFileAuthState — stores all keys + creds in PostgreSQL
 * so they survive ephemeral filesystem deploys (DigitalOcean App Platform).
 */
export async function useDbAuthState(sessionId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  hasExistingCreds: boolean;
}> {
  const diag = getDiag(sessionId);

  // ---------- in-memory key cache ----------
  //
  // Baileys 7 looks up 'lid-mapping' and 'device-list' once per JID — a campaign
  // fires hundreds of separate keys.get calls, each holding a single id. Batching
  // cannot help a call of one, so those all hit Postgres at once and every read
  // lands in the multi-second range from pool contention, stalling the send.
  //
  // These two categories are stable identity mappings, so holding them in memory
  // is safe. Signal 'session'/'pre-key' are deliberately NOT cached — serving
  // those stale broke sending once already (commit beebc5e).
  const CACHEABLE = new Set(['lid-mapping', 'device-list']);
  const HIT_TTL_MS = 10 * 60 * 1000;
  const MISS_TTL_MS = 60 * 1000;   // shorter: a miss usually means we're about to learn it
  const MAX_CACHED = 5000;

  const memCache = new Map<string, { value: any; at: number }>();
  const inFlight = new Map<string, Promise<Record<string, any>>>();

  function cacheGet(category: string, keyId: string): { value: any } | null {
    const entry = memCache.get(`${category}:${keyId}`);
    if (!entry) return null;
    const ttl = entry.value == null ? MISS_TTL_MS : HIT_TTL_MS;
    if (Date.now() - entry.at > ttl) {
      memCache.delete(`${category}:${keyId}`);
      return null;
    }
    return { value: entry.value };
  }

  function cacheSet(category: string, keyId: string, value: any): void {
    if (memCache.size >= MAX_CACHED) {
      // Cheap eviction: drop the oldest insertion (Map preserves insert order).
      const oldest = memCache.keys().next();
      if (!oldest.done) memCache.delete(oldest.value);
    }
    memCache.set(`${category}:${keyId}`, { value: value ?? null, at: Date.now() });
  }

  function cacheInvalidate(category: string, keyId: string): void {
    memCache.delete(`${category}:${keyId}`);
  }

  /** Share one in-flight query between concurrent lookups of the same key. */
  function readCoalesced(category: string, keyIds: string[]): Promise<Record<string, any>> {
    if (keyIds.length !== 1) return readMany(category, keyIds);

    const key = `${category}:${keyIds[0]}`;
    const existing = inFlight.get(key);
    if (existing) return existing;

    const pending = readMany(category, keyIds).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  // ---------- low-level helpers with retry + timing ----------

  async function readData(category: string, keyId: string): Promise<any> {
    const start = Date.now();
    try {
      const rows = await db
        .select()
        .from(baileysAuthKeys)
        .where(and(
          eq(baileysAuthKeys.sessionId, sessionId),
          eq(baileysAuthKeys.category, category),
          eq(baileysAuthKeys.keyId, keyId),
        ))
        .limit(1);

      const elapsed = Date.now() - start;
      diag.totalReads++;
      if (elapsed > 2000) {
        diag.slowQueries++;
        console.warn(`⚠️ [DbAuth:${sessionId}] SLOW read ${category}/${keyId} took ${elapsed}ms`);
      }

      if (rows.length === 0) return null;
      const json = JSON.stringify(rows[0].data);
      return JSON.parse(json, BufferJSON.reviver);
    } catch (err: any) {
      const elapsed = Date.now() - start;
      diag.readFailures++;
      diag.lastReadFailure = {
        category,
        keyId,
        error: err?.code || err?.message || String(err),
        at: new Date().toISOString(),
      };
      console.error(
        `❌ [DbAuth:${sessionId}] readData FAILED [${category}/${keyId}] after ${elapsed}ms ` +
        `(total read failures: ${diag.readFailures}): ${err?.code || err?.message}`
      );
      // Return null instead of throwing — Baileys treats missing keys as "not found"
      // which is safer than crashing the whole operation
      return null;
    }
  }

  /**
   * Fetch many keys of one category in a single round trip.
   *
   * Baileys 7 asks for hundreds of ids at once (notably 'lid-mapping', one per
   * recipient of a campaign). Reading those one query at a time saturates the
   * connection pool and pushes every read into multi-second territory, which
   * stalls the send. Keep this batched.
   */
  async function readMany(category: string, keyIds: string[]): Promise<Record<string, any>> {
    if (keyIds.length === 0) return {};

    const start = Date.now();
    try {
      const rows = await db
        .select()
        .from(baileysAuthKeys)
        .where(and(
          eq(baileysAuthKeys.sessionId, sessionId),
          eq(baileysAuthKeys.category, category),
          inArray(baileysAuthKeys.keyId, keyIds),
        ));

      const elapsed = Date.now() - start;
      diag.totalReads += keyIds.length;
      if (elapsed > 2000) {
        diag.slowQueries++;
        console.warn(
          `⚠️ [DbAuth:${sessionId}] SLOW batch read ${category} [${keyIds.length} ids] took ${elapsed}ms`
        );
      }

      const out: Record<string, any> = {};
      for (const row of rows) {
        out[row.keyId] = JSON.parse(JSON.stringify(row.data), BufferJSON.reviver);
      }
      return out;
    } catch (err: any) {
      const elapsed = Date.now() - start;
      diag.readFailures++;
      diag.lastReadFailure = {
        category,
        keyId: `<batch of ${keyIds.length}>`,
        error: err?.code || err?.message || String(err),
        at: new Date().toISOString(),
      };
      console.error(
        `❌ [DbAuth:${sessionId}] readMany FAILED [${category}, ${keyIds.length} ids] after ${elapsed}ms ` +
        `(total read failures: ${diag.readFailures}): ${err?.code || err?.message}`
      );
      // Missing keys are safe for Baileys; a thrown error here is not.
      return {};
    }
  }

  async function writeData(category: string, keyId: string, value: any): Promise<void> {
    const dataJson = JSON.stringify(value, BufferJSON.replacer);
    const maxRetries = category === 'creds' ? 3 : 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const start = Date.now();
      try {
        await db.execute(sql`
          INSERT INTO baileys_auth_keys (id, session_id, category, key_id, data, created_at, updated_at)
          VALUES (gen_random_uuid(), ${sessionId}, ${category}, ${keyId}, ${dataJson}::jsonb, now(), now())
          ON CONFLICT (session_id, category, key_id)
          DO UPDATE SET data = ${dataJson}::jsonb, updated_at = now()
        `);

        const elapsed = Date.now() - start;
        diag.totalWrites++;
        if (elapsed > 2000) {
          diag.slowQueries++;
          console.warn(`⚠️ [DbAuth:${sessionId}] SLOW write ${category}/${keyId} took ${elapsed}ms`);
        }
        if (category === 'creds') {
          diag.credsWriteCount++;
          diag.lastCredsWriteAt = new Date().toISOString();
        }
        return; // success
      } catch (err: any) {
        const elapsed = Date.now() - start;
        if (attempt < maxRetries) {
          console.warn(
            `⚠️ [DbAuth:${sessionId}] writeData retry ${attempt}/${maxRetries} [${category}/${keyId}] ` +
            `after ${elapsed}ms: ${err?.code || err?.message}`
          );
          await new Promise(r => setTimeout(r, 500 * attempt));
          continue;
        }
        // Final attempt failed
        diag.writeFailures++;
        diag.lastWriteFailure = {
          category,
          keyId,
          error: err?.code || err?.message || String(err),
          at: new Date().toISOString(),
        };
        console.error(
          `❌ [DbAuth:${sessionId}] writeData FAILED [${category}/${keyId}] after ${maxRetries} attempts, ` +
          `${elapsed}ms (total write failures: ${diag.writeFailures}): ${err?.code || err?.message}`
        );
        // For creds writes, this is CRITICAL — rethrow so the caller knows
        if (category === 'creds') {
          throw new Error(`Critical: failed to save creds for ${sessionId}: ${err?.message}`);
        }
      }
    }
  }

  /** Upsert many keys of one category in a single statement. See readMany. */
  async function writeMany(category: string, entries: Array<{ keyId: string; value: any }>): Promise<number> {
    if (entries.length === 0) return 0;

    const start = Date.now();
    try {
      await db
        .insert(baileysAuthKeys)
        .values(entries.map(({ keyId, value }) => ({
          sessionId,
          category,
          keyId,
          data: sql`${JSON.stringify(value, BufferJSON.replacer)}::jsonb`,
        })))
        .onConflictDoUpdate({
          target: [baileysAuthKeys.sessionId, baileysAuthKeys.category, baileysAuthKeys.keyId],
          set: {
            data: sql`excluded.data`,
            updatedAt: new Date(),
          },
        });

      const elapsed = Date.now() - start;
      diag.totalWrites += entries.length;
      if (elapsed > 2000) {
        diag.slowQueries++;
        console.warn(
          `⚠️ [DbAuth:${sessionId}] SLOW batch write ${category} [${entries.length} keys] took ${elapsed}ms`
        );
      }
      return 0;
    } catch (err: any) {
      diag.writeFailures++;
      diag.lastWriteFailure = {
        category,
        keyId: `<batch of ${entries.length}>`,
        error: err?.code || err?.message || String(err),
        at: new Date().toISOString(),
      };
      console.error(
        `❌ [DbAuth:${sessionId}] writeMany FAILED [${category}, ${entries.length} keys]: ` +
        `${err?.code || err?.message} — falling back to per-key writes`
      );

      // Fall back so one bad row cannot lose the whole batch.
      let failed = 0;
      await Promise.all(entries.map(({ keyId, value }) =>
        writeData(category, keyId, value).catch(() => { failed++; })
      ));
      return failed;
    }
  }

  async function removeData(category: string, keyId: string): Promise<void> {
    try {
      await db
        .delete(baileysAuthKeys)
        .where(and(
          eq(baileysAuthKeys.sessionId, sessionId),
          eq(baileysAuthKeys.category, category),
          eq(baileysAuthKeys.keyId, keyId),
        ));
    } catch (err: any) {
      console.warn(`⚠️ [DbAuth:${sessionId}] removeData failed [${category}/${keyId}]: ${err?.message}`);
    }
  }

  // ---------- load or init credentials ----------
  const storedCreds = await readData('creds', 'creds');
  const hasExistingCreds = !!storedCreds;
  const creds: AuthenticationCreds = storedCreds || initAuthCreds();

  console.log(
    `🔐 [DbAuth:${sessionId}] Initialized — existingCreds=${hasExistingCreds}, ` +
    `registrationId=${creds.registrationId}, platform=${creds.platform || 'unknown'}`
  );

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          const start = Date.now();
          const cacheable = CACHEABLE.has(type);

          const missing: string[] = [];
          let cacheHits = 0;
          for (const id of ids) {
            const cached = cacheable ? cacheGet(type, id) : null;
            if (cached) {
              cacheHits++;
              if (cached.value) result[id] = cached.value;
            } else {
              missing.push(id);
            }
          }

          if (missing.length > 0) {
            const rows = await readCoalesced(type, missing);
            for (const id of missing) {
              let value = rows[id];
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (cacheable) cacheSet(type, id, value);
              if (value) {
                result[id] = value;
              }
            }
          }

          const found = Object.keys(result).length;
          const elapsed = Date.now() - start;
          if (cacheHits === ids.length) {
            return result; // fully served from memory — not worth a log line
          }
          if (type === 'session' || type === 'pre-key' || elapsed > 2000) {
            console.log(
              `🔑 keys.get(${type}, [${ids.length} ids]) → found ${found}/${ids.length} (${elapsed}ms)` +
              (diag.readFailures > 0 ? ` ⚠️ cumulative read failures: ${diag.readFailures}` : '')
            );
          }
          return result;
        },

        set: async (data: SignalDataSet): Promise<void> => {
          const tasks: Promise<void>[] = [];
          const summary: string[] = [];
          let failedWrites = 0;
          const start = Date.now();

          for (const category in data) {
            const entries = data[category as keyof SignalDataTypeMap]!;
            const upserts: Array<{ keyId: string; value: any }> = [];
            let deletes = 0;
            for (const id in entries) {
              const value = entries[id];
              // Keep the in-memory copy honest — a write always supersedes it.
              cacheInvalidate(category, id);
              if (value != null) {
                upserts.push({ keyId: id, value });
              } else {
                deletes++;
                tasks.push(removeData(category, id));
              }
            }
            if (upserts.length > 0) {
              tasks.push(
                writeMany(category, upserts).then((failed) => { failedWrites += failed; })
              );
            }
            summary.push(`${category}: +${upserts.length} -${deletes}`);
          }
          await Promise.all(tasks);
          const elapsed = Date.now() - start;
          const failSuffix = failedWrites > 0
            ? ` ⚠️ ${failedWrites} WRITE(S) FAILED — session may become inconsistent!`
            : '';
          console.log(`🔑 keys.set → ${summary.join(', ')} (${elapsed}ms)${failSuffix}`);
        },
      },
    },

    saveCreds: async () => {
      const prevFailures = diag.writeFailures;
      console.log(
        `💾 Saving creds to DB for session "${sessionId}" ` +
        `(write #${diag.credsWriteCount + 1}, prev write failures: ${diag.writeFailures})`
      );
      try {
        await writeData('creds', 'creds', creds);
        console.log(`✅ [DbAuth:${sessionId}] Creds saved successfully`);
      } catch (err: any) {
        console.error(
          `🚨 [DbAuth:${sessionId}] CRITICAL: Creds save FAILED — ` +
          `this WILL cause badSession on next reconnect! Error: ${err?.message}`
        );
      }
    },
    hasExistingCreds,
  };
}

/**
 * Count total auth keys for a session (diagnostic).
 */
export async function countDbAuthKeys(sessionId: string): Promise<{ total: number; byCategory: Record<string, number> }> {
  try {
    const rows = await db
      .select({
        category: baileysAuthKeys.category,
      })
      .from(baileysAuthKeys)
      .where(eq(baileysAuthKeys.sessionId, sessionId));

    const byCategory: Record<string, number> = {};
    for (const row of rows) {
      byCategory[row.category] = (byCategory[row.category] || 0) + 1;
    }
    return { total: rows.length, byCategory };
  } catch {
    return { total: -1, byCategory: {} };
  }
}

/**
 * Delete ALL auth keys for a session (used when user disconnects / re-pairs).
 */
export async function clearDbAuthState(sessionId: string): Promise<number> {
  console.log(`🗑️ [DbAuth:${sessionId}] Clearing all auth keys from DB`);
  const deleted = await db
    .delete(baileysAuthKeys)
    .where(eq(baileysAuthKeys.sessionId, sessionId))
    .returning({ id: baileysAuthKeys.id });
  console.log(`🗑️ [DbAuth:${sessionId}] Cleared ${deleted.length} auth keys`);
  // Reset diagnostics
  sessionDiagnostics.delete(sessionId);
  return deleted.length;
}
