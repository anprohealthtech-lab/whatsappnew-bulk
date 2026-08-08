-- 0014: Hierarchical clinical index on parsed attachments.
--
-- The AI reader already understands each photo/PDF. This stores that
-- understanding as a queryable 2-3 level index instead of leaving it buried in
-- extracted_json, so "give me every post knee replacement X-ray" is one indexed
-- query rather than a full scan over jsonb.
--
--   index_level1  broad region / domain      e.g. knee
--   index_level2  condition or procedure     e.g. knee_replacement
--   index_level3  stage or qualifier         e.g. post_operative
--   index_path    "knee/knee_replacement/post_operative" for prefix drill-down
--   index_modality  xray | ct | mri | ultrasound | ecg | clinical_photo | lab_report | ...
--   index_labels    flat synonym slugs so "tkr" also finds total knee replacement
--   index_source    "ai" or "manual" - manual entries survive re-parsing

ALTER TABLE "data_documents"
  ADD COLUMN IF NOT EXISTS "index_level1" text,
  ADD COLUMN IF NOT EXISTS "index_level2" text,
  ADD COLUMN IF NOT EXISTS "index_level3" text,
  ADD COLUMN IF NOT EXISTS "index_path" text,
  ADD COLUMN IF NOT EXISTS "index_modality" text,
  ADD COLUMN IF NOT EXISTS "index_labels" jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "index_confidence" real,
  ADD COLUMN IF NOT EXISTS "index_source" text;

CREATE INDEX IF NOT EXISTS "idx_data_documents_index_levels"
  ON "data_documents" ("organization_id", "user_id", "index_level1", "index_level2", "index_level3", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_data_documents_index_path"
  ON "data_documents" ("organization_id", "user_id", "index_path" text_pattern_ops);

CREATE INDEX IF NOT EXISTS "idx_data_documents_index_modality"
  ON "data_documents" ("organization_id", "user_id", "index_modality", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_data_documents_index_labels"
  ON "data_documents" USING gin ("index_labels");
