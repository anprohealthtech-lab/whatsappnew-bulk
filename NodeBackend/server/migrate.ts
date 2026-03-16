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
      CREATE INDEX IF NOT EXISTS idx_auto_responses_tenant ON auto_responses(organization_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_blocked_numbers_tenant ON blocked_numbers(organization_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_user ON whatsapp_sessions(user_id, session_name);

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
