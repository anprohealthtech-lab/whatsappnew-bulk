ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_stage text DEFAULT 'new_lead' NOT NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_stage_reason text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_stage_updated_at timestamp DEFAULT now();
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_score integer DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_contacts_lead_stage
  ON contacts(organization_id, user_id, lead_stage);
