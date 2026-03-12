/**
 * Migration 0004: Add per-user chatbot config columns to user_rag_agents
 * These allow each user to override the global chatbot_configs defaults.
 *
 * Also applied inline in server/migrate.ts for DO App Platform auto-run.
 */
import postgres from 'postgres';

export async function up(connectionString: string) {
  const sql = postgres(connectionString, { max: 1, ssl: 'require', prepare: false });

  try {
    await sql.unsafe(`
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "trigger_keywords" jsonb;
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "greeting_message" text;
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "context_message_count" integer;
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "reply_cooldown_seconds" integer;
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "typing_delay_ms" integer;
    `);
    console.log('✅ Migration 0004 applied — user_rag_agents per-user columns added');
  } finally {
    await sql.end();
  }
}
