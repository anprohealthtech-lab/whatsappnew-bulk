/**
 * LeadDripService — turns a natural-language drip instruction into a reusable
 * sequence template (once, via an LLM), and schedules that template for each new
 * lead without any further LLM calls.
 *
 * - generateTemplate(): called at config time (pipeline create/update) — one LLM
 *   call, returns [{ delay, message }]. Messages may contain a {{name}} placeholder.
 * - scheduleForLead(): called per new lead (e.g. webhook ingest) — pure DB inserts
 *   into lead_followups; the LeadFollowupService tick sends them. Any inbound reply
 *   from the lead cancels the remaining drip (handled in ChatbotService).
 */

import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import { leadFollowups } from "@shared/schema";
import { log } from "../utils";

interface TenantContext { organizationId: string; userId: string; }
export interface DripMessage { delay: string; message: string; }

const MODEL = "claude-haiku-4-5-20251001";
const MAX_MESSAGES = 12;
const MIN_MS = 5 * 60 * 1000;            // 5 minutes
const MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Parse "1h" / "4h" / "2d" / "30m" / "1w" into ms, clamped to [5min, 30d]. */
function parseDuration(input: string): number {
  const m = String(input || "").trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult: Record<string, number> = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const ms = value * (mult[unit] || 0);
  if (ms <= 0) return 0;
  return Math.min(Math.max(ms, MIN_MS), MAX_MS);
}

export class LeadDripService {
  /** One LLM call: convert a drip instruction into a sequence template. */
  async generateTemplate(dripPrompt: string): Promise<DripMessage[]> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      log("[LeadDrip] ANTHROPIC_API_KEY not set — cannot generate drip template");
      return [];
    }
    if (!dripPrompt || !dripPrompt.trim()) return [];

    try {
      const anthropic = new Anthropic({ apiKey });
      const system =
        "You design a WhatsApp drip sequence for a NEW lead. Based on the user's instructions, " +
        "output ONLY a JSON array (no prose, no markdown fences). Each item is " +
        `{"delay":"<duration>","message":"<text>"}. delay uses compact units m/h/d/w ` +
        `(e.g. "5m","3h","1d") measured from when the lead is received. Use the placeholder ` +
        `{{name}} where the lead's name should appear. Keep messages short and WhatsApp-appropriate. ` +
        `Return at most ${MAX_MESSAGES} messages, ordered earliest first.`;

      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: dripPrompt }],
      });

      const textBlock = resp.content.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      return this.parseSequence(raw);
    } catch (e) {
      log(`[LeadDrip] Template generation failed: ${e instanceof Error ? e.message : "Unknown error"}`);
      return [];
    }
  }

  /** Schedule a template's messages for one lead. Returns the number queued. */
  async scheduleForLead(
    tenant: TenantContext,
    phoneNumber: string,
    template: DripMessage[],
    leadName?: string | null,
  ): Promise<number> {
    if (!Array.isArray(template) || template.length === 0) return 0;

    const now = Date.now();
    const rows = template
      .slice(0, MAX_MESSAGES)
      .map((item) => ({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        phoneNumber,
        message: this.applyName(item.message, leadName),
        scheduledAt: new Date(now + parseDuration(item.delay)),
        status: "scheduled" as const,
      }))
      .filter((r) => r.message && r.message.trim());

    if (rows.length === 0) return 0;

    try {
      await db.insert(leadFollowups).values(rows);
      log(`[LeadDrip] Scheduled ${rows.length} drip message(s) for ${phoneNumber}`);
      return rows.length;
    } catch (e) {
      log(`[LeadDrip] Failed to schedule drip for ${phoneNumber}: ${e instanceof Error ? e.message : "Unknown error"}`);
      return 0;
    }
  }

  private applyName(message: string, leadName?: string | null): string {
    return String(message || "").replace(/\{\{\s*name\s*\}\}/gi, (leadName || "there").trim() || "there");
  }

  private parseSequence(raw: string): DripMessage[] {
    if (!raw) return [];
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) return [];
    try {
      const arr = JSON.parse(raw.slice(start, end + 1));
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((x: any) => x && typeof x.message === "string" && typeof x.delay === "string")
        .map((x: any) => ({ delay: String(x.delay), message: String(x.message) }))
        .slice(0, MAX_MESSAGES);
    } catch {
      return [];
    }
  }
}

export const leadDripService = new LeadDripService();
