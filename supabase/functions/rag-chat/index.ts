import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent";
const GEMINI_CHAT_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

interface RagChatRequest {
  organization_id: string;
  user_id: string;
  message: string;
  conversation_history?: { role: string; content: string }[];
  system_prompt?: string;
  match_count?: number;
}

async function embedQuery(text: string, geminiKey: string): Promise<number[]> {
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

async function generateResponse(
  systemPrompt: string,
  context: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string,
  geminiKey: string
): Promise<string> {
  // Build the full prompt with context
  const contextBlock = context
    ? `\n\n--- KNOWLEDGE BASE CONTEXT (use this to answer) ---\n${context}\n--- END CONTEXT ---\n`
    : "";

  const fullSystemPrompt = systemPrompt + contextBlock;

  // Convert conversation history to Gemini format
  const contents: any[] = [];

  // Add system instruction as first user turn with model acknowledgment
  contents.push({ role: "user", parts: [{ text: `System Instructions: ${fullSystemPrompt}\n\nPlease follow these instructions for all responses.` }] });
  contents.push({ role: "model", parts: [{ text: "Understood. I will follow these instructions." }] });

  // Add conversation history
  for (const msg of conversationHistory) {
    const role = msg.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: msg.content }] });
  }

  // Add current user message
  contents.push({ role: "user", parts: [{ text: userMessage }] });

  const response = await fetch(`${GEMINI_CHAT_URL}?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
        topP: 0.9,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini chat failed (${response.status}): ${err}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    throw new Error("Empty response from Gemini");
  }

  return candidate.content.parts[0].text;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  const log = (msg: string) => console.log(`[rag-chat][${requestId}] ${msg}`);

  try {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) throw new Error("GEMINI_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: RagChatRequest = await req.json();
    const {
      organization_id,
      user_id,
      message,
      conversation_history = [],
      system_prompt = "You are a helpful assistant. Answer questions based on the provided knowledge base context. If the context doesn't contain relevant information, say so honestly.",
      match_count = 5,
    } = body;

    if (!organization_id || !user_id || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: organization_id, user_id, message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`RAG chat for user ${user_id}: "${message.substring(0, 100)}..."`);

    // Step 1: Check if user has any knowledge files
    const { data: files, error: filesError } = await supabase
      .from("knowledge_files")
      .select("id")
      .eq("organization_id", organization_id)
      .eq("user_id", user_id)
      .eq("status", "ready")
      .limit(1);

    if (filesError) {
      log(`Error checking files: ${filesError.message}`);
    }

    let context = "";

    if (files && files.length > 0) {
      // Step 2: Embed the user's question
      log("Embedding query...");
      const queryEmbedding = await embedQuery(message, geminiKey);

      // Step 3: Vector similarity search scoped to user
      log("Searching knowledge base...");
      const { data: matches, error: matchError } = await supabase.rpc("match_knowledge_chunks", {
        query_embedding: JSON.stringify(queryEmbedding),
        match_org_id: organization_id,
        match_user_id: user_id,
        match_count: match_count,
        match_threshold: 0.3,
      });

      if (matchError) {
        log(`Vector search error: ${matchError.message}`);
      } else if (matches && matches.length > 0) {
        log(`Found ${matches.length} relevant chunks (similarity: ${matches.map((m: any) => m.similarity.toFixed(3)).join(", ")})`);
        context = matches.map((m: any, i: number) => `[${i + 1}] ${m.content}`).join("\n\n");
      } else {
        log("No relevant chunks found above threshold");
      }
    } else {
      log("No knowledge files found for user — responding without context");
    }

    // Step 4: Generate response with context
    log("Generating response...");
    const response = await generateResponse(
      system_prompt,
      context,
      conversation_history,
      message,
      geminiKey
    );

    log(`Response generated (${response.length} chars)`);

    // Return OpenAI-compatible format for easy integration
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
