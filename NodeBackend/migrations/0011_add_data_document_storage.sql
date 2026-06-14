ALTER TABLE "data_documents"
  ADD COLUMN IF NOT EXISTS "file_url" text,
  ADD COLUMN IF NOT EXISTS "storage_bucket" text,
  ADD COLUMN IF NOT EXISTS "storage_path" text;
