import postgres from 'postgres';
import { log } from './utils';

/**
 * Runs full schema migration on startup.
 * Uses CREATE TABLE IF NOT EXISTS — safe to run multiple times.
 * Designed to run inside DO App Platform where DB connectivity is guaranteed.
 */
export async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    log('⚠️ No DATABASE_URL set, skipping migrations');
    return;
  }

  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 30,
    ssl: 'require',
    prepare: false,
    fetch_types: false,
  });

  try {
    log('🔄 Running database migrations...');

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "messages" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "phone_number" text NOT NULL,
        "content" text NOT NULL,
        "type" text NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "file_url" text,
        "file_name" text,
        "file_size" integer,
        "sample_id" text,
        "metadata" jsonb,
        "created_at" timestamp DEFAULT now(),
        "sent_at" timestamp,
        "delivered_at" timestamp
      );

      CREATE TABLE IF NOT EXISTS "system_logs" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "level" text NOT NULL,
        "message" text NOT NULL,
        "metadata" jsonb,
        "created_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "users" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "username" text NOT NULL,
        "password" text NOT NULL,
        CONSTRAINT "users_username_unique" UNIQUE("username")
      );

      CREATE TABLE IF NOT EXISTS "campaigns" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "name" text NOT NULL,
        "original_message" text NOT NULL,
        "fixed_params" jsonb,
        "selected_variation" text,
        "buttons" jsonb,
        "include_stop_button" text DEFAULT 'false',
        "total_contacts" integer DEFAULT 0,
        "attachment_path" text,
        "attachment_name" text,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "campaign_recipients" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "campaign_id" varchar NOT NULL,
        "name" text NOT NULL,
        "phone" text NOT NULL,
        "extra" jsonb,
        "status" text DEFAULT 'pending',
        "sent_at" timestamp,
        "error_reason" text,
        "created_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "message_variations" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "campaign_id" varchar NOT NULL,
        "message" text NOT NULL,
        "original_message" text,
        "variation_number" integer,
        "fixed_params" jsonb,
        "created_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "auto_responses" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "keyword" text NOT NULL,
        "response" text NOT NULL,
        "is_active" text DEFAULT 'true' NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "blocked_numbers" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "phone_number" text NOT NULL,
        "reason" text DEFAULT 'user_requested',
        "blocked_at" timestamp DEFAULT now(),
        CONSTRAINT "blocked_numbers_phone_number_unique" UNIQUE("phone_number")
      );

      CREATE TABLE IF NOT EXISTS "contacts" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "phone_number" text NOT NULL,
        "name" text,
        "is_lead" text DEFAULT 'false' NOT NULL,
        "lead_trigger_keyword" text,
        "chatbot_active" text DEFAULT 'true' NOT NULL,
        "user_type" text,
        "conversation_state" jsonb,
        "last_message_at" timestamp,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now(),
        CONSTRAINT "contacts_phone_number_unique" UNIQUE("phone_number")
      );

      CREATE TABLE IF NOT EXISTS "chatbot_configs" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "agent_name" text NOT NULL,
        "trigger_keywords" jsonb NOT NULL,
        "rag_base_url" text NOT NULL,
        "rag_access_key" text NOT NULL,
        "system_prompt" text,
        "greeting_message" text,
        "context_message_count" integer DEFAULT 5,
        "reply_cooldown_seconds" integer DEFAULT 8,
        "typing_delay_ms" integer DEFAULT 2000,
        "is_active" text DEFAULT 'true' NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "hr_admins" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "phone_number" text NOT NULL,
        "name" text,
        "organization_id" text NOT NULL,
        "user_id" text NOT NULL,
        "organization_name" text,
        "chatbot_active" text DEFAULT 'true' NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now(),
        CONSTRAINT "hr_admins_phone_number_unique" UNIQUE("phone_number")
      );

      CREATE TABLE IF NOT EXISTS "hr_chatbot_configs" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "agent_name" text NOT NULL,
        "rag_base_url" text NOT NULL,
        "rag_access_key" text NOT NULL,
        "supabase_url" text NOT NULL,
        "supabase_service_key" text NOT NULL,
        "context_message_count" integer DEFAULT 5,
        "is_active" text DEFAULT 'true' NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      -- Add FK constraints (safe with IF NOT EXISTS pattern via DO blocks)
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'campaign_recipients_campaign_id_fk'
        ) THEN
          ALTER TABLE "campaign_recipients"
            ADD CONSTRAINT "campaign_recipients_campaign_id_fk"
            FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE cascade;
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'message_variations_campaign_id_fk'
        ) THEN
          ALTER TABLE "message_variations"
            ADD CONSTRAINT "message_variations_campaign_id_fk"
            FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE cascade;
        END IF;
      END $$;
    `);

    log('✅ Database migrations completed — all tables ready');
  } catch (err: any) {
    log(`❌ Migration failed: ${err.message}`);
    console.error('Migration error:', err);
    // Don't throw — let app start anyway, some tables may already exist
  } finally {
    await sql.end();
  }
}
