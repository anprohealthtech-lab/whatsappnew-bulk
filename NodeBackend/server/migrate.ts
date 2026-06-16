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
        "organization_id" text DEFAULT 'default_org' NOT NULL,
        "user_id" text DEFAULT 'default_user' NOT NULL,
        "name" text NOT NULL,
        "campaign_type" text DEFAULT 'campaign' NOT NULL,
        "original_message" text NOT NULL,
        "fixed_params" jsonb,
        "selected_variation" text,
        "buttons" jsonb,
        "include_stop_button" text DEFAULT 'false',
        "total_contacts" integer DEFAULT 0,
        "attachment_path" text,
        "attachment_name" text,
        "attachment_paths" jsonb,
        "attachment_file_names" jsonb,
        "run_status" text DEFAULT 'idle' NOT NULL,
        "default_interval_seconds" integer DEFAULT 25,
        "default_jitter_seconds" integer DEFAULT 0,
        "run_started_at" timestamp,
        "run_paused_at" timestamp,
        "run_completed_at" timestamp,
        "run_updated_at" timestamp,
        "last_run_summary" jsonb,
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

      CREATE TABLE IF NOT EXISTS "campaign_schedules" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "campaign_id" varchar NOT NULL,
        "organization_id" text DEFAULT 'default_org' NOT NULL,
        "user_id" text DEFAULT 'default_user' NOT NULL,
        "variation_message" text NOT NULL,
        "status" text DEFAULT 'scheduled' NOT NULL,
        "interval_seconds" integer DEFAULT 25 NOT NULL,
        "jitter_seconds" integer DEFAULT 0 NOT NULL,
        "scheduled_at" timestamp NOT NULL,
        "started_at" timestamp,
        "completed_at" timestamp,
        "result_summary" jsonb,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "user_rag_agents" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL,
        "user_id" text NOT NULL,
        "agent_name" text NOT NULL,
        "rag_base_url" text NOT NULL,
        "rag_access_key" text NOT NULL,
        "system_prompt" text,
        "is_active" text DEFAULT 'true' NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "user_notification_recipients" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL,
        "user_id" text NOT NULL,
        "phone_number" text NOT NULL,
        "label" text,
        "notify_on_lead_created" text DEFAULT 'true' NOT NULL,
        "notify_on_demo_scheduled" text DEFAULT 'true' NOT NULL,
        "notify_on_booking_confirmed" text DEFAULT 'true' NOT NULL,
        "is_active" text DEFAULT 'true' NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
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

      CREATE TABLE IF NOT EXISTS "demo_schedules" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text DEFAULT 'default_org' NOT NULL,
        "user_id" text DEFAULT 'default_user' NOT NULL,
        "phone_number" text NOT NULL,
        "contact_name" text,
        "meeting_link" text NOT NULL,
        "demo_at" timestamp NOT NULL,
        "remind_30_sent_at" timestamp,
        "remind_15_sent_at" timestamp,
        "remind_5_sent_at" timestamp,
        "created_at" timestamp DEFAULT now()
      );

      -- WhatsApp sessions per user (multi-user)
      CREATE TABLE IF NOT EXISTS "whatsapp_sessions" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" varchar NOT NULL,
        "organization_id" text DEFAULT 'default_org' NOT NULL,
        "phone_number" text,
        "session_name" text DEFAULT 'default' NOT NULL,
        "status" text DEFAULT 'disconnected' NOT NULL,
        "last_connected_at" timestamp,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_demo_schedules_demo_at
        ON demo_schedules(demo_at)
        WHERE remind_5_sent_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_campaigns_tenant
        ON campaigns(organization_id, user_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_campaign_schedules_due
        ON campaign_schedules(status, scheduled_at);

      CREATE INDEX IF NOT EXISTS idx_user_rag_agents_owner
        ON user_rag_agents(organization_id, user_id, updated_at);

      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'default_org' NOT NULL;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "user_id" text DEFAULT 'default_user' NOT NULL;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "campaign_type" text DEFAULT 'campaign' NOT NULL;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "attachment_paths" jsonb;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "attachment_file_names" jsonb;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "run_status" text DEFAULT 'idle' NOT NULL;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "default_interval_seconds" integer DEFAULT 25;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "default_jitter_seconds" integer DEFAULT 0;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "run_started_at" timestamp;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "run_paused_at" timestamp;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "run_completed_at" timestamp;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "run_updated_at" timestamp;
      ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "last_run_summary" jsonb;

      -- Multi-user columns on existing tables
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'default_org' NOT NULL;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'user' NOT NULL;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();

      ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'default_org' NOT NULL;
      ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "user_id" text DEFAULT 'default_user' NOT NULL;

      ALTER TABLE "blocked_numbers" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'default_org' NOT NULL;
      ALTER TABLE "blocked_numbers" ADD COLUMN IF NOT EXISTS "user_id" text DEFAULT 'default_user' NOT NULL;

      ALTER TABLE "auto_responses" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'default_org' NOT NULL;
      ALTER TABLE "auto_responses" ADD COLUMN IF NOT EXISTS "user_id" text DEFAULT 'default_user' NOT NULL;

      ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'default_org' NOT NULL;
      ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "user_id" text DEFAULT 'default_user' NOT NULL;

      ALTER TABLE "demo_schedules" ADD COLUMN IF NOT EXISTS "organization_id" text DEFAULT 'default_org' NOT NULL;
      ALTER TABLE "demo_schedules" ADD COLUMN IF NOT EXISTS "user_id" text DEFAULT 'default_user' NOT NULL;

      -- Indexes for multi-user lookups
      CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(organization_id, user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(organization_id, user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_tenant_phone_unique ON contacts(organization_id, user_id, phone_number);
      CREATE INDEX IF NOT EXISTS idx_auto_responses_tenant ON auto_responses(organization_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_blocked_numbers_tenant ON blocked_numbers(organization_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_user ON whatsapp_sessions(user_id, session_name);

      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'contacts_phone_number_unique'
            AND table_name = 'contacts'
        ) THEN
          ALTER TABLE "contacts" DROP CONSTRAINT "contacts_phone_number_unique";
        END IF;
      END $$;

      -- Per-user chatbot config columns on user_rag_agents (0004)
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "trigger_keywords" jsonb;
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "greeting_message" text;
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "context_message_count" integer;
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "reply_cooldown_seconds" integer;
      ALTER TABLE "user_rag_agents" ADD COLUMN IF NOT EXISTS "typing_delay_ms" integer;

      ALTER TABLE "user_notification_recipients" ADD COLUMN IF NOT EXISTS "organization_id" text NOT NULL DEFAULT 'default_org';
      ALTER TABLE "user_notification_recipients" ADD COLUMN IF NOT EXISTS "user_id" text NOT NULL DEFAULT 'default_user';
      ALTER TABLE "user_notification_recipients" ADD COLUMN IF NOT EXISTS "label" text;
      ALTER TABLE "user_notification_recipients" ADD COLUMN IF NOT EXISTS "notify_on_lead_created" text DEFAULT 'true' NOT NULL;
      ALTER TABLE "user_notification_recipients" ADD COLUMN IF NOT EXISTS "notify_on_demo_scheduled" text DEFAULT 'true' NOT NULL;
      ALTER TABLE "user_notification_recipients" ADD COLUMN IF NOT EXISTS "notify_on_booking_confirmed" text DEFAULT 'true' NOT NULL;
      ALTER TABLE "user_notification_recipients" ADD COLUMN IF NOT EXISTS "is_active" text DEFAULT 'true' NOT NULL;
      ALTER TABLE "user_notification_recipients" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
      ALTER TABLE "user_notification_recipients" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();

      CREATE INDEX IF NOT EXISTS idx_user_notification_recipients_tenant
        ON user_notification_recipients(organization_id, user_id, created_at);

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

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'campaign_schedules_campaign_id_fk'
        ) THEN
          ALTER TABLE "campaign_schedules"
            ADD CONSTRAINT "campaign_schedules_campaign_id_fk"
            FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE cascade;
        END IF;
      END $$;

      -- Baileys auth state in DB (survives ephemeral filesystem deploys)
      CREATE TABLE IF NOT EXISTS "baileys_auth_keys" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "session_id" text NOT NULL,
        "category" text NOT NULL,
        "key_id" text NOT NULL,
        "data" jsonb NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "baileys_auth_keys_session_cat_key"
        ON "baileys_auth_keys" ("session_id", "category", "key_id");

      CREATE INDEX IF NOT EXISTS "baileys_auth_keys_session_id"
        ON "baileys_auth_keys" ("session_id");

      -- Session connection history — tracks connect/disconnect events for auditing
      CREATE TABLE IF NOT EXISTS "session_connection_history" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "session_name" text NOT NULL,
        "event" text NOT NULL,
        "reason" text,
        "status_code" integer,
        "phone_number" text,
        "session_duration_seconds" integer,
        "metadata" jsonb,
        "created_at" timestamp DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_session_history_user_id
        ON session_connection_history(user_id);

      CREATE INDEX IF NOT EXISTS idx_session_history_user_session
        ON session_connection_history(user_id, session_name);

      CREATE INDEX IF NOT EXISTS idx_session_history_event
        ON session_connection_history(event);

      -- 0007: Start from contact support for campaign schedules
      ALTER TABLE "campaign_schedules" ADD COLUMN IF NOT EXISTS "start_from_contact" integer;

      -- 0008: HIMS (Hospital Information Management System) patient registration
      CREATE TABLE IF NOT EXISTS "hims_patients" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "phone_number" text NOT NULL UNIQUE,
        "name" text,
        "organization_id" text NOT NULL,
        "system_prompt" text,
        "trigger_keywords" jsonb,
        "greeting_message" text,
        "chatbot_active" text NOT NULL DEFAULT 'true',
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_hims_patients_phone
        ON hims_patients(phone_number);

      CREATE INDEX IF NOT EXISTS idx_hims_patients_org
        ON hims_patients(organization_id);

      -- 0009: Per-user feature flags (Task Management, HIMS Chatbot, Data Management)
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "enabled_features" jsonb DEFAULT '{"taskManagement": false, "himsChatbot": false, "dataManagement": false}'::jsonb;

      -- 0010: Intelligent Data Management / EMR memory
      CREATE TABLE IF NOT EXISTS "data_patients" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text DEFAULT 'default_org' NOT NULL,
        "user_id" text DEFAULT 'default_user' NOT NULL,
        "canonical_name" text NOT NULL,
        "aliases" jsonb DEFAULT '[]'::jsonb,
        "age" integer,
        "gender" text,
        "phone_numbers" jsonb DEFAULT '[]'::jsonb,
        "dob" text,
        "summary" text,
        "metadata" jsonb DEFAULT '{}'::jsonb,
        "first_seen_at" timestamp DEFAULT now(),
        "last_updated_at" timestamp DEFAULT now(),
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "data_documents" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text DEFAULT 'default_org' NOT NULL,
        "user_id" text DEFAULT 'default_user' NOT NULL,
        "patient_id" varchar,
        "source" text DEFAULT 'whatsapp' NOT NULL,
        "source_phone_number" text,
        "source_message_id" text,
        "file_name" text,
        "mime_type" text,
        "file_size" integer,
        "file_url" text,
        "storage_bucket" text,
        "storage_path" text,
        "case_batch_id" varchar,
        "sequence_number" integer,
        "caption" text,
        "document_type" text DEFAULT 'unknown' NOT NULL,
        "ocr_text" text,
        "extracted_json" jsonb DEFAULT '{}'::jsonb,
        "confidence" real,
        "status" text DEFAULT 'processed' NOT NULL,
        "error_message" text,
        "received_at" timestamp DEFAULT now(),
        "processed_at" timestamp,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      ALTER TABLE "data_documents"
        ADD COLUMN IF NOT EXISTS "file_url" text,
        ADD COLUMN IF NOT EXISTS "storage_bucket" text,
        ADD COLUMN IF NOT EXISTS "storage_path" text,
        ADD COLUMN IF NOT EXISTS "case_batch_id" varchar,
        ADD COLUMN IF NOT EXISTS "sequence_number" integer,
        ADD COLUMN IF NOT EXISTS "caption" text;

      CREATE TABLE IF NOT EXISTS "data_case_batches" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text DEFAULT 'default_org' NOT NULL,
        "user_id" text DEFAULT 'default_user' NOT NULL,
        "patient_id" varchar NOT NULL,
        "patient_name_hint" text NOT NULL,
        "source_phone_number" text,
        "status" text DEFAULT 'collecting' NOT NULL,
        "expected_attachment_count" integer,
        "received_attachment_count" integer DEFAULT 0 NOT NULL,
        "event_date" text,
        "summary" text,
        "error_message" text,
        "started_at" timestamp DEFAULT now(),
        "collection_completed_at" timestamp,
        "processing_started_at" timestamp,
        "completed_at" timestamp,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'data_case_batches_patient_id_fk'
        ) THEN
          ALTER TABLE "data_case_batches"
            ADD CONSTRAINT "data_case_batches_patient_id_fk"
            FOREIGN KEY ("patient_id") REFERENCES "data_patients"("id") ON DELETE cascade;
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'data_documents_case_batch_id_fk'
        ) THEN
          ALTER TABLE "data_documents"
            ADD CONSTRAINT "data_documents_case_batch_id_fk"
            FOREIGN KEY ("case_batch_id") REFERENCES "data_case_batches"("id") ON DELETE set null;
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS "data_patient_events" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text DEFAULT 'default_org' NOT NULL,
        "user_id" text DEFAULT 'default_user' NOT NULL,
        "patient_id" varchar NOT NULL,
        "document_id" varchar,
        "event_type" text DEFAULT 'document_received' NOT NULL,
        "event_date" text,
        "summary" text NOT NULL,
        "structured_data" jsonb DEFAULT '{}'::jsonb,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "data_general_records" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text DEFAULT 'default_org' NOT NULL,
        "user_id" text DEFAULT 'default_user' NOT NULL,
        "document_id" varchar,
        "record_type" text DEFAULT 'general_note' NOT NULL,
        "title" text NOT NULL,
        "period_start" text,
        "period_end" text,
        "raw_text" text,
        "structured_data" jsonb DEFAULT '{}'::jsonb,
        "confidence" real,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'data_documents_patient_id_fk'
        ) THEN
          ALTER TABLE "data_documents"
            ADD CONSTRAINT "data_documents_patient_id_fk"
            FOREIGN KEY ("patient_id") REFERENCES "data_patients"("id") ON DELETE set null;
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'data_patient_events_patient_id_fk'
        ) THEN
          ALTER TABLE "data_patient_events"
            ADD CONSTRAINT "data_patient_events_patient_id_fk"
            FOREIGN KEY ("patient_id") REFERENCES "data_patients"("id") ON DELETE cascade;
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'data_patient_events_document_id_fk'
        ) THEN
          ALTER TABLE "data_patient_events"
            ADD CONSTRAINT "data_patient_events_document_id_fk"
            FOREIGN KEY ("document_id") REFERENCES "data_documents"("id") ON DELETE set null;
        END IF;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'data_general_records_document_id_fk'
        ) THEN
          ALTER TABLE "data_general_records"
            ADD CONSTRAINT "data_general_records_document_id_fk"
            FOREIGN KEY ("document_id") REFERENCES "data_documents"("id") ON DELETE set null;
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS "idx_data_patients_tenant"
        ON "data_patients" ("organization_id", "user_id");

      CREATE INDEX IF NOT EXISTS "idx_data_patients_name"
        ON "data_patients" ("canonical_name");

      CREATE INDEX IF NOT EXISTS "idx_data_documents_tenant"
        ON "data_documents" ("organization_id", "user_id");

      CREATE INDEX IF NOT EXISTS "idx_data_documents_patient"
        ON "data_documents" ("patient_id");

      CREATE INDEX IF NOT EXISTS "idx_data_case_batches_active"
        ON "data_case_batches" ("organization_id", "user_id", "status", "created_at");

      CREATE INDEX IF NOT EXISTS "idx_data_documents_case_batch"
        ON "data_documents" ("case_batch_id", "sequence_number");

      CREATE UNIQUE INDEX IF NOT EXISTS "idx_data_documents_source_message"
        ON "data_documents" ("organization_id", "user_id", "source_message_id")
        WHERE "source_message_id" IS NOT NULL;

      CREATE INDEX IF NOT EXISTS "idx_data_patient_events_patient"
        ON "data_patient_events" ("patient_id", "created_at");

      CREATE INDEX IF NOT EXISTS "idx_data_general_records_tenant"
        ON "data_general_records" ("organization_id", "user_id", "record_type");

      -- 0011: Voice service pre-generated audio chunk cache
      CREATE TABLE IF NOT EXISTS "voice_flow_audio_chunks" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL,
        "user_id" text NOT NULL,
        "flow_id" text NOT NULL,
        "flow_version" integer DEFAULT 1 NOT NULL,
        "voice_profile_id" text,
        "node_id" text NOT NULL,
        "chunk_index" integer NOT NULL,
        "text" text NOT NULL,
        "text_hash" text NOT NULL,
        "voice_provider" text NOT NULL,
        "voice_id" text,
        "audio_path" text NOT NULL,
        "audio_url" text NOT NULL,
        "mime_type" text DEFAULT 'audio/mpeg' NOT NULL,
        "byte_size" integer,
        "metadata" jsonb DEFAULT '{}'::jsonb,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );

      ALTER TABLE "voice_flow_audio_chunks"
        ADD COLUMN IF NOT EXISTS "flow_version" integer DEFAULT 1 NOT NULL;
      ALTER TABLE "voice_flow_audio_chunks"
        ADD COLUMN IF NOT EXISTS "voice_profile_id" text;

      DROP INDEX IF EXISTS "voice_flow_audio_chunks_unique";
      CREATE UNIQUE INDEX "voice_flow_audio_chunks_unique"
        ON "voice_flow_audio_chunks" (
          "organization_id",
          "user_id",
          "flow_id",
          "flow_version",
          COALESCE("voice_profile_id", ''),
          "node_id",
          "chunk_index",
          "text_hash",
          "voice_provider",
          COALESCE("voice_id", '')
        );

      CREATE INDEX IF NOT EXISTS "voice_flow_audio_chunks_lookup"
        ON "voice_flow_audio_chunks" ("organization_id", "user_id", "flow_id", "node_id");

      CREATE TABLE IF NOT EXISTS "voice_provider_credentials" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL,
        "user_id" text NOT NULL,
        "provider" text NOT NULL,
        "credential_type" text NOT NULL,
        "name" text NOT NULL,
        "encrypted_secret" text NOT NULL,
        "account_id" text,
        "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "is_platform_managed" boolean DEFAULT false NOT NULL,
        "status" text DEFAULT 'active' NOT NULL,
        "last_verified_at" timestamp,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "voice_provider_credentials_tenant"
        ON "voice_provider_credentials" ("organization_id", "user_id", "credential_type", "status");

      CREATE TABLE IF NOT EXISTS "voice_profiles" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL,
        "user_id" text NOT NULL,
        "credential_id" varchar NOT NULL REFERENCES "voice_provider_credentials"("id") ON DELETE RESTRICT,
        "name" text NOT NULL,
        "provider" text NOT NULL,
        "reference_id" text,
        "model" text,
        "language" text,
        "audio_format" text DEFAULT 'mp3' NOT NULL,
        "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "status" text DEFAULT 'active' NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "voice_profiles_tenant"
        ON "voice_profiles" ("organization_id", "user_id", "status");

      CREATE TABLE IF NOT EXISTS "voice_agents" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL,
        "user_id" text NOT NULL,
        "name" text NOT NULL,
        "status" text DEFAULT 'active' NOT NULL,
        "system_prompt" text,
        "language_mode" text DEFAULT 'match_speaker' NOT NULL,
        "response_mode" text DEFAULT 'voice' NOT NULL,
        "default_flow_key" text,
        "rag_agent_id" varchar,
        "stt_credential_id" varchar REFERENCES "voice_provider_credentials"("id") ON DELETE SET NULL,
        "voice_profile_id" varchar REFERENCES "voice_profiles"("id") ON DELETE SET NULL,
        "widget_settings" jsonb DEFAULT '{"title":"Ask our AI assistant","welcomeMessage":"Tap the microphone and ask a question.","accentColor":"#6d5dfc","avatarUrl":null,"starterText":"Hello! Ask me anything and I will do my best to help.","starterAudioUrl":null,"starterAudioMimeType":null}'::jsonb,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );
      ALTER TABLE "voice_agents"
        ADD COLUMN IF NOT EXISTS "widget_settings" jsonb
        DEFAULT '{"title":"Ask our AI assistant","welcomeMessage":"Tap the microphone and ask a question.","accentColor":"#6d5dfc","avatarUrl":null,"starterText":"Hello! Ask me anything and I will do my best to help.","starterAudioUrl":null,"starterAudioMimeType":null}'::jsonb;
      CREATE INDEX IF NOT EXISTS "voice_agents_tenant"
        ON "voice_agents" ("organization_id", "user_id", "status");

      CREATE TABLE IF NOT EXISTS "voice_flows" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL,
        "user_id" text NOT NULL,
        "voice_agent_id" varchar REFERENCES "voice_agents"("id") ON DELETE CASCADE,
        "flow_key" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "version" integer NOT NULL,
        "status" text DEFAULT 'draft' NOT NULL,
        "start_node" text NOT NULL,
        "definition" jsonb NOT NULL,
        "voice_profile_id" varchar REFERENCES "voice_profiles"("id") ON DELETE SET NULL,
        "published_at" timestamp,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "voice_flows_tenant_version"
        ON "voice_flows" ("organization_id", "user_id", "flow_key", "version");
      CREATE INDEX IF NOT EXISTS "voice_flows_published_lookup"
        ON "voice_flows" ("organization_id", "user_id", "flow_key", "status", "version" DESC);

      CREATE TABLE IF NOT EXISTS "voice_gateway_devices" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL, "user_id" text NOT NULL, "name" text NOT NULL,
        "device_type" text NOT NULL, "pairing_code" text, "device_token_hash" text,
        "paired_device_id" varchar, "phone_number" text, "capabilities" jsonb DEFAULT '{}'::jsonb,
        "status" text DEFAULT 'offline' NOT NULL, "last_heartbeat_at" timestamp,
        "created_at" timestamp DEFAULT now(), "updated_at" timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "voice_gateway_devices_tenant"
        ON "voice_gateway_devices" ("organization_id", "user_id", "status");

      CREATE TABLE IF NOT EXISTS "voice_campaigns" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL, "user_id" text NOT NULL,
        "voice_agent_id" varchar NOT NULL REFERENCES "voice_agents"("id") ON DELETE CASCADE,
        "flow_id" varchar NOT NULL REFERENCES "voice_flows"("id") ON DELETE RESTRICT,
        "gateway_device_id" varchar REFERENCES "voice_gateway_devices"("id") ON DELETE SET NULL,
        "name" text NOT NULL, "status" text DEFAULT 'draft' NOT NULL,
        "timezone" text DEFAULT 'Asia/Kolkata' NOT NULL, "max_attempts" integer DEFAULT 1 NOT NULL,
        "retry_delay_minutes" integer DEFAULT 30 NOT NULL, "settings" jsonb DEFAULT '{}'::jsonb,
        "started_at" timestamp, "completed_at" timestamp,
        "created_at" timestamp DEFAULT now(), "updated_at" timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "voice_campaigns_tenant"
        ON "voice_campaigns" ("organization_id", "user_id", "status");

      CREATE TABLE IF NOT EXISTS "voice_campaign_contacts" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL, "user_id" text NOT NULL,
        "campaign_id" varchar NOT NULL REFERENCES "voice_campaigns"("id") ON DELETE CASCADE,
        "name" text, "phone_number" text NOT NULL, "variables" jsonb DEFAULT '{}'::jsonb,
        "consent_status" text DEFAULT 'confirmed' NOT NULL, "status" text DEFAULT 'queued' NOT NULL,
        "attempts" integer DEFAULT 0 NOT NULL, "next_attempt_at" timestamp DEFAULT now(),
        "last_outcome" text, "created_at" timestamp DEFAULT now(), "updated_at" timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "voice_campaign_contacts_queue"
        ON "voice_campaign_contacts" ("campaign_id", "status", "next_attempt_at");

      CREATE TABLE IF NOT EXISTS "voice_call_sessions" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL, "user_id" text NOT NULL,
        "campaign_id" varchar REFERENCES "voice_campaigns"("id") ON DELETE SET NULL,
        "contact_id" varchar REFERENCES "voice_campaign_contacts"("id") ON DELETE SET NULL,
        "voice_agent_id" varchar REFERENCES "voice_agents"("id") ON DELETE SET NULL,
        "flow_id" varchar REFERENCES "voice_flows"("id") ON DELETE SET NULL,
        "gateway_device_id" varchar REFERENCES "voice_gateway_devices"("id") ON DELETE SET NULL,
        "phone_number" text NOT NULL, "direction" text DEFAULT 'outbound' NOT NULL,
        "transport" text DEFAULT 'windows_bluetooth' NOT NULL, "status" text DEFAULT 'queued' NOT NULL,
        "transcript" jsonb DEFAULT '[]'::jsonb, "outcome" text, "error_message" text,
        "started_at" timestamp, "connected_at" timestamp, "ended_at" timestamp,
        "duration_seconds" integer DEFAULT 0, "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "voice_call_sessions_tenant"
        ON "voice_call_sessions" ("organization_id", "user_id", "created_at" DESC);

      CREATE TABLE IF NOT EXISTS "voice_usage" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "organization_id" text NOT NULL, "user_id" text NOT NULL,
        "call_session_id" varchar REFERENCES "voice_call_sessions"("id") ON DELETE CASCADE,
        "metric" text NOT NULL, "quantity" real NOT NULL, "unit" text NOT NULL,
        "provider" text, "metadata" jsonb DEFAULT '{}'::jsonb, "created_at" timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "voice_usage_tenant"
        ON "voice_usage" ("organization_id", "user_id", "created_at" DESC);

      -- 0013: Lead pipeline categorisation
      ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "lead_stage" text DEFAULT 'new_lead' NOT NULL;
      ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "lead_stage_reason" text;
      ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "lead_stage_updated_at" timestamp DEFAULT now();
      ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "lead_score" integer DEFAULT 0;
      CREATE INDEX IF NOT EXISTS "idx_contacts_lead_stage"
        ON "contacts" ("organization_id", "user_id", "lead_stage");
    `);

    log('✅ Database migrations completed — all tables ready');

    // Seed essential data if tables are empty
    await seedData(sql);

  } catch (err: any) {
    log(`❌ Migration failed: ${err.message}`);
    console.error('Migration error:', err);
    // Don't throw — let app start anyway, some tables may already exist
  } finally {
    await sql.end();
  }
}

/**
 * Seeds critical data that was in Neon DB.
 * Only inserts if the table is empty — safe to run on every startup.
 */
async function seedData(sql: postgres.Sql): Promise<void> {
  try {
    // Check if chatbot_configs already has data
    const existing = await sql`SELECT COUNT(*) as count FROM chatbot_configs`;
    const count = parseInt((existing[0] as any).count, 10);

    if (count > 0) {
      log(`ℹ️ chatbot_configs already has ${count} row(s) — skipping seed`);
      return;
    }

    log('🌱 Seeding chatbot_configs...');

    const systemPrompt = `You are AnPro AI Assistant — a Senior Technical Sales Specialist for AnPro Solutions.

TONE: Professional, helpful, and concise. Never overly enthusiastic or pushy. You can respond in Hinglish (Hindi + English mix) if the user writes in Hindi/Hinglish.

MISSION: Help pathology labs understand AnPro AI LIMS. Convert genuine interest into a scheduled Google Meet demo.

IMPORTANT — DEMO VIDEO LINK:
The user has already received the demo video link in the greeting message: https://app.supademo.com/demo/cml52cn4j3h6nzsadnq3xl323
- If the user asks about features, demo, or how AnPro works, remind them to watch the video first.
- If they have already watched the video and have specific questions, answer those questions directly.
- Do NOT resend the full greeting. Just reference the video if needed: "Kya aapne demo video dekha? Usme AnPro ke saare key features covered hain."

HARD RULES — YOU MUST FOLLOW THESE:
1. ONE reply per user message. NEVER send multiple messages.
2. Keep replies to 2-4 sentences MAX unless the user explicitly asks for detailed info.
3. Ask at most 1 question per reply. Wait for the user's answer before asking more.
4. You may invite for a demo at most 2 times in the ENTIRE conversation. If declined twice, stop asking.
5. If the user says "not interested", "later", "just browsing", or "busy" — acknowledge politely and STOP pitching. Only re-engage if THEY bring it up.
6. If the user gives short dismissals twice in a row, offer to help later and stop the flow.
7. NEVER send follow-up messages if the user doesn't reply.
8. NEVER repeat the same pitch or CTA in back-to-back replies.
9. Match the user's energy: if they ask one thing, answer ONLY that one thing.

KEY FEATURES (use when relevant):
- AI TRF Digitization: Scan handwritten TRFs, 99% accuracy, zero manual entry.
- AI Instrument Screen Reading: Camera reads analyzer screens — no cables, no HL7.
- Objective AI Analysis: Blood group & rapid card image analysis with proof.
- WhatsApp Integration: Auto-send PDF reports & invoices, included in AI Premium plan.
- Smart Verification: Delta checks, abnormal value flagging (age/gender specific).
- Pricing: Basic ₹2,499/mo | AI Premium ₹3,499/mo (recommended).

VISUALS: If the user asks about a feature with an image reference, include "image url: [URL]" on a new line at the end.
- TRF: image url: https://ik.imagekit.io/18tsendxqy/website/trf%20scan.png?tr=f-auto
- Instrument: image url: https://ik.imagekit.io/18tsendxqy/website/scan%20machine.png?tr=f-auto
- Blood Group: image url: https://ik.imagekit.io/18tsendxqy/website/blood%20group.png?tr=f-auto
- Rapid Card: image url: https://ik.imagekit.io/18tsendxqy/website/rapid%20card.png?tr=f-auto
- WhatsApp: image url: https://ik.imagekit.io/18tsendxqy/website/whatsapp.png?tr=f-auto

POLITE EXIT (use exactly once if user declines):
"Samajh gaye. Aapka time dene ke liye shukriya. Jab bhi aap AI automation explore karna chahein, bas humein message kar dijiye."`;

    const greetingMessage = `Hello 👋\nWelcome to *AnPro Solutions!*\n\n*AnPro LIMS* में interest दिखाने के लिए thank you।\n\nAnPro India का first *AI-based Laboratory Information Management System (LIMS)* है, जो specially modern diagnostic labs के लिए design किया गया है।\nयह lab operations को automate करता है, manual work कम करता है, और complete *WhatsApp integration* provide करता है — बिना किसी extra cost के।\n\nआपसे request है कि पहले नीचे दिया गया short introduction video देख लें।\nइस video में आपको AnPro का overview, key features, pricing और additional demo video links मिल जाएंगे:\n\n👉 https://app.supademo.com/demo/cml52cn4j3h6nzsadnq3xl323\n\nअगर आपको AnPro आपकी lab के लिए suitable लगे, तो इसी number पर हमें वापस contact कीजिए।\n\nआपसे बात करने का इंतज़ार रहेगा 😊\n\nRegards,\n*Team AnPro Solutions*\n===NEXT_MESSAGE===\nAUDIO_URL: https://api.limsapp.in/storage/v1/object/public/reports/reports/ElevenLabs_2026-02-22T05_04_24_Riya%20Rao%20-%20Hindi%20Customer%20Care_pvc_sp109_s50_sb17_se0_b_m2.mp3\n===NEXT_MESSAGE===\nHello 👋\n\nWelcome to *AnPro Solutions!*\n\nThank you for showing interest in *AnPro LIMS*.\n\nAnPro is India's first AI-based Laboratory Information Management System, specially designed for modern diagnostic laboratories. It helps automate lab operations, reduce manual work, and provides complete WhatsApp integration — without any additional cost.\n\nWe request you to please watch the short introduction video below first.\nIn this video, you will find an overview of AnPro, key features, pricing details, and links to additional demo videos:\n\n👉 https://app.supademo.com/demo/cml52cn4j3h6nzsadnq3xl323\n\nIf you find AnPro suitable for your lab, please feel free to contact us on this number.\n\nWe look forward to speaking with you 😊\n\nRegards,\n*Team AnPro Solutions*\n===NEXT_MESSAGE===\nAUDIO_URL: https://api.limsapp.in/storage/v1/object/public/reports/reports/ElevenLabs_2026-02-22T05_02_26_Riya%20Rao%20-%20Hindi%20Customer%20Care_pvc_sp109_s50_sb17_se0_b_m2.mp3`;

    await sql`
      INSERT INTO chatbot_configs (
        id, agent_name, trigger_keywords, rag_base_url, rag_access_key,
        system_prompt, greeting_message, context_message_count,
        reply_cooldown_seconds, typing_delay_ms, is_active,
        created_at, updated_at
      ) VALUES (
        '233e172a-fccc-4a07-9939-c283880a94b2',
        'AnPro Sales Assistant',
        ${JSON.stringify(["LIMS", "Demo", "Price"])},
        'https://tnfqq3vcirfyalnqzg3c4wwy.agents.do-ai.run',
        '71VkYUHciWpo0I8DsK4n8nUfA-Vjr70j',
        ${systemPrompt},
        ${greetingMessage},
        5, 8, 2000, 'true',
        '2025-12-29 16:49:16.63061',
        '2026-02-23 07:13:51.685068'
      )
    `;

    log('✅ chatbot_configs seeded — AnPro Sales Assistant restored');
  } catch (err: any) {
    log(`⚠️ Seed failed (non-fatal): ${err.message}`);
    console.error('Seed error:', err);
  }
}
