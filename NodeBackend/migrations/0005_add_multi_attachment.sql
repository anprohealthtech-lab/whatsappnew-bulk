-- Add multi-attachment pool columns to campaigns
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS attachment_paths jsonb,
  ADD COLUMN IF NOT EXISTS attachment_file_names jsonb;
