CREATE TABLE "auto_responses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyword" text NOT NULL,
	"response" text NOT NULL,
	"is_active" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "blocked_numbers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number" text NOT NULL,
	"reason" text DEFAULT 'user_requested',
	"blocked_at" timestamp DEFAULT now(),
	CONSTRAINT "blocked_numbers_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
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
--> statement-breakpoint
CREATE TABLE "campaigns" (
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
--> statement-breakpoint
CREATE TABLE "chatbot_configs" (
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
--> statement-breakpoint
CREATE TABLE "contacts" (
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
--> statement-breakpoint
CREATE TABLE "hr_admins" (
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
--> statement-breakpoint
CREATE TABLE "hr_chatbot_configs" (
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
--> statement-breakpoint
CREATE TABLE "message_variations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"message" text NOT NULL,
	"original_message" text,
	"variation_number" integer,
	"fixed_params" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_variations" ADD CONSTRAINT "message_variations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;