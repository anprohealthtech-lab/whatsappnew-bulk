-- Baileys auth state: store WhatsApp session keys in DB instead of filesystem
-- Fixes "waiting for this message" on DigitalOcean App Platform (ephemeral filesystem)
CREATE TABLE IF NOT EXISTS "baileys_auth_keys" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" text NOT NULL,
  "category" text NOT NULL,
  "key_id" text NOT NULL,
  "data" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

-- Fast lookup by session + category + key_id (the main access pattern)
CREATE UNIQUE INDEX IF NOT EXISTS "baileys_auth_keys_session_cat_key"
  ON "baileys_auth_keys" ("session_id", "category", "key_id");

-- Fast deletion of all keys for a session (disconnect / re-pair)
CREATE INDEX IF NOT EXISTS "baileys_auth_keys_session_id"
  ON "baileys_auth_keys" ("session_id");
