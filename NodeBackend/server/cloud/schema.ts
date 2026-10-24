// Additive schema: never alters the Baileys campaign or message tables.
export const cloudSchemaSql = `
CREATE TABLE IF NOT EXISTS cloud_campaigns (
  id text PRIMARY KEY, organization_id text NOT NULL, user_id text NOT NULL,
  name text NOT NULL, session_id text NOT NULL, phone_number_id text NOT NULL, waba_id text NOT NULL,
  template_name text NOT NULL, language text NOT NULL, template_snapshot jsonb NOT NULL,
  header_params jsonb NOT NULL DEFAULT '[]', button_params jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'draft', scheduled_at timestamptz, next_send_at timestamptz,
  interval_seconds integer NOT NULL DEFAULT 25 CHECK (interval_seconds >= 5),
  daily_limit integer NOT NULL DEFAULT 100 CHECK (daily_limit BETWEEN 1 AND 250),
  error_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_campaigns_owner ON cloud_campaigns (organization_id, user_id, created_at);
CREATE TABLE IF NOT EXISTS cloud_campaign_recipients (
  id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES cloud_campaigns(id),
  name text NOT NULL, phone text NOT NULL, body_params jsonb NOT NULL DEFAULT '[]',
  consent_note text NOT NULL, status text NOT NULL DEFAULT 'pending', latest_attempt_id text,
  error_reason text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, phone)
);
CREATE INDEX IF NOT EXISTS cloud_recipients_pending ON cloud_campaign_recipients(campaign_id, status);
CREATE TABLE IF NOT EXISTS cloud_message_attempts (
  id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES cloud_campaigns(id),
  recipient_id text NOT NULL REFERENCES cloud_campaign_recipients(id),
  organization_id text NOT NULL, user_id text NOT NULL, phone_number_id text NOT NULL,
  phone text NOT NULL, message_id text, status text NOT NULL DEFAULT 'dispatching',
  request_snapshot jsonb NOT NULL, accepted_at timestamptz, sent_at timestamptz,
  delivered_at timestamptz, read_at timestamptz, failed_at timestamptz,
  error_reason text, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(phone_number_id, message_id)
);
CREATE INDEX IF NOT EXISTS cloud_attempts_recipient ON cloud_message_attempts(recipient_id, created_at);
CREATE TABLE IF NOT EXISTS cloud_message_status_events (
  id text PRIMARY KEY, event_key text NOT NULL UNIQUE,
  organization_id text NOT NULL, user_id text NOT NULL, phone_number_id text NOT NULL, waba_id text NOT NULL,
  message_id text NOT NULL, recipient_phone text NOT NULL, status text NOT NULL,
  occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  attempt_id text, payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cloud_events_message ON cloud_message_status_events(organization_id, user_id, phone_number_id, message_id);
CREATE INDEX IF NOT EXISTS cloud_events_suppression ON cloud_message_status_events(organization_id, user_id, recipient_phone, status);
`;
