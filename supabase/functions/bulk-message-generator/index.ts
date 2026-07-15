// supabase/functions/bulk-message-generator/index.ts
// Generates message variations in batch: one Gemini call produces `count` variations.
// Backward compatible: single-variation callers get `tweaked_message` as before.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MAX_VARIATIONS_FOR_PROMPT = 20;
const MAX_BATCH_COUNT = 20;

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: CORS_HEADERS
    });
  }

  const requestId = crypto.randomUUID();
  console.log(`[${requestId}] === NEW REQUEST ===`);

  try {
    // 1) Parse input
    const body = await req.json().catch(() => ({}));

    const originalMessage = body.message ?? "";
    const campaignId = body.campaign_id ?? "";
    const fixedParamsRaw = body.fixed_params ?? null;
    const contactPhone = body.contact_phone ?? ""; // Optional: for tracking which contact
    const count = Math.min(Math.max(Number(body.count) || 1, 1), MAX_BATCH_COUNT);

    if (!originalMessage || !campaignId) {
      console.error(`[${requestId}] Missing required fields - message: ${!!originalMessage}, campaign_id: ${!!campaignId}`);
      return new Response(JSON.stringify({
        success: false,
        error: "Missing required fields: message, campaign_id"
      }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    console.log(`[${requestId}] Campaign ID: ${campaignId}`);
    console.log(`[${requestId}] Original message length: ${originalMessage.length} chars`);
    console.log(`[${requestId}] Requested count: ${count}`);

    // Parse fixed_params
    let fixedParams = {};
    if (fixedParamsRaw) {
      if (typeof fixedParamsRaw === "string") {
        try {
          fixedParams = JSON.parse(fixedParamsRaw);
        } catch (e) {
          console.warn(`[${requestId}] Failed to parse fixed_params string:`, e instanceof Error ? e.message : String(e));
          fixedParams = {};
        }
      } else if (typeof fixedParamsRaw === "object") {
        fixedParams = fixedParamsRaw;
      }
    }

    // 2) Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      console.error(`[${requestId}] Missing Supabase environment variables`);
      return new Response(JSON.stringify({
        success: false,
        error: "Supabase environment not configured"
      }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

    // 3) Fetch previous variations
    const { data: rows, error: fetchError } = await supabase
      .from("message_variations")
      .select("message, created_at, variation_number")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: true });

    if (fetchError) {
      console.error(`[${requestId}] Error fetching variations:`, fetchError);
    }

    let previousVariations: string[] = [];
    if (Array.isArray(rows)) {
      previousVariations = rows
        .map((r) => r.message || "")
        .filter((m) => m && m.trim() !== "");
    }

    const totalVariations = previousVariations.length;
    const firstVariationNumber = totalVariations + 1;
    console.log(`[${requestId}] Found ${totalVariations} previous variations`);

    if (previousVariations.length > MAX_VARIATIONS_FOR_PROMPT) {
      previousVariations = previousVariations.slice(-MAX_VARIATIONS_FOR_PROMPT);
    }

    const variationsText = previousVariations.length
      ? previousVariations.map((v, idx) => `VARIATION ${idx + 1}: ${v}`).join("\n\n")
      : "(None - these are the very first variations for this campaign)";

    let fixedParamsText = "";
    if (fixedParams && Object.keys(fixedParams).length > 0) {
      fixedParamsText = Object.entries(fixedParams)
        .map(([key, value]) => `  • ${key}: ${String(value)}`)
        .join("\n");
    }

    // 4) Build the prompt
    const prompt = `You are an expert copywriter creating UNIQUE message variations to avoid spam detection on WhatsApp.

ORIGINAL MESSAGE:
"${originalMessage}"

${fixedParamsText ? `MANDATORY FIXED DETAILS (MUST appear EXACTLY as shown in every variation):
${fixedParamsText}

` : ""}PREVIOUSLY GENERATED VARIATIONS (Every new variation MUST be COMPLETELY DIFFERENT from these):
${variationsText}

YOUR TASK:
Generate ${count} BRAND NEW variation${count > 1 ? "s" : ""} where each one:

1. ✅ MUST be COMPLETELY DIFFERENT from the original, from ALL ${previousVariations.length} previous variations above${count > 1 ? ", AND from every other variation you generate now" : ""}
2. ✅ Uses DIFFERENT sentence structures, word choices, and phrasing
3. ✅ Starts with a DIFFERENT opening line
4. ✅ Rearranges the order of information
5. ✅ ${fixedParamsText ? "Keeps the fixed details (date, time, link, numbers) EXACTLY as provided" : "Maintains all key information"}
6. ✅ Keeps any {{placeholder}} tokens (like {{name}}) EXACTLY as written
7. ✅ Sounds natural and conversational
8. ✅ Has approximately the same length as the original

CRITICAL: If any two messages read similar, you have FAILED. Be creative and unique!

Return ONLY a JSON array of ${count} strings - each string is one complete message variation. No explanations, no preamble.`;

    console.log(`[${requestId}] Prompt built - length: ${prompt.length} chars`);
    console.log(`[${requestId}] Generating ${count} variation(s) starting at #${firstVariationNumber}...`);

    // 5) Call Gemini 2.5 Flash
    const googleKey = Deno.env.get("ALLGOOGLE_KEY");
    if (!googleKey) {
      console.error(`[${requestId}] Missing ALLGOOGLE_KEY`);
      return new Response(JSON.stringify({
        success: false,
        error: "Gemini API not configured"
      }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`;

    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.9, // Higher temperature for more variation
          maxOutputTokens: 8192,
          topP: 0.95,
          topK: 40,
          // Gemini 2.5 Flash thinks by default and thinking tokens count
          // against maxOutputTokens - disable so output is never starved
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: { type: "STRING" }
          }
        }
      })
    });

    console.log(`[${requestId}] Gemini response status: ${geminiRes.status}`);

    if (!geminiRes.ok) {
      const text = await geminiRes.text();
      console.error(`[${requestId}] Gemini error response:`, text);
      return new Response(JSON.stringify({
        success: false,
        error: "Gemini request failed",
        details: text
      }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const geminiJson = await geminiRes.json();
    const finishReason = geminiJson.candidates?.[0]?.finishReason;
    console.log(`[${requestId}] Gemini finishReason: ${finishReason}`);

    // Extract the JSON array of variations from the response
    let variations: string[] = [];
    try {
      const parts = geminiJson.candidates?.[0]?.content?.parts ?? [];
      const rawText = parts
        .map((p: any) => p.text)
        .filter((t: any) => typeof t === "string" && t.trim() !== "")
        .join("")
        .trim();

      console.log(`[${requestId}] Raw response length: ${rawText.length} chars`);

      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed)) {
        variations = parsed
          .filter((v: any) => typeof v === "string" && v.trim() !== "")
          .map((v: string) => v.trim());
      }
    } catch (e) {
      console.error(`[${requestId}] Error parsing Gemini response:`, e instanceof Error ? e.message : String(e));
      variations = [];
    }

    console.log(`[${requestId}] Parsed ${variations.length}/${count} variations`);

    if (variations.length === 0) {
      console.error(`[${requestId}] WARNING: No variations after parsing! finishReason: ${finishReason}`);
      return new Response(JSON.stringify({
        success: false,
        error: "Generated message is empty",
        finish_reason: finishReason ?? null
      }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    // 6) Save new variations into DB
    const insertPayload = variations.map((message, idx) => ({
      campaign_id: campaignId,
      message,
      original_message: originalMessage,
      variation_number: firstVariationNumber + idx,
      fixed_params: Object.keys(fixedParams).length ? fixedParams : null
    }));

    const { error: insertError } = await supabase
      .from("message_variations")
      .insert(insertPayload);

    if (insertError) {
      console.error(`[${requestId}] DB insert error:`, insertError);
      return new Response(JSON.stringify({
        success: false,
        tweaked_message: variations[0],
        variations,
        variation_number: firstVariationNumber,
        campaign_id: campaignId,
        original_message: originalMessage,
        db_error: insertError.message
      }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    console.log(`[${requestId}] ✅ SUCCESS - ${variations.length} variation(s) created starting at #${firstVariationNumber}`);

    // 7) Return success (tweaked_message kept for single-variation callers)
    return new Response(JSON.stringify({
      success: true,
      tweaked_message: variations[0],
      variations,
      variation_number: firstVariationNumber,
      campaign_id: campaignId,
      original_message: originalMessage,
      contact_phone: contactPhone
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${requestId}] ❌ UNHANDLED ERROR:`, message);
    if (err instanceof Error) {
      console.error(`[${requestId}] Stack:`, err.stack);
    }
    return new Response(JSON.stringify({
      success: false,
      error: "Internal server error",
      details: message
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
});
