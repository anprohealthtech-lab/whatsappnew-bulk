import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, SignalDataSet } from '@whiskeysockets/baileys';
import { db } from '../db';
import { baileysAuthKeys } from '@shared/schema';
import { eq, and, sql } from 'drizzle-orm';

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
  // ---------- low-level helpers ----------

  async function readData(category: string, keyId: string): Promise<any> {
    const rows = await db
      .select()
      .from(baileysAuthKeys)
      .where(and(
        eq(baileysAuthKeys.sessionId, sessionId),
        eq(baileysAuthKeys.category, category),
        eq(baileysAuthKeys.keyId, keyId),
      ))
      .limit(1);

    if (rows.length === 0) return null;
    // data was stored via BufferJSON.replacer — revive it
    const json = JSON.stringify(rows[0].data);
    return JSON.parse(json, BufferJSON.reviver);
  }

  async function writeData(category: string, keyId: string, value: any): Promise<void> {
    // Serialize with BufferJSON to handle Buffer / Uint8Array fields
    const dataJson = JSON.stringify(value, BufferJSON.replacer);

    // Atomic upsert via ON CONFLICT — no race condition
    try {
      await db.execute(sql`
        INSERT INTO baileys_auth_keys (id, session_id, category, key_id, data, created_at, updated_at)
        VALUES (gen_random_uuid(), ${sessionId}, ${category}, ${keyId}, ${dataJson}::jsonb, now(), now())
        ON CONFLICT (session_id, category, key_id)
        DO UPDATE SET data = ${dataJson}::jsonb, updated_at = now()
      `);
    } catch (err) {
      console.error(`❌ useDbAuthState writeData failed [${category}/${keyId}]:`, err);
    }
  }

  async function removeData(category: string, keyId: string): Promise<void> {
    await db
      .delete(baileysAuthKeys)
      .where(and(
        eq(baileysAuthKeys.sessionId, sessionId),
        eq(baileysAuthKeys.category, category),
        eq(baileysAuthKeys.keyId, keyId),
      ));
  }

  // ---------- load or init credentials ----------
  const storedCreds = await readData('creds', 'creds');
  const hasExistingCreds = !!storedCreds;
  const creds: AuthenticationCreds = storedCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(type, id);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) {
                result[id] = value;
              }
            }),
          );
          const found = Object.keys(result).length;
          if (type === 'session' || type === 'pre-key') {
            console.log(`🔑 keys.get(${type}, [${ids.length} ids]) → found ${found}/${ids.length}`);
          }
          return result;
        },

        set: async (data: SignalDataSet): Promise<void> => {
          const tasks: Promise<void>[] = [];
          const summary: string[] = [];
          for (const category in data) {
            const entries = data[category as keyof SignalDataTypeMap]!;
            let writes = 0, deletes = 0;
            for (const id in entries) {
              const value = entries[id];
              if (value != null) {
                writes++;
                tasks.push(writeData(category, id, value));
              } else {
                deletes++;
                tasks.push(removeData(category, id));
              }
            }
            summary.push(`${category}: +${writes} -${deletes}`);
          }
          await Promise.all(tasks);
          console.log(`🔑 keys.set → ${summary.join(', ')}`);
        },
      },
    },

    saveCreds: async () => {
      console.log(`💾 Saving creds to DB for session "${sessionId}"`);
      await writeData('creds', 'creds', creds);
    },
    hasExistingCreds,
  };
}

/**
 * Delete ALL auth keys for a session (used when user disconnects / re-pairs).
 */
export async function clearDbAuthState(sessionId: string): Promise<number> {
  const deleted = await db
    .delete(baileysAuthKeys)
    .where(eq(baileysAuthKeys.sessionId, sessionId))
    .returning({ id: baileysAuthKeys.id });
  return deleted.length;
}
