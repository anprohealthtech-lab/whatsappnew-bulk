/**
 * HIMSChatbotService - HIMS Appointment WhatsApp Chatbot
 *
 * This service handles WhatsApp messages from patients registered under a
 * HIMS (Hospital Information Management System) organization.  It uses
 * Anthropic Claude with tool calling for appointment operations (get slots,
 * book, cancel, reschedule) and falls back to the existing Supabase RAG
 * knowledge-base for general clinic / doctor / procedure questions.
 *
 * Architecture:
 *   1. Patient texts on WhatsApp
 *   2. routes.ts detects phone in `hims_patients` table → routes here
 *   3. Claude decides: appointment tool  OR  general Q&A
 *      • Appointment tool → callHIMSEdgeFunction → HIMS Supabase Edge Function (direct)
 *      • General Q&A → callSupabaseRagChat (existing knowledge-base vector search)
 *   4. Final response sent back via WhatsApp
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IStorage } from "../storage";
import type { HIMSPatient } from "@shared/schema";
import { db } from "../db";
import { users } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

// ───────────────────── HIMS Supabase Edge Functions (direct) ─────────────────────
const HIMS_SUPABASE_URL =
  process.env.HIMS_SUPABASE_URL || "https://nxbzrpmlnlvknmutyher.supabase.co";
const HIMS_BOT_SECRET = process.env.HIMS_BOT_SECRET || "";

// ───────────────────── Default system prompt ─────────────────────
const DEFAULT_SYSTEM_PROMPT = `You are a friendly and professional hospital appointment assistant on WhatsApp.
You help patients book, check, and manage their appointments with doctors.

## YOUR IDENTITY
- Personality: Warm, professional, clear — like a helpful hospital receptionist
- Platform: WhatsApp
- Tone: Polite, concise, mobile-friendly
- Language: Use emojis sparingly and naturally

## YOUR CAPABILITIES
1. Show available appointment slots for a doctor on a date
2. Book an appointment for the patient
3. Show today's or upcoming appointments
4. Cancel an existing appointment
5. Get list of doctors with their specializations
6. Answer general questions about the clinic/hospital using the knowledge base

## RESPONSE STYLE
- Be brief — WhatsApp, not email
- Confirm clearly what you understood
- When showing slots, format them nicely
- When booking, confirm all details before finalising
- If the patient asks something you can't answer with tools, answer from your knowledge base context

## DATE HANDLING
Convert natural language dates to YYYY-MM-DD:
- Use the CURRENT CONTEXT date/time, which is already in IST (Asia/Kolkata)
- When mentioning dates to patients, use the dateDisplay returned by tools when available
- "tomorrow" → next day
- "next Monday" → calculate it
- "today" → current date

## HIMS API RULES (STRICT — follow exactly)
- All dates MUST be in "YYYY-MM-DD" format (e.g. "2026-04-20")
- Patients may write natural times like "2 pm", "2pm", or "2:00 PM"; interpret these as the matching available slot and call tools with 24-hour HH:MM
- All timeSlots MUST be in 24-hour "HH:MM" format (e.g. "14:00", "09:30", "17:00") — NEVER use AM/PM like "2:00 PM" or "02:00 PM"
- ALWAYS call get_doctors FIRST to get the real doctorId UUID before calling get_available_slots or book_appointment
- NEVER guess or fabricate a doctorId — it must be the exact UUID returned by get_doctors
- patientPhone MUST always include country code without + (e.g. "919909249725", not "+919909249725" or "9909249725")

## IMPORTANT RULES
1. ALWAYS use the provided organizationId in ALL function calls
2. If the patient asks for a doctor by name, call get_doctors with searchQuery to find the exact ID, then use that ID
3. Be concise — WhatsApp messages should be short
4. Use formatting — *bold* for headings, • for bullets
5. If no slots are available, suggest alternative dates
6. Always confirm booking details with the patient before calling book_appointment
7. If a tool returns no useful results, do not keep retrying similar tool calls. Give the best direct answer you can with the information you already have.`;

const MAX_TOOL_ROUNDS = 8;
const MAX_REPEAT_PER_SIGNATURE = 2;
const IST_TIME_ZONE = "Asia/Kolkata";
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_LOOKUP: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function getOrdinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function parseIsoDate(date: unknown): { year: number; month: number; day: number } | null {
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function getDateDisplay(date: unknown): string | null {
  const parsed = parseIsoDate(date);
  if (!parsed) return null;
  const utcDate = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const weekday = WEEKDAY_NAMES[utcDate.getUTCDay()];
  const suffix = getOrdinalSuffix(parsed.day);
  return `${weekday}, ${parsed.day}${suffix} ${MONTH_NAMES[parsed.month - 1]} ${parsed.year}`;
}

function getCurrentIstContext(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const getPart = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${getPart("year")}-${getPart("month")}-${getPart("day")}`,
    time: `${getPart("hour")}:${getPart("minute")}:${getPart("second")} IST`,
  };
}

function normalizeTimeSlot(value: unknown): string | null {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, "$1:$2")
    .replace(/\b([ap])\.?m\.?\b/g, "$1m")
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
  if (!raw) return null;

  const match = raw.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function correctWeekdayLabels(text: string): string {
  return text.replace(
    /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})\b/gi,
    (full, _weekday, dayText, monthText, yearText) => {
      const monthIndex = MONTH_LOOKUP[String(monthText).toLowerCase()];
      const day = Number(dayText);
      const year = Number(yearText);
      if (monthIndex === undefined || !day || !year) return full;
      const display = getDateDisplay(
        `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      );
      return display || full;
    },
  );
}

// ───────────────────── Anthropic tool definitions ─────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_doctors",
    description:
      "Get a list of doctors in the hospital/clinic. Use when patient asks about doctors, specializations, or who is available.",
    input_schema: {
      type: "object" as const,
      properties: {
        organizationId: {
          type: "string",
          description: "The HIMS organization ID (from context)",
        },
        specialization: {
          type: "string",
          description:
            "Optional filter by specialization (e.g. Cardiologist, Dentist)",
        },
        searchQuery: {
          type: "string",
          description: "Optional search by doctor name",
        },
      },
      required: ["organizationId"],
    },
  },
  {
    name: "get_available_slots",
    description:
      "Get available appointment slots for a specific doctor on a specific date. Use when patient wants to see when a doctor is free.",
    input_schema: {
      type: "object" as const,
      properties: {
        organizationId: {
          type: "string",
          description: "The HIMS organization ID (from context)",
        },
        doctorId: {
          type: "string",
          description:
            "The doctor's UUID from get_doctors response. MUST call get_doctors first to obtain this. NEVER guess or fabricate.",
        },
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format (e.g. '2026-04-20')",
        },
      },
      required: ["organizationId", "doctorId", "date"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book an appointment for the patient. Confirm details with the patient before calling this.",
    input_schema: {
      type: "object" as const,
      properties: {
        organizationId: {
          type: "string",
          description: "The HIMS organization ID (from context)",
        },
        doctorId: {
          type: "string",
          description: "The doctor's UUID from get_doctors response. MUST call get_doctors first. NEVER guess.",
        },
        date: {
          type: "string",
          description: "Appointment date in YYYY-MM-DD format (e.g. '2026-04-20')",
        },
        timeSlot: {
          type: "string",
          description: "Appointment time in 24-hour HH:MM format ONLY (e.g. '14:00', '09:30'). NEVER use AM/PM format.",
        },
        patientName: {
          type: "string",
          description: "Patient's full name",
        },
        patientPhone: {
          type: "string",
          description: "Patient's phone number with country code, no + prefix (e.g. '919909249725')",
        },
        reason: {
          type: "string",
          description:
            "Reason for visit / chief complaint (optional but helpful)",
        },
      },
      required: [
        "organizationId",
        "doctorId",
        "date",
        "timeSlot",
        "patientName",
        "patientPhone",
      ],
    },
  },
  {
    name: "get_appointments",
    description:
      "Get appointments for a patient (upcoming or for a specific date). Use when patient asks about their existing appointments.",
    input_schema: {
      type: "object" as const,
      properties: {
        organizationId: {
          type: "string",
          description: "The HIMS organization ID (from context)",
        },
        patientPhone: {
          type: "string",
          description: "Patient's phone number (from context)",
        },
        date: {
          type: "string",
          description:
            "Optional date filter in YYYY-MM-DD format. Omit for all upcoming.",
        },
      },
      required: ["organizationId", "patientPhone"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        organizationId: {
          type: "string",
          description: "The HIMS organization ID (from context)",
        },
        appointmentId: {
          type: "string",
          description: "The appointment ID to cancel",
        },
      },
      required: ["organizationId", "appointmentId"],
    },
  },
  {
    name: "search_knowledge_base",
    description:
      "Search the clinic/hospital knowledge base for general information — clinic hours, directions, procedures, preparation instructions, pricing, etc. Use when the patient's question is NOT about appointments.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "The patient's question to search the knowledge base for",
        },
        organizationId: {
          type: "string",
          description: "The HIMS organization ID (from context)",
        },
      },
      required: ["query", "organizationId"],
    },
  },
];

// ───────────────────── Conversation cache ─────────────────────
interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

const conversationCache = new Map<string, ConversationMessage[]>();
const MAX_CONVERSATION_HISTORY = 10;

// ───────────────────── Service ─────────────────────
export class HIMSChatbotService {
  private anthropic: Anthropic | null = null;

  constructor(
    private storage: IStorage,
    private whatsappService: any,
  ) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
      console.log("[HIMSChatbotService] Anthropic client initialized");
    } else {
      console.warn(
        "[HIMSChatbotService] ANTHROPIC_API_KEY not set — chatbot will not work",
      );
    }
  }

  // ─── Lookup helpers ───

  async isHIMSPatient(phoneNumber: string): Promise<boolean> {
    const patient = await this.storage.getHIMSPatient(phoneNumber);
    return !!patient;
  }

  async getHIMSPatient(phoneNumber: string): Promise<HIMSPatient | null> {
    return (await this.storage.getHIMSPatient(phoneNumber)) || null;
  }

  async isHIMSChatbotActive(phoneNumber: string): Promise<boolean> {
    const patient = await this.storage.getHIMSPatient(phoneNumber);
    return patient?.chatbotActive === "true";
  }

  // ─── Trigger keyword detection ───

  async detectHIMSTrigger(
    phoneNumber: string,
    messageText: string,
  ): Promise<string | null> {
    // Get all HIMS patient records that have trigger keywords
    // We check if this is a NEW number whose message matches any org's keywords
    const allPatients = await this.storage.getAllHIMSPatients();

    // Collect unique keyword sets across all HIMS orgs
    // (In practice each WhatsApp session owner would have their own HIMS patients)
    const normalised = messageText
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .trim();

    // Also check a global default keyword set
    const defaultKeywords = [
      "appointment",
      "book",
      "doctor",
      "schedule",
      "slot",
      "opd",
    ];

    for (const kw of defaultKeywords) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(normalised)) return kw;
    }

    // Check per-patient custom keywords
    for (const p of allPatients) {
      const keywords = (p.triggerKeywords as string[]) || [];
      for (const kw of keywords) {
        const re = new RegExp(
          `\\b${kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        );
        if (re.test(normalised)) return kw;
      }
    }

    return null;
  }

  // ─── Conversation cache ───

  private getConversationFromCache(
    phoneNumber: string,
  ): ConversationMessage[] {
    return conversationCache.get(phoneNumber) || [];
  }

  private addToConversationCache(
    phoneNumber: string,
    role: "user" | "assistant",
    content: string,
  ): void {
    const history = this.getConversationFromCache(phoneNumber);
    history.push({ role, content });
    if (history.length > MAX_CONVERSATION_HISTORY) history.shift();
    conversationCache.set(phoneNumber, history);
  }

  // ─── HIMS Edge Function caller (direct to HIMS Supabase) ───

  private async callHIMSEdgeFunction(
    functionName: string,
    body: Record<string, any>,
  ): Promise<any> {
    const tag = "[HIMSChatbotService]";

    if (!HIMS_BOT_SECRET) {
      return { success: false, error: "HIMS_BOT_SECRET not configured" };
    }

    // Map organizationId → clinicId for HIMS Edge Functions
    const mapped = { ...body };
    if (mapped.organizationId) {
      mapped.clinicId = mapped.organizationId;
      delete mapped.organizationId;
    }

    const url = `${HIMS_SUPABASE_URL}/functions/v1/${functionName}`;
    console.log(`${tag} 📡 Calling HIMS Edge: ${functionName}`);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hims-bot-secret": HIMS_BOT_SECRET,
        },
        body: JSON.stringify(mapped),
      });

      const data = await resp.json();
      console.log(
        `${tag}    Response: ${JSON.stringify(data).substring(0, 150)}...`,
      );

      if (!resp.ok) {
        return {
          success: false,
          error:
            data.error ||
            data.message ||
            `Edge function error: ${resp.status}`,
        };
      }
      return { success: true, ...data };
    } catch (err: any) {
      console.log(`${tag} ❌ HIMS Edge error: ${err.message}`);
      throw err;
    }
  }

  // ─── Supabase RAG knowledge-base search ───

  private async searchKnowledgeBase(
    query: string,
    organizationId: string,
    appUserId?: string,
    conversationHistory: ConversationMessage[] = [],
  ): Promise<string> {
    const tag = "[HIMSChatbotService]";
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return JSON.stringify({
        success: false,
        error: "Knowledge base not configured",
      });
    }

    try {
      let knowledgeBaseUserId = appUserId || organizationId;
      let userIdSource = appUserId ? "app_user_id" : "fallback_org_id";
      try {
        if (!appUserId) {
          const ownerRows = await db
            .select({ id: users.id })
            .from(users)
            .where(
              drizzleSql`${users.enabledFeatures}->>'himsClinicId' = ${organizationId}`,
            )
            .limit(1);
          if (ownerRows.length > 0) {
            knowledgeBaseUserId = ownerRows[0].id;
            userIdSource = "org_owner_lookup";
          }
        }
      } catch (lookupErr: any) {
        console.log(
          `${tag} ⚠️ Knowledge-base owner lookup failed for org=${organizationId}: ${lookupErr.message}`,
        );
      }

      console.log(
        `${tag} 📚 KB search user=${knowledgeBaseUserId} source=${userIdSource} history=${conversationHistory.length} query="${query}"`,
      );

      const resp = await fetch(`${supabaseUrl}/functions/v1/rag-chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          user_id: knowledgeBaseUserId,
          message: query,
          conversation_history: conversationHistory.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          system_prompt:
            "You are a helpful hospital information assistant. Answer the question using only the provided context. Be concise.",
          match_count: 5,
          channel: "whatsapp",
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return JSON.stringify({
          success: false,
          error: `RAG error: ${resp.status}`,
        });
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;
      const chunksUsed = data.context_chunks || 0;
      console.log(
        `${tag} 📚 KB result chunks=${chunksUsed} answerPreview="${String(content || "").substring(0, 120)}"`,
      );
      return JSON.stringify({
        success: true,
        answer: content || "No information found.",
        chunks_used: chunksUsed,
      });
    } catch (err: any) {
      return JSON.stringify({ success: false, error: err.message });
    }
  }

  // ─── Tool execution ───

  private async executeTool(
    toolName: string,
    toolInput: Record<string, any>,
    patient: HIMSPatient,
    appUserId?: string,
    conversationHistory: ConversationMessage[] = [],
  ): Promise<string> {
    const tag = "[HIMSChatbotService]";
    console.log(`${tag} 🔧 Tool: ${toolName}`);
    console.log(`${tag}    Input: ${JSON.stringify(toolInput)}`);

    const organizationId = toolInput.organizationId || patient.organizationId;

    try {
      switch (toolName) {
        case "get_doctors": {
          const result = await this.callHIMSEdgeFunction("hims-get-doctors", {
            organizationId,
            specialization: toolInput.specialization,
            searchQuery: toolInput.searchQuery,
          });
          if (result.success) {
            return JSON.stringify({
              success: true,
              doctors: result.data?.doctors || result.doctors || [],
            });
          }
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to get doctors",
          });
        }

        case "get_available_slots": {
          const dateDisplay = getDateDisplay(toolInput.date);
          const result = await this.callHIMSEdgeFunction("hims-get-slots", {
            organizationId,
            doctorId: toolInput.doctorId,
            date: toolInput.date,
          });
          if (result.success) {
            return JSON.stringify({
              success: true,
              date: result.date || toolInput.date,
              dateDisplay: getDateDisplay(result.date || toolInput.date) || dateDisplay,
              doctorName: result.doctorName || result.doctor,
              slots: result.slots || [],
            });
          }
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to get slots",
          });
        }

        case "book_appointment": {
          const normalizedTimeSlot = normalizeTimeSlot(toolInput.timeSlot);
          if (!normalizedTimeSlot) {
            return JSON.stringify({
              success: false,
              error:
                "Invalid time slot. Use an available slot time such as 14:00 or 2 pm.",
            });
          }
          const result = await this.callHIMSEdgeFunction("hims-book-appointment", {
            organizationId,
            doctorId: toolInput.doctorId,
            date: toolInput.date,
            timeSlot: normalizedTimeSlot,
            patientName: toolInput.patientName,
            patientPhone: toolInput.patientPhone,
            reason: toolInput.reason,
          });
          if (result.success) {
            return JSON.stringify({
              success: true,
              appointmentId: result.appointmentId,
              doctorName: result.doctorName,
              patientName: result.patientName,
              date: result.date,
              dateDisplay: getDateDisplay(result.date || toolInput.date),
              timeSlot: result.timeSlot,
              status: result.status,
            });
          }
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to book appointment",
            statusCode: result.statusCode,
          });
        }

        case "get_appointments": {
          const result = await this.callHIMSEdgeFunction("hims-get-appointments", {
            organizationId,
            patientPhone: toolInput.patientPhone,
            date: toolInput.date,
          });
          if (result.success) {
            return JSON.stringify({
              success: true,
              patientName: result.patientName,
              appointments: result.appointments || [],
            });
          }
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to get appointments",
          });
        }

        case "cancel_appointment": {
          const result = await this.callHIMSEdgeFunction(
            "hims-cancel-appointment",
            {
              organizationId,
              appointmentId: toolInput.appointmentId,
            },
          );
          if (result.success) {
            return JSON.stringify({
              success: true,
              appointmentId: result.appointmentId,
              status: result.status || "Cancelled",
            });
          }
          return JSON.stringify({
            success: false,
            error: result.error || "Failed to cancel appointment",
          });
        }

        case "search_knowledge_base": {
          return await this.searchKnowledgeBase(
            toolInput.query,
            organizationId,
            appUserId,
            conversationHistory,
          );
        }

        default:
          return JSON.stringify({
            success: false,
            error: `Unknown tool: ${toolName}`,
          });
      }
    } catch (err: any) {
      console.log(`${tag} ❌ Tool error: ${err.message}`);
      return JSON.stringify({ success: false, error: err.message });
    }
  }

  // ─── Claude processing ───

  private async processWithClaude(
    userMessage: string,
    patient: HIMSPatient,
    conversationHistory: ConversationMessage[],
    audioData?: { base64: string; mimetype: string },
    ownerSystemPrompt?: string,
    appUserId?: string,
  ): Promise<string> {
    const tag = "[HIMSChatbotService]";

    if (!this.anthropic) {
      throw new Error(
        "Anthropic client not initialized — check ANTHROPIC_API_KEY",
      );
    }

    const basePrompt = patient.systemPrompt || ownerSystemPrompt || DEFAULT_SYSTEM_PROMPT;

    const currentIst = getCurrentIstContext();
    const contextInfo = `
## CURRENT CONTEXT
- Patient Name: ${patient.name || "Patient"}
- Patient Phone: ${patient.phoneNumber}
- Organization ID: ${patient.organizationId}
- Current Date: ${currentIst.date}
- Current Time: ${currentIst.time}
- Timezone: IST (${IST_TIME_ZONE})

IMPORTANT: Always use organizationId="${patient.organizationId}" and patientPhone="${patient.phoneNumber}" in ALL function calls.`;

    const fullSystemPrompt = basePrompt + contextInfo;

    // Build messages array
    const historyMessages: Anthropic.MessageParam[] =
      conversationHistory.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      }));

    // Build user content (text or audio)
    let userContent: Anthropic.ContentBlockParam[];

    if (audioData) {
      console.log(
        `${tag} 🎤 Including voice note (${audioData.mimetype})`,
      );
      let mediaType:
        | "audio/wav"
        | "audio/mp3"
        | "audio/aiff"
        | "audio/aac"
        | "audio/ogg"
        | "audio/flac" = "audio/ogg";
      if (audioData.mimetype.includes("ogg")) mediaType = "audio/ogg";
      else if (
        audioData.mimetype.includes("mp3") ||
        audioData.mimetype.includes("mpeg")
      )
        mediaType = "audio/mp3";
      else if (audioData.mimetype.includes("wav")) mediaType = "audio/wav";
      else if (
        audioData.mimetype.includes("aac") ||
        audioData.mimetype.includes("m4a")
      )
        mediaType = "audio/aac";
      else if (audioData.mimetype.includes("flac"))
        mediaType = "audio/flac";

      userContent = [
        {
          type: "text",
          text: "I sent you a voice message. Please listen and respond:",
        },
        {
          type: "input_audio",
          input_audio: { data: audioData.base64, media_type: mediaType },
        },
      ] as Anthropic.ContentBlockParam[];
    } else {
      userContent = [{ type: "text", text: userMessage }];
    }

    const messages: Anthropic.MessageParam[] = [
      ...historyMessages,
      { role: "user", content: userContent },
    ];

    console.log(
      `${tag} 📡 Claude call${audioData ? " (audio)" : ""} — patient: ${patient.name || patient.phoneNumber}`,
    );

    try {
      let response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: fullSystemPrompt,
        tools: TOOLS,
        messages,
      });

      console.log(`${tag}    Stop reason: ${response.stop_reason}`);

      // Tool-use loop
      let toolRounds = 0;
      const seenToolSignatures = new Map<string, number>();
      while (response.stop_reason === "tool_use") {
        toolRounds += 1;
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        console.log(
          `${tag} 🔧 Claude wants ${toolUseBlocks.length} tool(s)`,
        );

        const currentSignature = toolUseBlocks
          .map((tu) => `${tu.name}:${JSON.stringify(tu.input || {})}`)
          .join("||");
        const currentCount =
          (seenToolSignatures.get(currentSignature) || 0) + 1;
        seenToolSignatures.set(currentSignature, currentCount);

        if (toolRounds > MAX_TOOL_ROUNDS || currentCount > MAX_REPEAT_PER_SIGNATURE) {
          console.log(
            `${tag} ⚠️ Breaking tool loop after ${toolRounds} rounds (signature repeats=${currentCount})`,
          );

          const forcedAnswerMessages: Anthropic.MessageParam[] = [
            ...messages,
            { role: "assistant", content: response.content },
            {
              role: "user",
              content:
                "Stop calling tools now. Give the best final answer using the information already gathered. If information is unavailable, say so clearly and briefly. Do not call any more tools.",
            },
          ];

          response = await this.anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            system: fullSystemPrompt,
            messages: forcedAnswerMessages,
          });
          console.log(
            `${tag}    Forced final answer — Stop reason: ${response.stop_reason}`,
          );
          break;
        }

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const tu of toolUseBlocks) {
          console.log(`${tag}    Tool: ${tu.name}`);
          const result = await this.executeTool(
            tu.name,
            tu.input as Record<string, any>,
            patient,
            appUserId,
            conversationHistory,
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: result,
          });
        }

        const updatedMessages: Anthropic.MessageParam[] = [
          ...messages,
          { role: "assistant", content: response.content },
          { role: "user", content: toolResults },
        ];

        response = await this.anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: fullSystemPrompt,
          tools: TOOLS,
          messages: updatedMessages,
        });

        console.log(
          `${tag}    Continued — Stop reason: ${response.stop_reason}`,
        );
      }

      // Extract final text
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      const finalResponse = textBlocks
        .map((b) => b.text)
        .join("\n")
        .trim();
      const correctedResponse = correctWeekdayLabels(finalResponse);
      if (correctedResponse) return correctedResponse;

      console.log(
        `${tag} 📤 Response: ${finalResponse.substring(0, 100)}...`,
      );
      return finalResponse || "Done! ✅";
    } catch (err: any) {
      console.log(`${tag} ❌ Anthropic error: ${err.message}`);
      throw err;
    }
  }

  // ─── Main entry point ───

  async processHIMSMessage(
    phoneNumber: string,
    messageText: string,
    audioData?: { base64: string; mimetype: string },
    replyTo?: string,
    appUserId?: string,
  ): Promise<void> {
    const tag = "[HIMSChatbotService]";

    try {
      console.log(
        `${tag} 📥 Processing from ${phoneNumber}${audioData ? " (voice)" : ""}`,
      );

      const patient = await this.storage.getHIMSPatient(phoneNumber);
      if (!patient) {
        console.log(`${tag} ⚠️ No HIMS patient for ${phoneNumber}`);
        return;
      }

      if (patient.chatbotActive !== "true") {
        console.log(`${tag} ⏸️ Chatbot paused for ${phoneNumber}`);
        return;
      }

      const history = this.getConversationFromCache(phoneNumber);
      console.log(`${tag}    ${history.length} cached messages`);

      // Look up owner's custom system prompt from enabledFeatures
      let ownerSystemPrompt: string | undefined;
      try {
        const ownerRows = await db.select({ enabledFeatures: users.enabledFeatures })
          .from(users)
          .where(drizzleSql`${users.enabledFeatures}->>'himsClinicId' = ${patient.organizationId}`)
          .limit(1);
        if (ownerRows.length > 0) {
          const features = ownerRows[0].enabledFeatures as any;
          ownerSystemPrompt = features?.himsSystemPrompt;
        }
      } catch (e) {
        console.log(`${tag} ⚠️ Could not look up owner prompt: ${(e as Error).message}`);
      }

      const displayText = audioData
        ? "[Voice Note - processing...]"
        : messageText;
      this.addToConversationCache(phoneNumber, "user", displayText);

      const botResponse = await this.processWithClaude(
        messageText,
        patient,
        history,
        audioData,
        ownerSystemPrompt,
        appUserId,
      );

      if (audioData) {
        this.addToConversationCache(phoneNumber, "user", "[Voice Note]");
      }
      this.addToConversationCache(phoneNumber, "assistant", botResponse);

      const sendTo = replyTo || phoneNumber;
      console.log(`${tag} 📤 Sending to ${sendTo}`);

      await this.whatsappService.sendTextMessage(sendTo, botResponse);

      await this.storage.createMessage({
        phoneNumber,
        content: botResponse,
        type: "text",
        status: "sent",
        metadata: {
          hims_chatbot_reply: true,
          organization_id: patient.organizationId,
          was_voice_note: !!audioData,
        },
      });

      console.log(`${tag} ✅ Response sent`);
    } catch (error: any) {
      console.error(`${tag} ❌ Error: ${error.message}`);
      try {
        const sendTo = replyTo || phoneNumber;
        await this.whatsappService.sendTextMessage(
          sendTo,
          "Sorry, I'm having trouble right now. Please try again in a moment. 🙏",
        );
      } catch {
        // Swallow send error
      }
    }
  }

  // ─── Welcome message ───

  async sendWelcomeMessage(patient: HIMSPatient): Promise<void> {
    const greeting =
      patient.greetingMessage ||
      `Hello${patient.name ? ` ${patient.name}` : ""}! 👋\n\nI'm your hospital appointment assistant. I can help you:\n\n📅 *Book appointments*\n👨‍⚕️ *Find doctors*\n🕐 *Check available slots*\n❌ *Cancel appointments*\n\nHow can I help you today?`;

    try {
      await this.whatsappService.sendTextMessage(
        patient.phoneNumber,
        greeting,
      );
    } catch (err: any) {
      console.log(
        `[HIMSChatbotService] ⚠️ Welcome message failed: ${err.message}`,
      );
    }
  }
}
