-- Add system prompt, greeting, and rate control columns to chatbot_configs
ALTER TABLE "chatbot_configs" ADD COLUMN IF NOT EXISTS "system_prompt" text;
ALTER TABLE "chatbot_configs" ADD COLUMN IF NOT EXISTS "greeting_message" text;
ALTER TABLE "chatbot_configs" ADD COLUMN IF NOT EXISTS "reply_cooldown_seconds" integer DEFAULT 8;
ALTER TABLE "chatbot_configs" ADD COLUMN IF NOT EXISTS "typing_delay_ms" integer DEFAULT 2000;

-- Update default context message count from 3 to 5
ALTER TABLE "chatbot_configs" ALTER COLUMN "context_message_count" SET DEFAULT 5;
