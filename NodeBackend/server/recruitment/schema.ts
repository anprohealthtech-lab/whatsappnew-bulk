export const recruitmentSchemaSql = `
CREATE TABLE IF NOT EXISTS recruitment_candidates (
 id text PRIMARY KEY, organization_id text NOT NULL, user_id text NOT NULL,
 session_name text NOT NULL, phone text NOT NULL, name text NOT NULL,
 position text NOT NULL DEFAULT 'Accounts Executive', source_lead_id text NOT NULL,
 consent_note text, status text NOT NULL DEFAULT 'awaiting_reply',
 answers jsonb NOT NULL DEFAULT '{}', awaiting_field text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,user_id,session_name,phone)
);
CREATE TABLE IF NOT EXISTS recruitment_cv_files (
 id text PRIMARY KEY, candidate_id text NOT NULL REFERENCES recruitment_candidates(id),
 source_message_id text NOT NULL, file_name text NOT NULL, mime_type text NOT NULL,
 data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(candidate_id,source_message_id)
);
CREATE TABLE IF NOT EXISTS recruitment_events (
 id text PRIMARY KEY, candidate_id text NOT NULL REFERENCES recruitment_candidates(id),
 source_message_id text NOT NULL, reply text, send_status text NOT NULL DEFAULT 'prepared',
 message_id text, error_reason text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(candidate_id,source_message_id)
);
CREATE INDEX IF NOT EXISTS recruitment_owner ON recruitment_candidates(organization_id,user_id);
`;
