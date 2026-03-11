-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Knowledge files uploaded by users
CREATE TABLE IF NOT EXISTS knowledge_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing', -- 'processing' | 'ready' | 'failed'
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Knowledge chunks with vector embeddings (768 dimensions for Gemini text-embedding-004)
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  token_count INTEGER DEFAULT 0,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast vector similarity search scoped to user
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_user ON knowledge_chunks(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_knowledge_files_user ON knowledge_files(organization_id, user_id);

-- RPC function for similarity search scoped to user
CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding vector(768),
  match_org_id TEXT,
  match_user_id TEXT,
  match_count INT DEFAULT 5,
  match_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  file_id UUID,
  chunk_index INTEGER,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.file_id,
    kc.chunk_index,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks kc
  WHERE kc.organization_id = match_org_id
    AND kc.user_id = match_user_id
    AND kc.embedding IS NOT NULL
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- RLS policies
ALTER TABLE knowledge_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service role full access on knowledge_files"
  ON knowledge_files FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access on knowledge_chunks"
  ON knowledge_chunks FOR ALL
  USING (true)
  WITH CHECK (true);
