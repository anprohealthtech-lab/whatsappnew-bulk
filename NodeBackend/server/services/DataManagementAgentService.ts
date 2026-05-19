import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { db } from "../db";
import {
  dataDocuments,
  dataGeneralRecords,
  dataPatientEvents,
  dataPatients,
  users,
} from "@shared/schema";

type TenantContext = {
  organizationId: string;
  userId: string;
};

type IncomingDataMessage = {
  phoneNumber: string;
  content?: string;
  messageType?: string;
  mediaData?: string | null;
  mediaBuffer?: Buffer | null;
  mediaInfo?: {
    mimetype?: string;
    fileName?: string;
    fileLength?: number | string | bigint;
    caption?: string;
    title?: string;
  };
  from?: string;
  replyTo?: string;
  timestamp?: number;
};

type ExtractedPatient = {
  name?: string | null;
  age?: number | null;
  gender?: string | null;
  phone?: string | null;
  dob?: string | null;
};

type DataExtraction = {
  record_scope: "patient" | "general" | "unknown";
  document_type?: string;
  record_type?: string;
  title?: string;
  patient?: ExtractedPatient;
  event_date?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  summary?: string;
  raw_text?: string;
  emr_fields?: Record<string, unknown>;
  structured_data?: Record<string, unknown>;
  confidence?: number;
  needs_confirmation?: boolean;
};

const DEFAULT_DATA_MANAGEMENT_PROMPT = `You are a clinical data management agent for a doctor's private WhatsApp/data app.

Your job is to read text, report images, PDF documents, and short doctor notes, then return strict JSON only.

Classify the input into one of:
- patient: report, prescription, discharge summary, surgery note, invoice, or any record tied to a patient.
- general: price list, package list, monthly surgery count, clinic note, inventory, revenue, or other data not tied to one patient.
- unknown: insufficient usable information.

Rules:
- Never invent missing data.
- Preserve medical values exactly.
- Use null for missing fields.
- Use ISO dates (YYYY-MM-DD) when visible or clearly stated.
- Set confidence from 0 to 1.
- Set needs_confirmation true when patient matching should not be automatic.
- Return JSON only. No markdown.

For patient records, return:
{
  "record_scope": "patient",
  "document_type": "lab_report|prescription|discharge_summary|surgery_note|invoice|imaging_report|unknown",
  "patient": { "name": string|null, "age": number|null, "gender": string|null, "phone": string|null, "dob": string|null },
  "event_date": "YYYY-MM-DD"|null,
  "summary": string,
  "emr_fields": object,
  "confidence": number,
  "needs_confirmation": boolean
}

For general records, return:
{
  "record_scope": "general",
  "record_type": "price_list|surgery_count|package_list|clinic_note|inventory|revenue|general_note",
  "title": string,
  "period_start": "YYYY-MM-DD"|null,
  "period_end": "YYYY-MM-DD"|null,
  "summary": string,
  "structured_data": object,
  "confidence": number
}`;

export class DataManagementAgentService {
  private anthropic: Anthropic | null = null;

  constructor(private whatsappService?: { sendTextMessage(phoneNumber: string, message: string): Promise<any> }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }
  }

  async isEnabledForUser(userId: string): Promise<boolean> {
    const access = await this.getUserAccess(userId);
    return access.role === "super_admin" || access.features.dataManagement === true;
  }

  async shouldHandleMessage(ownerUserId: string, data: IncomingDataMessage): Promise<boolean> {
    const access = await this.getUserAccess(ownerUserId);
    const features = access.features;
    if (access.role !== "super_admin" && features.dataManagement !== true) return false;

    const allowedNumbers = Array.isArray(features.dataManagementAllowedNumbers)
      ? features.dataManagementAllowedNumbers.map((value: unknown) => String(value).replace(/\D/g, "").slice(-10)).filter(Boolean)
      : [];
    if (allowedNumbers.length > 0) {
      const senderLast10 = String(data.phoneNumber || "").replace(/\D/g, "").slice(-10);
      if (!allowedNumbers.includes(senderLast10)) return false;
    }

    const messageType = data.messageType || "text";
    if (messageType === "image" || messageType === "document") return true;

    const text = (data.content || "").trim().toLowerCase();
    if (!text) return false;

    const commandPatterns = [
      /\bhow many patients\b/,
      /\bcount patients\b/,
      /\bshow .*patient\b/,
      /\blast (report|update|document)\b/,
      /\bprice list\b/,
      /\bsurgery\b/,
      /\badd .*patient\b/,
      /\bfind patient\b/,
      /\bdata\b/,
    ];

    return commandPatterns.some((pattern) => pattern.test(text));
  }

  async handleIncomingMessage(tenant: TenantContext, data: IncomingDataMessage): Promise<string> {
    const messageType = data.messageType || "text";
    if (messageType === "image" || messageType === "document") {
      return this.processDocument(tenant, data);
    }

    const maybeSaved = await this.trySaveTextAsRecord(tenant, data);
    if (maybeSaved) return maybeSaved;

    return this.answerDataQuestion(tenant, data.content || "");
  }

  private async processDocument(tenant: TenantContext, data: IncomingDataMessage): Promise<string> {
    if (!data.mediaData) {
      await db.insert(dataDocuments).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        sourcePhoneNumber: data.phoneNumber,
        fileName: data.mediaInfo?.fileName || null,
        mimeType: data.mediaInfo?.mimetype || null,
        fileSize: this.toFileSize(data.mediaInfo?.fileLength),
        status: "failed",
        errorMessage: "WhatsApp media download failed",
      });
      return "I received the file, but could not download it for parsing. Please resend it.";
    }

      const extraction = await this.extractStructuredData(tenant, data);
    return this.persistExtraction(tenant, data, extraction);
  }

  private async trySaveTextAsRecord(tenant: TenantContext, data: IncomingDataMessage): Promise<string | null> {
    const text = (data.content || "").trim();
    if (!text) return null;

    const looksLikeAdd = /^(add|save|record|store)\b/i.test(text);
    const looksLikeFact = /\b(surger(y|ies)|price|package|charge|rate|cost|patient report|prescription)\b/i.test(text)
      && /\d/.test(text)
      && !/[?？]/.test(text);
    if (!looksLikeAdd && !looksLikeFact) return null;

    if (!this.anthropic) return null;

    const extraction = await this.extractStructuredData(tenant, {
      ...data,
      messageType: "text",
      content: text,
    });

    if (extraction.record_scope === "unknown" || (extraction.confidence ?? 0) < 0.45) {
      return null;
    }

    return this.persistExtraction(tenant, data, extraction);
  }

  private async answerDataQuestion(tenant: TenantContext, question: string): Promise<string> {
    const text = question.trim();
    const lower = text.toLowerCase();

    if (/\bhow many patients\b|\bcount patients\b/.test(lower)) {
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(dataPatients)
        .where(and(eq(dataPatients.organizationId, tenant.organizationId), eq(dataPatients.userId, tenant.userId)));
      return `You have ${Number(rows[0]?.count || 0)} patients in the data records.`;
    }

    const patientName = this.extractNameFromQuestion(text);
    if (patientName) {
      const patient = await this.findPatientByName(tenant, patientName);
      if (!patient) return `I could not find a patient matching "${patientName}".`;

      const events = await db
        .select()
        .from(dataPatientEvents)
        .where(eq(dataPatientEvents.patientId, patient.id))
        .orderBy(desc(dataPatientEvents.createdAt))
        .limit(5);

      if (events.length === 0) return `${patient.canonicalName} exists, but I do not have timeline updates yet.`;

      const lines = events.map((event, index) => {
        const date = event.eventDate || event.createdAt?.toISOString?.().slice(0, 10) || "unknown date";
        return `${index + 1}. ${date}: ${event.summary}`;
      });
      return `Latest updates for ${patient.canonicalName}:\n${lines.join("\n")}`;
    }

    if (/\b(price|package|surgery|surgeries|inventory|revenue)\b/.test(lower)) {
      const records = await db
        .select()
        .from(dataGeneralRecords)
        .where(and(
          eq(dataGeneralRecords.organizationId, tenant.organizationId),
          eq(dataGeneralRecords.userId, tenant.userId),
          ilike(dataGeneralRecords.rawText, `%${this.keywordForGeneralSearch(lower)}%`),
        ))
        .orderBy(desc(dataGeneralRecords.createdAt))
        .limit(5);

      if (records.length === 0) return "I could not find matching general data records yet.";
      return records.map((record, index) => `${index + 1}. ${record.title}: ${record.rawText || JSON.stringify(record.structuredData)}`).join("\n");
    }

    return "I can answer patient counts, patient timelines, last reports, price/package data, and surgery/general records once they are saved.";
  }

  private async extractStructuredData(tenant: TenantContext, data: IncomingDataMessage): Promise<DataExtraction> {
    if (!this.anthropic) {
      return {
        record_scope: "unknown",
        document_type: "unknown",
        summary: "AI parser is not configured. Set ANTHROPIC_API_KEY.",
        confidence: 0,
        needs_confirmation: true,
      };
    }

    const contentBlocks: any[] = [
      {
        type: "text",
        text: [
          `Message type: ${data.messageType || "text"}`,
          `Caption/text: ${data.content || ""}`,
          `File name: ${data.mediaInfo?.fileName || ""}`,
          `MIME type: ${data.mediaInfo?.mimetype || ""}`,
        ].join("\n"),
      },
    ];

    if (data.mediaData) {
      const mimetype = data.mediaInfo?.mimetype || "application/octet-stream";
      if (mimetype.startsWith("image/")) {
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mimetype, data: data.mediaData },
        });
      } else if (mimetype === "application/pdf") {
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: data.mediaData },
        });
      } else {
        contentBlocks[0].text += "\nUnsupported binary document for direct AI reading. Use filename/caption only.";
      }
    }

    const response = await this.anthropic.messages.create({
      model: process.env.DATA_AGENT_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 1800,
      system: await this.getSystemPrompt(tenant.userId),
      messages: [{ role: "user", content: contentBlocks }],
    } as any);

    const text = response.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n")
      .trim();

    return this.parseExtractionJson(text);
  }

  private async persistExtraction(tenant: TenantContext, data: IncomingDataMessage, extraction: DataExtraction): Promise<string> {
    if (extraction.record_scope === "patient") {
      const patientName = extraction.patient?.name?.trim();
      if (!patientName) {
        await db.insert(dataDocuments).values({
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          sourcePhoneNumber: data.phoneNumber,
          fileName: data.mediaInfo?.fileName || null,
          mimeType: data.mediaInfo?.mimetype || null,
          fileSize: this.toFileSize(data.mediaInfo?.fileLength),
          documentType: extraction.document_type || "unknown",
          extractedJson: extraction as any,
          confidence: extraction.confidence || 0,
          status: "needs_review",
          errorMessage: "Patient name not found",
          processedAt: new Date(),
        });
        return "I parsed the document, but could not identify the patient name. I saved it for review.";
      }

      const patient = await this.findOrCreatePatient(tenant, extraction.patient || { name: patientName });
      const documentRows = await db.insert(dataDocuments).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        patientId: patient.id,
        sourcePhoneNumber: data.phoneNumber,
        fileName: data.mediaInfo?.fileName || null,
        mimeType: data.mediaInfo?.mimetype || null,
        fileSize: this.toFileSize(data.mediaInfo?.fileLength),
        documentType: extraction.document_type || "unknown",
        ocrText: extraction.raw_text || null,
        extractedJson: extraction as any,
        confidence: extraction.confidence || null,
        status: extraction.needs_confirmation ? "needs_review" : "processed",
        processedAt: new Date(),
      }).returning();

      await db.insert(dataPatientEvents).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        patientId: patient.id,
        documentId: documentRows[0].id,
        eventType: extraction.document_type || "document_received",
        eventDate: extraction.event_date || null,
        summary: extraction.summary || `New ${extraction.document_type || "document"} received.`,
        structuredData: (extraction.emr_fields || extraction.structured_data || {}) as any,
      });

      await db.update(dataPatients)
        .set({
          age: extraction.patient?.age ?? patient.age,
          gender: extraction.patient?.gender || patient.gender,
          dob: extraction.patient?.dob || patient.dob,
          summary: extraction.summary || patient.summary,
          lastUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(dataPatients.id, patient.id));

      return `Saved ${extraction.document_type || "document"} for ${patient.canonicalName}. Summary: ${extraction.summary || "No summary extracted."}`;
    }

    if (extraction.record_scope === "general") {
      const documentRows = await db.insert(dataDocuments).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        sourcePhoneNumber: data.phoneNumber,
        fileName: data.mediaInfo?.fileName || null,
        mimeType: data.mediaInfo?.mimetype || null,
        fileSize: this.toFileSize(data.mediaInfo?.fileLength),
        documentType: extraction.record_type || "general",
        ocrText: extraction.raw_text || extraction.summary || data.content || null,
        extractedJson: extraction as any,
        confidence: extraction.confidence || null,
        status: "processed",
        processedAt: new Date(),
      }).returning();

      await db.insert(dataGeneralRecords).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        documentId: documentRows[0].id,
        recordType: extraction.record_type || "general_note",
        title: extraction.title || extraction.summary || "General data record",
        periodStart: extraction.period_start || null,
        periodEnd: extraction.period_end || null,
        rawText: extraction.raw_text || extraction.summary || data.content || null,
        structuredData: (extraction.structured_data || extraction.emr_fields || {}) as any,
        confidence: extraction.confidence || null,
      });

      return `Saved general data: ${extraction.title || extraction.summary || extraction.record_type || "record"}.`;
    }

    await db.insert(dataDocuments).values({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      sourcePhoneNumber: data.phoneNumber,
      fileName: data.mediaInfo?.fileName || null,
      mimeType: data.mediaInfo?.mimetype || null,
      fileSize: this.toFileSize(data.mediaInfo?.fileLength),
      documentType: "unknown",
      extractedJson: extraction as any,
      confidence: extraction.confidence || 0,
      status: "needs_review",
      errorMessage: extraction.summary || "Could not classify document",
      processedAt: new Date(),
    });

    return "I could not confidently classify this data. I saved it for review.";
  }

  private async findOrCreatePatient(tenant: TenantContext, patient: ExtractedPatient) {
    const name = patient.name?.trim() || "Unknown Patient";
    const existing = await this.findPatientByName(tenant, name, patient.age || undefined);
    if (existing) return existing;

    const rows = await db.insert(dataPatients).values({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      canonicalName: name,
      aliases: [name] as any,
      age: patient.age || null,
      gender: patient.gender || null,
      phoneNumbers: patient.phone ? [patient.phone] as any : [] as any,
      dob: patient.dob || null,
      summary: null,
    }).returning();
    return rows[0];
  }

  private async findPatientByName(tenant: TenantContext, name: string, age?: number) {
    const normalizedName = this.normalizeName(name);
    const rows = await db.select().from(dataPatients).where(and(
      eq(dataPatients.organizationId, tenant.organizationId),
      eq(dataPatients.userId, tenant.userId),
    )).orderBy(desc(dataPatients.updatedAt)).limit(200);

    return rows.find((patient) => {
      const stored = this.normalizeName(patient.canonicalName);
      if (stored === normalizedName) return true;
      if (age && patient.age === age && (stored.includes(normalizedName) || normalizedName.includes(stored))) return true;
      return false;
    }) || null;
  }

  private extractNameFromQuestion(question: string): string | null {
    const patterns = [
      /(?:for|of|patient)\s+([a-z][a-z\s.]{2,})$/i,
      /(?:show|find)\s+([a-z][a-z\s.]{2,})(?:\s+last|\s+report|\s+timeline)?/i,
      /last (?:report|update|document)\s+([a-z][a-z\s.]{2,})/i,
    ];
    for (const pattern of patterns) {
      const match = question.match(pattern);
      if (match?.[1]) return match[1].trim().replace(/[?.!,]+$/, "");
    }
    return null;
  }

  private keywordForGeneralSearch(text: string): string {
    if (text.includes("surgery") || text.includes("surgeries")) return "surg";
    if (text.includes("price")) return "price";
    if (text.includes("package")) return "package";
    if (text.includes("inventory")) return "inventory";
    if (text.includes("revenue")) return "revenue";
    return text.split(/\s+/).find((word) => word.length > 3) || text;
  }

  private parseExtractionJson(text: string): DataExtraction {
    try {
      return JSON.parse(text) as DataExtraction;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]) as DataExtraction;
        } catch {}
      }
    }

    return {
      record_scope: "unknown",
      summary: text || "AI parser returned unreadable output.",
      confidence: 0,
      needs_confirmation: true,
    };
  }

  private normalizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  }

  private async getUserFeatures(userId: string): Promise<Record<string, any>> {
    return (await this.getUserAccess(userId)).features;
  }

  private async getUserAccess(userId: string): Promise<{ role: string; features: Record<string, any> }> {
    const rows = await db.select({ role: users.role, enabledFeatures: users.enabledFeatures }).from(users).where(eq(users.id, userId)).limit(1);
    return {
      role: rows[0]?.role || "user",
      features: ((rows[0]?.enabledFeatures as any) || {}) as Record<string, any>,
    };
  }

  private async getSystemPrompt(userId: string): Promise<string> {
    const features = await this.getUserFeatures(userId);
    const userPrompt = String(features.dataManagementPrompt || features.dataManagementSystemPrompt || "").trim();
    if (!userPrompt) return DEFAULT_DATA_MANAGEMENT_PROMPT;

    return `${DEFAULT_DATA_MANAGEMENT_PROMPT}

User-level clinic instructions:
${userPrompt}`;
  }

  private toFileSize(value: number | string | bigint | undefined): number | null {
    if (value === undefined || value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
