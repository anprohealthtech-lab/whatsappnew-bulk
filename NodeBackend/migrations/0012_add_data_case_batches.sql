CREATE TABLE IF NOT EXISTS "data_case_batches" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text DEFAULT 'default_org' NOT NULL,
  "user_id" text DEFAULT 'default_user' NOT NULL,
  "patient_id" varchar NOT NULL,
  "patient_name_hint" text NOT NULL,
  "source_phone_number" text,
  "status" text DEFAULT 'collecting' NOT NULL,
  "expected_attachment_count" integer,
  "received_attachment_count" integer DEFAULT 0 NOT NULL,
  "event_date" text,
  "summary" text,
  "error_message" text,
  "started_at" timestamp DEFAULT now(),
  "collection_completed_at" timestamp,
  "processing_started_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'data_case_batches_patient_id_fk'
  ) THEN
    ALTER TABLE "data_case_batches"
      ADD CONSTRAINT "data_case_batches_patient_id_fk"
      FOREIGN KEY ("patient_id") REFERENCES "data_patients"("id") ON DELETE cascade;
  END IF;
END $$;

ALTER TABLE "data_documents"
  ADD COLUMN IF NOT EXISTS "case_batch_id" varchar,
  ADD COLUMN IF NOT EXISTS "sequence_number" integer,
  ADD COLUMN IF NOT EXISTS "caption" text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'data_documents_case_batch_id_fk'
  ) THEN
    ALTER TABLE "data_documents"
      ADD CONSTRAINT "data_documents_case_batch_id_fk"
      FOREIGN KEY ("case_batch_id") REFERENCES "data_case_batches"("id") ON DELETE set null;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_data_case_batches_active"
  ON "data_case_batches" ("organization_id", "user_id", "status", "created_at");

CREATE INDEX IF NOT EXISTS "idx_data_documents_case_batch"
  ON "data_documents" ("case_batch_id", "sequence_number");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_data_documents_source_message"
  ON "data_documents" ("organization_id", "user_id", "source_message_id")
  WHERE "source_message_id" IS NOT NULL;
