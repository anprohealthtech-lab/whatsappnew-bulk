import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import LlamaCloud from "https://esm.sh/@llamaindex/llama-cloud";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Gemini embedding model: gemini-embedding-001
const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
const CHUNK_SIZE = 500; // ~500 tokens per chunk
const CHUNK_OVERLAP = 50; // overlap between chunks

interface ProcessRequest {
  file_id: string;
  organization_id: string;
  user_id: string;
  storage_path: string; // path in Supabase Storage bucket
  file_name: string;
  mime_type: string;
}

function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP,
): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    const words = (currentChunk + " " + trimmed).split(/\s+/);
    if (words.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      const overlapWords = currentChunk.split(/\s+/).slice(-overlap);
      currentChunk = overlapWords.join(" ") + " " + trimmed;
    } else {
      currentChunk = currentChunk ? currentChunk + "\n\n" + trimmed : trimmed;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  const finalChunks: string[] = [];
  for (const chunk of chunks) {
    const words = chunk.split(/\s+/);
    if (words.length > chunkSize * 1.5) {
      for (let i = 0; i < words.length; i += chunkSize - overlap) {
        const piece = words.slice(i, i + chunkSize).join(" ");
        if (piece.trim()) finalChunks.push(piece.trim());
      }
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks.filter((c) => c.length > 20);
}

function extractTextFromBytes(bytes: Uint8Array, mimeType: string): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });

  if (
    mimeType === "text/plain" ||
    mimeType === "text/csv" ||
    mimeType === "text/markdown" ||
    mimeType === "text/html"
  ) {
    return decoder.decode(bytes);
  }

  let text = decoder.decode(bytes);
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, " ");
  text = text.replace(/\s{3,}/g, "\n\n");
  return text;
}

function shouldUseLlamaParse(mimeType: string, fileName: string): boolean {
  if (
    mimeType === "text/plain" ||
    mimeType === "text/csv" ||
    mimeType === "text/markdown" ||
    mimeType === "text/html"
  ) {
    return false;
  }

  return /\.(pdf|docx|pptx|xlsx|xls|doc)$/i.test(fileName) ||
    [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/msword",
      "application/vnd.ms-excel",
    ].includes(mimeType);
}

async function extractViaLlamaParse(
  fileData: Blob,
  fileName: string,
  mimeType: string,
  llamaApiKey: string,
): Promise<string> {
  const client = new LlamaCloud({
    apiKey: llamaApiKey,
  });

  const file = new File([fileData], fileName || "document", {
    type: mimeType || "application/octet-stream",
  });

  const uploadedFile = await client.files.create({
    file,
    purpose: "parse",
  });

  const result = await client.parsing.parse({
    file_id: uploadedFile.id,
    tier: Deno.env.get("LLAMA_PARSE_TIER") || "agentic",
    version: Deno.env.get("LLAMA_PARSE_VERSION") || "latest",
    output_options: {
      markdown: {
        tables: {
          output_tables_as_markdown: false,
        },
      },
    },
    expand: ["markdown_full", "text_full"],
  });

  const extracted = (result.text_full || result.markdown_full || "").trim();
  if (!extracted) {
    throw new Error("LlamaParse returned no extracted text");
  }

  return extracted;
}

async function embedText(text: string, geminiKey: string): Promise<number[]> {
  const response = await fetch(`${GEMINI_EMBED_URL}?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] },
      outputDimensionality: 768,
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

    const llamaApiKey = Deno.env.get("LLAMA_CLOUD_API_KEY");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: ProcessRequest = await req.json();
    const { file_id, organization_id, user_id, storage_path, file_name, mime_type } = body;

    if (!file_id || !organization_id || !user_id || !storage_path) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: file_id, organization_id, user_id, storage_path",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    log(`Processing file: ${file_name} (${mime_type}) for user ${user_id}`);
    log(`Reading from storage: ${storage_path}`);

    await supabase.from("knowledge_files").update({ status: "processing" }).eq("id", file_id);

    const { data: fileData, error: downloadError } = await supabase.storage
      .from("knowledge-files")
      .download(storage_path);

    if (downloadError || !fileData) {
      const errMsg = downloadError?.message || "Failed to download file from storage";
      log(`Download error: ${errMsg}`);
      await supabase.from("knowledge_files").update({
        status: "failed",
        error_message: errMsg,
      }).eq("id", file_id);
      return new Response(
        JSON.stringify({ error: errMsg }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const bytes = new Uint8Array(await fileData.arrayBuffer());

    let text = "";
    if (shouldUseLlamaParse(mime_type || "", file_name || "")) {
      if (!llamaApiKey) {
        throw new Error("LLAMA_CLOUD_API_KEY not configured for document parsing");
      }
      log("Using LlamaParse for rich document extraction");
      text = await extractViaLlamaParse(fileData, file_name, mime_type, llamaApiKey);
    } else {
      log("Using local text extraction");
      text = extractTextFromBytes(bytes, mime_type || "text/plain");
    }

    if (text.trim().length < 20) {
      await supabase.from("knowledge_files").update({
        status: "failed",
        error_message: "Could not extract meaningful text from file",
      }).eq("id", file_id);
      return new Response(
        JSON.stringify({ error: "No meaningful text extracted from file" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    log(`Extracted ${text.length} chars of text`);

    const chunks = chunkText(text);
    log(`Split into ${chunks.length} chunks`);

    let successCount = 0;
    const batchSize = 5;

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

      if (i + batchSize < chunks.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    log(`Embedded ${successCount}/${chunks.length} chunks successfully`);

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
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
