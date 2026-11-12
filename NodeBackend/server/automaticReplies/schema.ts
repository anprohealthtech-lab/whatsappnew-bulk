export const automaticReplySchemaSql = `
CREATE TABLE IF NOT EXISTS automatic_reply_conversations (
  organization_id text NOT NULL,
  user_id text NOT NULL,
  session_name text NOT NULL,
  recipient text NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, session_name, recipient)
);
`;
