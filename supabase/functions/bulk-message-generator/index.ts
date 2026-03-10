// supabase/functions/bulk-message-generator/index.ts
// Updated with comprehensive logging and on-demand variation generation

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MAX_VARIATIONS_FOR_PROMPT = 20;

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
    console.log(`[${requestId}] Request body:`, JSON.stringify(body, null, 2));

    const originalMessage = body.message ?? "";
    const campaignId = body.campaign_id ?? "";
    const fixedParamsRaw = body.fixed_params ?? null;
    const contactPhone = body.contact_phone ?? ""; // Optional: for tracking which contact

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
    console.log(`[${requestId}] Contact phone: ${contactPhone || 'not provided'}`);

    // Parse fixed_params
    let fixedParams = {};
    if (fixedParamsRaw) {
      if (typeof fixedParamsRaw === "string") {
        try {
          fixedParams = JSON.parse(fixedParamsRaw);
          console.log(`[${requestId}] Parsed fixed_params from string:`, fixedParams);
        } catch (e) {
          console.warn(`[${requestId}] Failed to parse fixed_params string:`, e.message);
          fixedParams = {};
        }
      } else if (typeof fixedParamsRaw === "object") {
        fixedParams = fixedParamsRaw;
        console.log(`[${requestId}] Fixed params from object:`, fixedParams);
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

    console.log(`[${requestId}] Supabase URL: ${supabaseUrl}`);
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

    // 3) Fetch previous variations
    console.log(`[${requestId}] Fetching previous variations for campaign...`);
    const { data: rows, error: fetchError } = await supabase
      .from("message_variations")
      .select("message, created_at, variation_number")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: true });

    if (fetchError) {
      console.error(`[${requestId}] Error fetching variations:`, fetchError);
    } else {
      console.log(`[${requestId}] Found ${rows?.length || 0} previous variations`);
    }

    let previousVariations = [];
    if (Array.isArray(rows)) {
      previousVariations = rows
        .map((r) => r.message || "")
        .filter((m) => m && m.trim() !== "");
      console.log(`[${requestId}] Valid variations: ${previousVariations.length}`);
    }

    const totalVariations = previousVariations.length;
    const variationCount = totalVariations + 1;

    if (previousVariations.length > MAX_VARIATIONS_FOR_PROMPT) {
      previousVariations = previousVariations.slice(-MAX_VARIATIONS_FOR_PROMPT);
      console.log(`[${requestId}] Truncated to last ${MAX_VARIATIONS_FOR_PROMPT} variations for prompt`);
    }

    const variationsText = previousVariations.length
      ? previousVariations.map((v, idx) => `VARIATION ${idx + 1}: ${v}`).join("\n\n")
      : "(None - this is the very first variation for this campaign)";

    let fixedParamsText = "";
    if (fixedParams && Object.keys(fixedParams).length > 0) {
      fixedParamsText = Object.entries(fixedParams)
        .map(([key, value]) => `  • ${key}: ${String(value)}`)
        .join("\n");
      console.log(`[${requestId}] Fixed params formatted for prompt`);
    }

    // 4) Build the prompt
    const prompt = `You are an expert copywriter creating UNIQUE message variations to avoid spam detection on WhatsApp.

ORIGINAL MESSAGE:
"${originalMessage}"

${fixedParamsText ? `MANDATORY FIXED DETAILS (MUST appear EXACTLY as shown):
${fixedParamsText}

` : ""}PREVIOUSLY GENERATED VARIATIONS (You MUST create something COMPLETELY DIFFERENT):
${variationsText}

YOUR TASK:
Generate a BRAND NEW variation #${variationCount} that:

1. ✅ MUST be COMPLETELY DIFFERENT from the original and ALL ${previousVariations.length} previous variations above
2. ✅ Use DIFFERENT sentence structures, word choices, and phrasing
3. ✅ Start with a DIFFERENT opening line
4. ✅ Rearrange the order of information
5. ✅ ${fixedParamsText ? "Keep the fixed details (date, time, link, numbers) EXACTLY as provided" : "Maintain all key information"}
6. ✅ Sound natural and conversational
7. ✅ Same approximate length as original

CRITICAL: If you generate anything similar to the previous variations, you have FAILED. Be creative and unique!

Generate ONLY the message text. No explanations, no quotes, no preamble - just the message itself.`;

    console.log(`[${requestId}] Prompt built - length: ${prompt.length} chars`);
    console.log(`[${requestId}] Generating variation #${variationCount}...`);

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
    console.log(`[${requestId}] Calling Gemini API...`);

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
          maxOutputTokens: 1024,
          topP: 0.95,
          topK: 40
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
    console.log(`[${requestId}] Gemini full response:`, JSON.stringify(geminiJson, null, 2));

    // Extract text from Gemini response
    let tweakedMessage = "";
    try {
      const candidate = geminiJson.candidates?.[0];
      console.log(`[${requestId}] Candidate object:`, JSON.stringify(candidate, null, 2));

      if (!candidate) {
        console.error(`[${requestId}] No candidates in Gemini response`);
        throw new Error("No candidates in response");
      }

      const content = candidate.content;
      console.log(`[${requestId}] Content object:`, JSON.stringify(content, null, 2));

      const parts = content?.parts ?? [];
      console.log(`[${requestId}] Parts array length: ${parts.length}`);

      if (parts.length === 0) {
        console.error(`[${requestId}] No parts in content`);
        throw new Error("No parts in content");
      }

      // Extract text from all parts
      const textParts = parts
        .map((p, idx) => {
          console.log(`[${requestId}] Part ${idx}:`, JSON.stringify(p, null, 2));
          return p.text;
        })
        .filter((t) => {
          const isValid = typeof t === "string" && t.trim() !== "";
          console.log(`[${requestId}] Text part valid: ${isValid}, length: ${t?.length || 0}`);
          return isValid;
        });

      console.log(`[${requestId}] Valid text parts: ${textParts.length}`);
      tweakedMessage = textParts.join(" ").trim();
      console.log(`[${requestId}] Final tweaked message length: ${tweakedMessage.length} chars`);
      console.log(`[${requestId}] First 100 chars: ${tweakedMessage.substring(0, 100)}...`);

    } catch (e) {
      console.error(`[${requestId}] Error parsing Gemini response:`, e.message);
      console.error(`[${requestId}] Stack:`, e.stack);
      tweakedMessage = "";
    }

    if (!tweakedMessage || tweakedMessage.length === 0) {
      console.error(`[${requestId}] WARNING: Empty tweaked message after parsing!`);
      return new Response(JSON.stringify({
        success: false,
        error: "Generated message is empty",
        variation_number: variationCount,
        gemini_response: geminiJson
      }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    // 6) Save new variation into DB
    const insertPayload = {
      campaign_id: campaignId,
      message: tweakedMessage,
      original_message: originalMessage,
      variation_number: variationCount,
      fixed_params: Object.keys(fixedParams).length ? fixedParams : null
    };

    console.log(`[${requestId}] Inserting variation into DB:`, insertPayload);

    const { error: insertError } = await supabase
      .from("message_variations")
      .insert(insertPayload);

    if (insertError) {
      console.error(`[${requestId}] DB insert error:`, insertError);
      return new Response(JSON.stringify({
        success: false,
        tweaked_message: tweakedMessage,
        variation_number: variationCount,
        campaign_id: campaignId,
        original_message: originalMessage,
        db_error: insertError.message
      }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    console.log(`[${requestId}] ✅ SUCCESS - Variation #${variationCount} created and saved`);

    // 7) Return success
    return new Response(JSON.stringify({
      success: true,
      tweaked_message: tweakedMessage,
      variation_number: variationCount,
      campaign_id: campaignId,
      original_message: originalMessage,
      contact_phone: contactPhone
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error(`[${requestId}] ❌ UNHANDLED ERROR:`, err.message);
    console.error(`[${requestId}] Stack:`, err.stack);
    return new Response(JSON.stringify({
      success: false,
      error: "Internal server error",
      details: err.message
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
});
