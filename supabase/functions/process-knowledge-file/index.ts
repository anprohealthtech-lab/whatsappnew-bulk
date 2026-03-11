import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Gemini embedding model: text-embedding-004 → 768 dimensions
const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent";
const CHUNK_SIZE = 500; // ~500 tokens per chunk
const CHUNK_OVERLAP = 50; // overlap between chunks

interface ProcessRequest {
  file_id: string;
  organization_id: string;
  user_id: string;
  file_content: string; // base64 encoded file content
  file_name: string;
  mime_type: string;
}

function chunkText(text: string, chunkSize: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
  // Split by paragraphs first, then by sentences, then by words
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // If adding this paragraph exceeds chunk size, save current and start new
    const words = (currentChunk + " " + trimmed).split(/\s+/);
    if (words.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      // Keep overlap from end of previous chunk
      const overlapWords = currentChunk.split(/\s+/).slice(-overlap);
      currentChunk = overlapWords.join(" ") + " " + trimmed;
    } else {
      currentChunk = currentChunk ? currentChunk + "\n\n" + trimmed : trimmed;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // If we still have chunks that are too large, split them further
  const finalChunks: string[] = [];
  for (const chunk of chunks) {
    const words = chunk.split(/\s+/);
    if (words.length > chunkSize * 1.5) {
      // Split into smaller pieces
      for (let i = 0; i < words.length; i += chunkSize - overlap) {
        const piece = words.slice(i, i + chunkSize).join(" ");
        if (piece.trim()) finalChunks.push(piece.trim());
      }
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks.filter(c => c.length > 20); // Skip tiny chunks
}

function extractTextFromContent(base64Content: string, mimeType: string): string {
  const bytes = Uint8Array.from(atob(base64Content), c => c.charCodeAt(0));
  const decoder = new TextDecoder("utf-8", { fatal: false });

  if (mimeType === "text/plain" || mimeType === "text/csv" || mimeType === "text/markdown") {
    return decoder.decode(bytes);
  }

  // For other types, try to extract readable text
  // Simple approach: decode as text, strip non-printable characters
  let text = decoder.decode(bytes);
  // Remove binary/control characters but keep newlines and common chars  
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, " ");
  // Collapse multiple spaces
  text = text.replace(/\s{3,}/g, "\n\n");
  return text;
}

async function embedText(text: string, geminiKey: string): Promise<number[]> {
  const response = await fetch(`${GEMINI_EMBED_URL}?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/text-embedding-004",
      content: { parts: [{ text }] },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini embedding failed (${response.status}): ${err}`);
  }

  const data = await response.json();
  return data.embedding.values;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  const log = (msg: string) => console.log(`[process-knowledge-file][${requestId}] ${msg}`);

  try {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) throw new Error("GEMINI_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: ProcessRequest = await req.json();
    const { file_id, organization_id, user_id, file_content, file_name, mime_type } = body;

    if (!file_id || !organization_id || !user_id || !file_content) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: file_id, organization_id, user_id, file_content" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`Processing file: ${file_name} (${mime_type}) for user ${user_id}`);

    // Update status to processing
    await supabase.from("knowledge_files").update({ status: "processing" }).eq("id", file_id);

    // Extract text from file content
    const text = extractTextFromContent(file_content, mime_type || "text/plain");
    if (text.trim().length < 20) {
      await supabase.from("knowledge_files").update({
        status: "failed",
        error_message: "Could not extract meaningful text from file",
      }).eq("id", file_id);
      return new Response(
        JSON.stringify({ error: "No meaningful text extracted from file" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`Extracted ${text.length} chars of text`);

    // Chunk the text
    const chunks = chunkText(text);
    log(`Split into ${chunks.length} chunks`);

    // Embed and store each chunk
    let successCount = 0;
    const batchSize = 5; // Process 5 chunks at a time to avoid rate limits

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const embedPromises = batch.map(async (chunk, batchIdx) => {
        const chunkIdx = i + batchIdx;
        try {
          const embedding = await embedText(chunk, geminiKey);
          const wordCount = chunk.split(/\s+/).length;

          const { error } = await supabase.from("knowledge_chunks").insert({
            file_id,
            organization_id,
            user_id,
            content: chunk,
            chunk_index: chunkIdx,
            token_count: wordCount,
            embedding: JSON.stringify(embedding),
          });

          if (error) {
            log(`Failed to insert chunk ${chunkIdx}: ${error.message}`);
            return false;
          }
          return true;
        } catch (err: any) {
          log(`Failed to embed chunk ${chunkIdx}: ${err.message}`);
          return false;
        }
      });

      const results = await Promise.all(embedPromises);
      successCount += results.filter(Boolean).length;

      // Small delay between batches to respect rate limits
      if (i + batchSize < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    log(`Embedded ${successCount}/${chunks.length} chunks successfully`);

    // Update file status
    if (successCount === 0) {
      await supabase.from("knowledge_files").update({
        status: "failed",
        error_message: "Failed to embed any chunks",
        chunk_count: 0,
      }).eq("id", file_id);
    } else {
      await supabase.from("knowledge_files").update({
        status: "ready",
        chunk_count: successCount,
        error_message: successCount < chunks.length
          ? `${chunks.length - successCount} chunks failed to embed`
          : null,
      }).eq("id", file_id);
    }

    const result = {
      success: true,
      file_id,
      total_chunks: chunks.length,
      embedded_chunks: successCount,
      text_length: text.length,
    };

    log(`Done: ${JSON.stringify(result)}`);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    log(`Error: ${err.message}`);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
