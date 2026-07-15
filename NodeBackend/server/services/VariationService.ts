/**
 * VariationService - Generates message variations on-demand during bulk sending
 * 
 * Strategy: Generate variations just-in-time as each message is queued
 * This ensures unique messages without pre-generating all variations
 */

import { log } from "../utils";

interface VariationRequest {
  campaignId: string;
  message: string;
  fixedParams?: Record<string, any>;
  contactPhone?: string;
}

interface VariationResponse {
  success: boolean;
  tweakedMessage: string;
  variationNumber: number;
  error?: string;
}

class VariationService {
  private supabaseUrl: string;
  private supabaseAnonKey: string;
  private edgeFunctionUrl: string;

  constructor() {
    this.supabaseUrl = process.env.VITE_SUPABASE_URL || "";
    this.supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || "";
    this.edgeFunctionUrl = `${this.supabaseUrl}/functions/v1/bulk-message-generator`;

    if (!this.supabaseUrl || !this.supabaseAnonKey) {
      log("⚠️ WARNING: Supabase credentials not configured for VariationService");
    }
  }

  /**
   * Generate a unique message variation for a contact
   * Uses queue to prevent duplicate concurrent requests for same campaign
   */
  async generateVariation(request: VariationRequest): Promise<VariationResponse> {
    const { campaignId, message, fixedParams, contactPhone } = request;

    log(`📝 Generating variation for campaign ${campaignId}, contact: ${contactPhone || 'unknown'}`);

    try {
      const response = await fetch(this.edgeFunctionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.supabaseAnonKey}`,
          "apikey": this.supabaseAnonKey
        },
        body: JSON.stringify({
          campaign_id: campaignId,
          message: message,
          fixed_params: fixedParams || {},
          contact_phone: contactPhone || ""
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        log(`❌ Edge function error (${response.status}): ${errorText}`);
        throw new Error(`Edge function failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      if (!data.success) {
        log(`❌ Edge function returned error: ${data.error}`);
        throw new Error(data.error || "Unknown error from edge function");
      }

      if (!data.tweaked_message || data.tweaked_message.trim() === "") {
        log(`⚠️ WARNING: Edge function returned empty message`);
        log(`Response data: ${JSON.stringify(data)}`);
        throw new Error("Generated message is empty");
      }

      log(`✅ Variation #${data.variation_number} generated (${data.tweaked_message.length} chars)`);

      return {
        success: true,
        tweakedMessage: data.tweaked_message,
        variationNumber: data.variation_number
      };

    } catch (error: any) {
      log(`❌ Error generating variation: ${error.message}`);
      return {
        success: false,
        tweakedMessage: message, // Fallback to original message
        variationNumber: 0,
        error: error.message
      };
    }
  }

  /**
   * Generate a pool of variations in a single edge-function call
   * (one Gemini request produces all of them).
   * Returns an empty array on failure so callers can fall back to the original message.
   */
  async generateVariationPool(
    campaignId: string,
    message: string,
    fixedParams: Record<string, any>,
    count: number
  ): Promise<string[]> {
    log(`📦 Generating pool of ${count} variations for campaign ${campaignId}...`);

    try {
      const response = await fetch(this.edgeFunctionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.supabaseAnonKey}`,
          "apikey": this.supabaseAnonKey
        },
        body: JSON.stringify({
          campaign_id: campaignId,
          message: message,
          fixed_params: fixedParams || {},
          count: count
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Edge function failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      if (!data.success || !Array.isArray(data.variations)) {
        throw new Error(data.error || "Edge function did not return variations");
      }

      const variations = data.variations
        .filter((v: unknown) => typeof v === "string" && v.trim() !== "");

      log(`✅ Pool ready: ${variations.length}/${count} variations`);
      return variations;

    } catch (error: any) {
      log(`❌ Error generating variation pool: ${error.message}`);
      return [];
    }
  }
}

// Singleton instance
export const variationService = new VariationService();
