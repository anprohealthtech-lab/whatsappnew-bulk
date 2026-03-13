import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, SignalDataSet } from '@whiskeysockets/baileys';
import { db } from '../db';
import { baileysAuthKeys } from '@shared/schema';
import { eq, and } from 'drizzle-orm';

/**
 * Database-backed Baileys auth state.
 * Drop-in replacement for useMultiFileAuthState — stores all keys + creds in PostgreSQL
 * so they survive ephemeral filesystem deploys (DigitalOcean App Platform).
 */
export async function useDbAuthState(sessionId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
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
    const data = JSON.parse(JSON.stringify(value, BufferJSON.replacer));

    // Upsert: try update first, insert if not found
    const existing = await db
      .select({ id: baileysAuthKeys.id })
      .from(baileysAuthKeys)
      .where(and(
        eq(baileysAuthKeys.sessionId, sessionId),
        eq(baileysAuthKeys.category, category),
        eq(baileysAuthKeys.keyId, keyId),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(baileysAuthKeys)
        .set({ data, updatedAt: new Date() })
        .where(eq(baileysAuthKeys.id, existing[0].id));
    } else {
      await db.insert(baileysAuthKeys).values({
        sessionId,
        category,
        keyId,
        data,
      });
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
  const creds: AuthenticationCreds =
    (await readData('creds', 'creds')) || initAuthCreds();

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
          return result;
        },

        set: async (data: SignalDataSet): Promise<void> => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const entries = data[category as keyof SignalDataTypeMap]!;
            for (const id in entries) {
              const value = entries[id];
              tasks.push(
                value != null
                  ? writeData(category, id, value)
                  : removeData(category, id),
              );
            }
          }
          await Promise.all(tasks);
        },
      },
    },

    saveCreds: async () => {
      await writeData('creds', 'creds', creds);
    },
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
