import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

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

async function embedQuery(text: string, geminiKey: string): Promise<number[]> {
  const response = await fetch(`${GEMINI_EMBED_URL}?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
      match_count = 5,
      stream = false,
      max_tokens,
      temperature,
      channel = "web",
    } = body;

    const defaultSystemPrompts: Record<string, string> = {
      voice: "You are a helpful voice assistant. Keep responses concise and conversational - under 2-3 sentences when possible. Answer based on the knowledge base context if provided.",
      whatsapp: "You are a helpful assistant. Answer questions based on the provided knowledge base context. If the context doesn't contain relevant information, say so honestly.",
      web: "You are a helpful assistant. Answer questions based on the provided knowledge base context. If the context doesn't contain relevant information, say so honestly.",
    };

    const defaultMaxTokens: Record<string, number> = {
      voice: 512,
      whatsapp: 1024,
      web: 1024,
    };

    const defaultTemperatures: Record<string, number> = {
      voice: 0.7,
      whatsapp: 0.8,
      web: 0.8,
    };

    const effectiveSystemPrompt = system_prompt || defaultSystemPrompts[channel] || defaultSystemPrompts.web;
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

    if (files && files.length > 0) {
      log("Embedding query...");
      const queryEmbedding = await embedQuery(message, geminiKey);

      log("Searching knowledge base...");
      const { data: matches, error: matchError } = await supabase.rpc("match_knowledge_chunks", {
        query_embedding: JSON.stringify(queryEmbedding),
        match_org_id: effectiveOrgId,
        match_user_id: user_id,
        match_count: match_count,
        match_threshold: 0.3,
      });

      if (matchError) {
        log(`Vector search error: ${matchError.message}`);
      } else if (matches && matches.length > 0) {
        log(`Found ${matches.length} relevant chunks`);
        context = matches.map((m: any, i: number) => `[${i + 1}] ${m.content}`).join("\n\n");
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
      context_chunks: context ? context.split("\n\n").length : 0,
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
