import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_EMBED_MODEL = "gemini-embedding-001";
const GEMINI_EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const MAX_CONTEXT_CHARS = 12_000;
const VOICE_STYLE_PROMPT =
  "Voice mode: answer like a live phone conversation. Keep the response to 1-2 short spoken sentences. " +
  "Do not use bullet points, numbered lists, long greetings, full clinic footers, or full address/phone details unless the user asks for them. " +
  "If the user's question is broad, answer briefly and ask exactly one useful follow-up question. " +
  "For urgent symptoms, give one short safety instruction.";
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
  "for", "from", "how", "i", "if", "in", "is", "it", "me", "my", "of", "on",
  "or", "our", "please", "tell", "that", "the", "this", "to", "we", "what",
  "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

interface RagChatRequest {
  organization_id: string;
  user_id: string;
  message: string;
  conversation_history?: { role: string; content: string }[];
  system_prompt?: string;
  match_count?: number;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  channel?: "whatsapp" | "voice" | "web";
}

interface KnowledgeMatch {
  id: string;
  content: string;
  file_id: string;
  chunk_index: number;
  similarity: number;
  rerank_score?: number;
}

async function embedQuery(text: string, geminiKey: string): Promise<number[]> {
  const response = await fetch(`${GEMINI_EMBED_URL}?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBED_MODEL}`,
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

function tokenizeForRanking(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));

  return [...new Set(tokens)];
}

function rankKnowledgeMatches(matches: KnowledgeMatch[], query: string, finalCount: number): KnowledgeMatch[] {
  const queryTerms = tokenizeForRanking(query);
  const ranked = matches.map((match) => {
    const content = match.content.toLowerCase();
    const keywordHits = queryTerms.reduce((count, term) => count + (content.includes(term) ? 1 : 0), 0);
    const keywordScore = queryTerms.length ? keywordHits / queryTerms.length : 0;
    const earlyChunkBoost = Math.max(0, 0.04 - Math.min(match.chunk_index || 0, 8) * 0.005);
    return {
      ...match,
      rerank_score: (Number(match.similarity) || 0) * 0.78 + keywordScore * 0.18 + earlyChunkBoost,
    };
  });

  return ranked
    .sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0))
    .slice(0, finalCount);
}

function buildKnowledgeContext(matches: KnowledgeMatch[], maxChars = MAX_CONTEXT_CHARS): string {
  const parts: string[] = [];
  let usedChars = 0;

  for (const match of matches) {
    const label = `[${parts.length + 1}]`;
    const content = `${label} ${match.content.trim()}`;
    if (usedChars + content.length > maxChars) break;
    parts.push(content);
    usedChars += content.length;
  }

  return parts.join("\n\n");
}

async function generateResponseStreaming(
  systemPrompt: string,
  context: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string,
  anthropicKey: string,
  maxTokens: number,
  temperature: number,
  onChunk: (text: string) => void
): Promise<string> {
  const contextBlock = context
    ? `\n\n--- KNOWLEDGE BASE CONTEXT (use this to answer) ---\n${context}\n--- END CONTEXT ---\n`
    : "";

  const fullSystemPrompt = systemPrompt + contextBlock;

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const msg of conversationHistory) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    messages.push({ role, content: msg.content });
  }
  messages.push({ role: "user", content: userMessage });

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      temperature,
      system: fullSystemPrompt,
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API failed (${response.status}): ${err}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data);
        if (event.type === "content_block_delta" && event.delta?.text) {
          const chunk = event.delta.text;
          fullText += chunk;
          onChunk(chunk);
        }
      } catch {
        // Skip invalid JSON
      }
    }
  }

  return fullText;
}

async function generateResponseNonStreaming(
  systemPrompt: string,
  context: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string,
  anthropicKey: string,
  maxTokens: number,
  temperature: number
): Promise<string> {
  const contextBlock = context
    ? `\n\n--- KNOWLEDGE BASE CONTEXT (use this to answer) ---\n${context}\n--- END CONTEXT ---\n`
    : "";

  const fullSystemPrompt = systemPrompt + contextBlock;

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const msg of conversationHistory) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    messages.push({ role, content: msg.content });
  }
  messages.push({ role: "user", content: userMessage });

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      temperature,
      system: fullSystemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API failed (${response.status}): ${err}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text;
  if (!content) throw new Error("Empty response from Anthropic");

  return content;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  const log = (msg: string) => console.log(`[rag-chat][${requestId}] ${msg}`);

  try {
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not configured");
    if (!geminiKey) throw new Error("GEMINI_API_KEY not configured (needed for embeddings)");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: RagChatRequest = await req.json();
    const {
      organization_id,
      user_id,
      message,
      conversation_history = [],
      system_prompt,
      match_count,
      stream = false,
      max_tokens,
      temperature,
      channel = "web",
    } = body;

    const defaultSystemPrompts: Record<string, string> = {
      voice: "You are a helpful voice assistant. Keep responses concise and conversational - under 2-3 sentences when possible. Answer based on the knowledge base context if provided. Reply in the user's latest language and keep one dominant language throughout the answer unless the user clearly mixes languages.",
      whatsapp: "You are a helpful assistant. Answer questions based on the provided knowledge base context. If the context doesn't contain relevant information, say so honestly. Reply in the user's latest language and keep one dominant language throughout the answer unless the user clearly mixes languages.",
      web: "You are a helpful assistant. Answer questions based on the provided knowledge base context. If the context doesn't contain relevant information, say so honestly. Reply in the user's latest language and keep one dominant language throughout the answer unless the user clearly mixes languages.",
    };

    const defaultMaxTokens: Record<string, number> = {
      voice: 220,
      whatsapp: 1024,
      web: 1024,
    };

    const defaultTemperatures: Record<string, number> = {
      voice: 0.7,
      whatsapp: 0.8,
      web: 0.8,
    };

    const baseSystemPrompt = system_prompt || defaultSystemPrompts[channel] || defaultSystemPrompts.web;
    const effectiveSystemPrompt = [
      baseSystemPrompt,
      channel === "voice" ? VOICE_STYLE_PROMPT : "",
    ].filter(Boolean).join("\n\n");
    const effectiveMatchCount = match_count || (channel === "voice" ? 3 : 5);
    const effectiveMaxTokens = max_tokens || defaultMaxTokens[channel] || 1024;
    const effectiveTemperature = temperature ?? defaultTemperatures[channel] ?? 0.8;

    if (!user_id || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: user_id, message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const effectiveOrgId = organization_id || "default_org";

    log(`RAG chat for user ${user_id}: "${message.substring(0, 100)}..." stream=${stream}`);

    const { data: files, error: filesError } = await supabase
      .from("knowledge_files")
      .select("id")
      .eq("organization_id", effectiveOrgId)
      .eq("user_id", user_id)
      .eq("status", "ready")
      .limit(1);

    if (filesError) {
      log(`Error checking files: ${filesError.message}`);
    }

    let context = "";
    let selectedMatches: KnowledgeMatch[] = [];

    if (files && files.length > 0) {
      log("Embedding query...");
      const queryEmbedding = await embedQuery(message, geminiKey);

      const finalMatchCount = Math.max(1, effectiveMatchCount);
      const retrievalCount = Math.max(finalMatchCount * 3, 15);

      log("Searching knowledge base...");
      const { data: matches, error: matchError } = await supabase.rpc("match_knowledge_chunks", {
        query_embedding: JSON.stringify(queryEmbedding),
        match_org_id: effectiveOrgId,
        match_user_id: user_id,
        match_count: retrievalCount,
        match_threshold: 0.3,
      });

      if (matchError) {
        log(`Vector search error: ${matchError.message}`);
      } else if (matches && matches.length > 0) {
        selectedMatches = rankKnowledgeMatches(matches as KnowledgeMatch[], message, finalMatchCount);
        log(
          `Found ${matches.length} relevant chunks; selected ${selectedMatches.length} ` +
          `(scores: ${selectedMatches.map((m) => (m.rerank_score || 0).toFixed(3)).join(", ")})`,
        );
        context = buildKnowledgeContext(selectedMatches);
      } else {
        log("No relevant chunks found above threshold");
      }
    } else {
      log("No knowledge files found for user");
    }

    if (stream) {
      log("Starting streaming response...");
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          try {
            await generateResponseStreaming(
              effectiveSystemPrompt,
              context,
              conversation_history,
              message,
              anthropicKey,
              effectiveMaxTokens,
              effectiveTemperature,
              (chunk: string) => {
                const sseData = `data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`;
                controller.enqueue(encoder.encode(sseData));
              }
            );
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
            controller.close();
          } catch (err: any) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`));
            controller.close();
          }
        },
      });

      return new Response(readable, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    log("Generating non-streaming response...");
    const response = await generateResponseNonStreaming(
      effectiveSystemPrompt,
      context,
      conversation_history,
      message,
      anthropicKey,
      effectiveMaxTokens,
      effectiveTemperature
    );

    log(`Response generated (${response.length} chars)`);

    const result = {
      choices: [{
        message: {
          role: "assistant",
          content: response,
        },
        finish_reason: "stop",
      }],
      context_chunks: selectedMatches.length,
      has_knowledge_base: files && files.length > 0,
    };

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
