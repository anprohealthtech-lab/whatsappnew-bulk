-- HIMS (Hospital Information Management System) patient registration
-- Links WhatsApp phone numbers to HIMS organizations for appointment chatbot
CREATE TABLE IF NOT EXISTS hims_patients (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL UNIQUE,
  name TEXT,
  organization_id TEXT NOT NULL,           -- HIMS org ID, used for all DO→Edge calls
  system_prompt TEXT,                       -- Optional per-org system prompt override
  trigger_keywords JSONB,                   -- Keywords that activate HIMS chatbot
  greeting_message TEXT,                    -- Greeting sent on first trigger
  chatbot_active TEXT NOT NULL DEFAULT 'true',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hims_patients_phone ON hims_patients(phone_number);
CREATE INDEX IF NOT EXISTS idx_hims_patients_org ON hims_patients(organization_id);
