-- Session connection history table for auditing connect / disconnect events
CREATE TABLE IF NOT EXISTS session_connection_history (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_name TEXT NOT NULL,
  event TEXT NOT NULL,        -- 'connected' | 'disconnected' | 'qr_pending' | 'auth_failure' | 'reconnecting'
  reason TEXT,                -- human-readable disconnect reason
  status_code INTEGER,        -- Baileys DisconnectReason numeric code
  phone_number TEXT,          -- linked WhatsApp number if known
  session_duration_seconds INTEGER, -- how long the session was up before this event
  metadata JSONB,             -- extra context (waVersion, browser identity, etc.)
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for quick per-user lookups
CREATE INDEX IF NOT EXISTS idx_session_history_user_id ON session_connection_history(user_id);

-- Index for per-session lookups
CREATE INDEX IF NOT EXISTS idx_session_history_user_session ON session_connection_history(user_id, session_name);

-- Index for filtering by event type
CREATE INDEX IF NOT EXISTS idx_session_history_event ON session_connection_history(event);
