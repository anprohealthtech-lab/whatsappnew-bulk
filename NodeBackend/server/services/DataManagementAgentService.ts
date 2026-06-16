import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "../db";
import { persistentFileService } from "./PersistentFileService";
import {
  dataDocuments,
  dataCaseBatches,
  dataGeneralRecords,
  dataPatientEvents,
  dataPatients,
  users,
  whatsappSessions,
} from "@shared/schema";

export type TenantContext = {
  organizationId: string;
  userId: string;
};

export type AppPatientUploadFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
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
  senderPn?: string;
  sourceMessageId?: string;
  timestamp?: number;
};

type DataWhatsAppService = {
  sendTextMessage(phoneNumber: string, message: string): Promise<any>;
  sendMediaMessage?(phoneNumber: string, filePath: string, caption?: string, fileName?: string): Promise<any>;
  getStatus?(): {
    sessionInfo?: unknown;
  };
  isAuthenticatedSelfChat?(jid?: string | null): boolean;
};

type ExtractedPatient = {
  name?: string | null;
  age?: number | null;
  gender?: string | null;
  phone?: string | null;
  dob?: string | null;
  name_source_text?: string | null;
  identity_confidence?: number | null;
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

type ClinicalObservation = {
  category: string;
  name: string;
  value?: string | null;
  numeric_value?: number | null;
  unit?: string | null;
  reference_range?: string | null;
  flag?: "normal" | "high" | "low" | "abnormal" | "critical" | "unknown" | null;
  source_text?: string | null;
  confidence?: number | null;
  needs_confirmation?: boolean;
};

type DataToolResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

type ArchivedAttachment = {
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileUrl: string;
  storageBucket: string;
  storagePath: string;
};

const DEFAULT_DATA_MANAGEMENT_PROMPT = `You are a highly accurate clinical document extraction system for a doctor's private WhatsApp/data app.

Read every visible page of report images, PDF documents, prescriptions, case papers, discharge summaries, short doctor notes, and clinical images.

Classify the input into one of:
- patient: report, prescription, discharge summary, surgery note, invoice, or any record tied to a patient.
- general: price list, package list, monthly surgery count, clinic note, inventory, revenue, or other data not tied to one patient.
- unknown: insufficient usable information.

Rules:
- Never invent missing data.
- Preserve medical values, spellings, dosage, frequency, duration, units, and reference ranges as written.
- Read printed text and handwriting separately. Transcribe every legible handwritten clinical line, including examination findings, history, assessment, investigations, advice, follow-up, and medicine instructions.
- raw_text must be a comprehensive line-by-line transcription of all clinically relevant visible text, not a short summary. Use [unclear] for an unreadable word or phrase instead of guessing or omitting the line.
- Use null for missing fields.
- Use ISO dates (YYYY-MM-DD) when visible or clearly stated.
- Set confidence from 0 to 1.
- Set needs_confirmation true when patient identity or any clinically important field is uncertain.
- Patient identity is a high-risk field. A doctor name printed in a letterhead, department roster, degree/registration block, signature, stamp, or "consultant/surgeon" line is NEVER the patient name.
- Accept a patient name only from an explicit patient-identification area such as "Patient", "Name", "Mr/Mrs/Ms", UHID/IPD/OPD label, barcode sticker, registration label, or an unambiguous message caption. Return the exact supporting text in patient.name_source_text.
- If the only visible names are clinicians, or the patient label is unreadable/ambiguous, set patient.name to null, patient.name_source_text to null, patient.identity_confidence below 0.5, and needs_confirmation to true.
- Do not describe all doctors printed on stationery as participating in the consultation. Record a clinician only when the clinical note, signature, or explicit treating-doctor field ties that clinician to this encounter.
- Put each measurable or comparable fact in emr_fields.observations. This is required for longitudinal analysis.
- Keep source_text for clinical facts so a doctor can verify them against the document.
- Put the complete clinical narrative in emr_fields.doctor_notes as well as distributing facts into the structured arrays. Do not omit a line merely because it does not fit another field.
- For numeric observations, value must not repeat unit. Example: value "95", numeric_value 95, unit "bpm"; not value "95 bpm" with unit "bpm".
- Put examination findings in emr_fields.physical_examination, grouped by body system or examined area. Preserve negative findings such as "no tenderness" and "no organomegaly".
- Set emr_fields.follow_up_date only when an exact date is printed or can be calculated unambiguously from a dated instruction. Keep the original wording in follow_up.
- For an X-ray, CT, MRI, ultrasound, ECG, wound photograph, pathology image, or other clinical image, populate imaging_analysis. Distinguish direct visual findings from text transcribed from a printed radiology report.
- Imaging analysis is preliminary decision support, not a definitive diagnosis. Describe only visible findings, image quality, limitations, and urgent warning signs. Never claim that an image is normal when quality or views are inadequate, and never invent modality, body part, laterality, or view.
- If an uploaded image is only a photographed document, prescription, or report, leave imaging_analysis null and parse it as a document.
- Do not fill missing prescription fields with defaults.
- Do not infer an ICD code unless explicitly printed or unambiguous.
- Separate tests ordered from test results.
- Include all visible pages. Do not silently ignore later PDF pages.

For patient records, return:
{
  "record_scope": "patient",
  "document_type": "case_paper|lab_report|prescription|discharge_summary|surgery_note|invoice|imaging_report|radiology_image|clinical_photo|pathology_report|procedure_note|unknown",
  "patient": {
    "name": string|null,
    "age": number|null,
    "gender": string|null,
    "phone": string|null,
    "dob": string|null,
    "name_source_text": string|null,
    "identity_confidence": number|null
  },
  "event_date": "YYYY-MM-DD"|null,
  "summary": string,
  "raw_text": string|null,
  "emr_fields": {
    "chief_complaint": string|null,
    "symptoms": [{ "name": string, "severity": string|null, "duration": string|null, "notes": string|null, "source_text": string|null }],
    "vitals": [{ "name": string, "value": string|null, "numeric_value": number|null, "unit": string|null, "source_text": string|null }],
    "physical_examination": [{ "system": string, "finding": string, "source_text": string|null, "confidence": number|null, "needs_confirmation": boolean }],
    "diagnoses": [{ "name": string, "icd10_code": string|null, "notes": string|null, "is_primary": boolean, "source_text": string|null }],
    "prescriptions": [{ "medicine": string, "dosage": string|null, "frequency": string|null, "duration": string|null, "instructions": string|null, "quantity": string|null, "source_text": string|null }],
    "tests_ordered": [{ "name": string, "type": string|null, "instructions": string|null, "urgency": string|null, "source_text": string|null }],
    "results": [{ "name": string, "value": string|null, "numeric_value": number|null, "unit": string|null, "reference_range": string|null, "flag": string|null, "source_text": string|null }],
    "procedures": [{ "name": string, "date": string|null, "notes": string|null, "source_text": string|null }],
    "allergies": [string],
    "history": [string],
    "advice": [string],
    "follow_up": string|null,
    "follow_up_date": "YYYY-MM-DD"|null,
    "doctor_notes": string|null,
    "warnings": [string],
    "imaging_analysis": {
      "analysis_type": "direct_image|report_text"|null,
      "modality": string|null,
      "body_part": string|null,
      "laterality": string|null,
      "view": string|null,
      "image_quality": string|null,
      "findings": [{ "finding": string, "location": string|null, "source_text": string|null }],
      "impression": string|null,
      "limitations": [string],
      "urgent_findings": [string],
      "comparison": string|null,
      "confidence": number|null,
      "needs_confirmation": boolean
    }|null,
    "observations": [{
      "category": "vital|lab_result|symptom|diagnosis|medicine|procedure|examination|imaging_finding|other",
      "name": string,
      "value": string|null,
      "numeric_value": number|null,
      "unit": string|null,
      "reference_range": string|null,
      "flag": "normal|high|low|abnormal|critical|unknown"|null,
      "source_text": string|null,
      "confidence": number|null,
      "needs_confirmation": boolean
    }]
  },
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

const DATA_EXTRACTION_TOOL: Anthropic.Tool = {
  name: "save_parsed_record",
  description: "Return the structured record extracted from the supplied message or document.",
  input_schema: {
    type: "object",
    properties: {
      record_scope: { type: "string", enum: ["patient", "general", "unknown"] },
      document_type: { type: ["string", "null"] },
      record_type: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
      patient: {
        type: ["object", "null"],
        properties: {
          name: { type: ["string", "null"] },
          age: { type: ["number", "null"] },
          gender: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          dob: { type: ["string", "null"] },
          name_source_text: { type: ["string", "null"] },
          identity_confidence: { type: ["number", "null"] },
        },
        required: ["name", "age", "gender", "phone", "dob", "name_source_text", "identity_confidence"],
        additionalProperties: false,
      },
      event_date: { type: ["string", "null"] },
      period_start: { type: ["string", "null"] },
      period_end: { type: ["string", "null"] },
      summary: { type: "string" },
      raw_text: { type: ["string", "null"] },
      emr_fields: { type: ["object", "null"], additionalProperties: true },
      structured_data: { type: ["object", "null"], additionalProperties: true },
      confidence: { type: "number" },
      needs_confirmation: { type: "boolean" },
    },
    required: [
      "record_scope",
      "document_type",
      "record_type",
      "title",
      "patient",
      "event_date",
      "period_start",
      "period_end",
      "summary",
      "raw_text",
      "emr_fields",
      "structured_data",
      "confidence",
      "needs_confirmation",
    ],
    additionalProperties: false,
  },
};

const DATA_QA_SYSTEM_PROMPT = `You are a private clinical data Q&A agent for a doctor on WhatsApp.

You answer only from the database tools provided. Do not invent patients, reports, prices, counts, lab values, or dates.
Use tools whenever a question asks about saved patients, reports, timelines, lab values, trends, surgeries, price lists, packages, or general clinic records.

Style:
- Be concise and WhatsApp-friendly.
- If data is missing, say exactly what is missing.
- For medical values, preserve units and dates when available.
- You may summarize clinical data, but do not give diagnosis or treatment advice beyond the saved record content.
- If multiple patients match, ask the doctor to clarify.
- If you used limited data, mention that briefly.`;

const DATA_QA_TOOLS: Anthropic.Tool[] = [
  {
    name: "count_patients",
    description: "Count saved patients in the doctor's data management records.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "search_patient",
    description: "Search saved patients by name, partial name, phone, age, or free-text query.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Patient name, phone, or search text." },
        limit: { type: "number", description: "Maximum matches to return." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_patient_timeline",
    description: "Get recent timeline events for a patient. Use patientId when known; otherwise provide patientName.",
    input_schema: {
      type: "object",
      properties: {
        patientId: { type: "string" },
        patientName: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_patient_documents",
    description: "Get parsed documents for a patient, including extracted JSON summaries. Use patientId when known; otherwise patientName.",
    input_schema: {
      type: "object",
      properties: {
        patientId: { type: "string" },
        patientName: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "search_general_records",
    description: "Search general non-patient clinic records such as surgery counts, price lists, packages, inventory, revenue, or notes.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        recordType: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_recent_updates",
    description: "Get recent saved patient timeline events and general records.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
  },
  {
    name: "find_lab_values",
    description: "Find saved lab/test values or clinical fields for a patient and test name, such as HbA1c, hemoglobin, creatinine, BP, etc.",
    input_schema: {
      type: "object",
      properties: {
        patientId: { type: "string" },
        patientName: { type: "string" },
        testName: { type: "string", description: "Lab/test/field name to search for." },
        limit: { type: "number" },
      },
      required: ["testName"],
    },
  },
  {
    name: "save_general_record",
    description: "Save a non-patient general clinic record stated by the doctor in text, such as monthly surgery count or a price/package note.",
    input_schema: {
      type: "object",
      properties: {
        recordType: { type: "string" },
        title: { type: "string" },
        rawText: { type: "string" },
        periodStart: { type: "string" },
        periodEnd: { type: "string" },
        structuredData: { type: "object" },
      },
      required: ["recordType", "title", "rawText"],
    },
  },
];

export class DataManagementAgentService {
  private anthropic: Anthropic | null = null;

  constructor(private whatsappService?: DataWhatsAppService) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }
  }

  async isEnabledForUser(userId: string): Promise<boolean> {
    const access = await this.getUserAccess(userId);
    return access.role === "super_admin" || access.features.dataManagement === true;
  }

  async shouldSilentlyIgnoreMessage(ownerUserId: string, data: IncomingDataMessage): Promise<boolean> {
    const messageType = data.messageType || "text";
    if (!["image", "document", "audio", "voice_note", "video"].includes(messageType)) return false;
    if (!await this.isEnabledForUser(ownerUserId)) return false;
    return !await this.isOwnerMessage(ownerUserId, data);
  }

  async shouldHandleMessage(ownerUserId: string, data: IncomingDataMessage): Promise<boolean> {
    const access = await this.getUserAccess(ownerUserId);
    const features = access.features;
    if (access.role !== "super_admin" && features.dataManagement !== true) return false;

    // Clinical data is private to the connected account. Never fall back to
    // accepting arbitrary senders when an allow-list is empty or misconfigured.
    if (!await this.isOwnerMessage(ownerUserId, data)) return false;

    const messageType = data.messageType || "text";
    if (["image", "document", "audio", "voice_note", "video"].includes(messageType)) return true;

    const text = (data.content || "").trim().toLowerCase();
    if (!text) return false;

    const commandPatterns = [
      /^(start|open|begin)\s+(case|batch)\b/,
      /^(done|finish case|complete case)$/i,
      /^(cancel case|cancel batch)$/i,
      /^(show current case|current case|case status)$/i,
      /^(remove last photo|remove last attachment|undo last)$/i,
      /\bhow many patients\b/,
      /\bcount patients\b/,
      /\b(patient|patients)\b/,
      /\bshow .*patient\b/,
      /\blast (report|update|document)\b/,
      /\b(report|reports|document|documents|timeline|history)\b/,
      /\b(trend|compare|abnormal|normal|high|low|value|values|test|lab|hba1c|hb|hemoglobin|creatinine|cholesterol|glucose)\b/,
      /\bprice list\b/,
      /\bsurgery\b/,
      /\b(package|price|rate|cost|charge|inventory|revenue)\b/,
      /\badd .*patient\b/,
      /\bfind patient\b/,
      /\bdata\b/,
      /\bexcel\b/,
      /\bexport (?:all )?(?:patient |clinical )?data\b/,
    ];

    return commandPatterns.some((pattern) => pattern.test(text));
  }

  async handleIncomingMessage(tenant: TenantContext, data: IncomingDataMessage): Promise<string> {
    const messageType = data.messageType || "text";
    const batchCommand = await this.handleCaseBatchCommand(tenant, data);
    if (batchCommand) return batchCommand;

    const activeBatch = await this.getActiveCaseBatch(tenant);
    if (activeBatch && ["image", "document", "audio", "voice_note", "video"].includes(messageType)) {
      return this.collectCaseBatchAttachment(tenant, data, activeBatch);
    }

    if (messageType === "image" || messageType === "document") {
      return this.processDocument(tenant, data);
    }
    if (messageType === "audio" || messageType === "voice_note" || messageType === "video") {
      return this.processAttachmentOnly(tenant, data);
    }

    if (this.isExcelExportCommand(data.content || "")) {
      try {
        return await this.exportDataToExcel(tenant, data);
      } catch (error: any) {
        console.error("[DataManagementAgentService] Excel export failed:", error?.message || error);
        return "I could not create or send the Excel export. Please try again.";
      }
    }

    const maybeSaved = await this.trySaveTextAsRecord(tenant, data);
    if (maybeSaved) return maybeSaved;

    return this.answerQuestionWithClaudeTools(tenant, data.content || "");
  }

  async processAppPatientDocuments(
    tenant: TenantContext,
    input: {
      patientId: string;
      files: AppPatientUploadFile[];
      eventDate?: string | null;
      caption?: string | null;
    },
  ): Promise<{
    batchId: string;
    patientId: string;
    patientName: string;
    uploadedCount: number;
    requestedCount: number;
    errors: string[];
  }> {
    const patient = (await db.select().from(dataPatients).where(and(
      eq(dataPatients.id, input.patientId),
      eq(dataPatients.organizationId, tenant.organizationId),
      eq(dataPatients.userId, tenant.userId),
    )).limit(1))[0];
    if (!patient) throw new Error("Patient not found");
    if (!input.files.length) throw new Error("Select at least one image or PDF");

    const batch = (await db.insert(dataCaseBatches).values({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      patientId: patient.id,
      patientNameHint: patient.canonicalName,
      status: "processing",
      expectedAttachmentCount: input.files.length,
      receivedAttachmentCount: 0,
      eventDate: input.eventDate || null,
      collectionCompletedAt: new Date(),
      processingStartedAt: new Date(),
    }).returning())[0];

    const errors: string[] = [];
    let uploadedCount = 0;
    for (let index = 0; index < input.files.length; index += 1) {
      const file = input.files[index];
      try {
        const attachment = await this.archiveAttachment(tenant, {
          phoneNumber: "",
          messageType: file.mimetype.startsWith("image/") ? "image" : "document",
          content: input.caption || undefined,
          mediaBuffer: file.buffer,
          mediaInfo: {
            mimetype: file.mimetype,
            fileName: file.originalname,
            fileLength: file.size,
            caption: input.caption || undefined,
          },
        }, {
          patientId: patient.id,
          caseBatchId: batch.id,
        });
        uploadedCount += 1;
        await db.insert(dataDocuments).values({
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          patientId: patient.id,
          source: "app_upload",
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          fileSize: attachment.fileSize,
          fileUrl: attachment.fileUrl,
          storageBucket: attachment.storageBucket,
          storagePath: attachment.storagePath,
          caseBatchId: batch.id,
          sequenceNumber: index + 1,
          caption: input.caption || null,
          documentType: file.mimetype.startsWith("image/") ? "image" : "document",
          extractedJson: {},
          status: "pending",
        });
      } catch (error: any) {
        errors.push(`${file.originalname}: ${error?.message || "Upload failed"}`);
      }
    }

    await db.update(dataCaseBatches).set({
      receivedAttachmentCount: uploadedCount,
      errorMessage: errors.length ? `${errors.length} file(s) could not be archived` : null,
      updatedAt: new Date(),
    }).where(eq(dataCaseBatches.id, batch.id));

    if (uploadedCount === 0) {
      await db.update(dataCaseBatches).set({
        status: "failed",
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(dataCaseBatches.id, batch.id));
      throw new Error(errors[0] || "No file could be uploaded");
    }

    const processingBatch = {
      ...batch,
      receivedAttachmentCount: uploadedCount,
      errorMessage: errors.length ? `${errors.length} file(s) could not be archived` : null,
    };
    void this.finalizeCaseBatch(tenant, processingBatch)
      .catch(async (error: any) => {
        console.error("[DataManagementAgentService] App batch processing failed:", error?.message || error);
        await db.update(dataCaseBatches).set({
          status: "failed",
          errorMessage: error?.message || "Batch processing failed",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(dataCaseBatches.id, batch.id));
      });

    return {
      batchId: batch.id,
      patientId: patient.id,
      patientName: patient.canonicalName,
      uploadedCount,
      requestedCount: input.files.length,
      errors,
    };
  }

  private async handleCaseBatchCommand(tenant: TenantContext, data: IncomingDataMessage): Promise<string | null> {
    if ((data.messageType || "text") !== "text") return null;
    const text = (data.content || "").trim();
    if (!text) return null;

    const start = text.match(/^(?:start|open|begin)\s+(?:case|batch)(?:\s+for)?\s+(.+)$/i);
    if (start) return this.startCaseBatch(tenant, data, start[1]);

    if (/^(?:done|finish case|complete case)$/i.test(text)) {
      return this.completeCaseBatchCollection(tenant, data);
    }
    if (/^(?:cancel case|cancel batch)$/i.test(text)) {
      return this.cancelCaseBatch(tenant);
    }
    if (/^(?:show current case|current case|case status)$/i.test(text)) {
      return this.describeCurrentCaseBatch(tenant);
    }
    if (/^(?:remove last photo|remove last attachment|undo last)$/i.test(text)) {
      return this.removeLastCaseAttachment(tenant);
    }
    return null;
  }

  private async startCaseBatch(tenant: TenantContext, data: IncomingDataMessage, details: string): Promise<string> {
    const existing = await this.getActiveCaseBatch(tenant);
    if (existing) {
      return `A case is already open for ${existing.patientNameHint} with ${existing.receivedAttachmentCount} attachment(s). Send DONE or CANCEL CASE first.`;
    }

    const expectedMatch = details.match(/(?:,|\s)\s*(\d{1,3})\s*(?:photos?|images?|attachments?|files?)\b/i);
    const ageMatch = details.match(/(?:,|\s)\s*age\s*(\d{1,3})\b/i);
    const dateMatch = details.match(/(?:,|\s)\s*(?:date|visit date)\s*(\d{4}-\d{2}-\d{2})\b/i);
    const patientName = details
      .replace(/(?:,|\s)\s*\d{1,3}\s*(?:photos?|images?|attachments?|files?)\b/ig, "")
      .replace(/(?:,|\s)\s*age\s*\d{1,3}\b/ig, "")
      .replace(/(?:,|\s)\s*(?:date|visit date)\s*\d{4}-\d{2}-\d{2}\b/ig, "")
      .replace(/^[\s,:-]+|[\s,:-]+$/g, "")
      .trim();
    if (patientName.length < 2) {
      return "Please include the patient name, for example: Start case for Ramesh Patel, age 52, 15 photos";
    }

    const patient = await this.findOrCreatePatient(tenant, {
      name: patientName,
      age: ageMatch ? Number(ageMatch[1]) : null,
      name_source_text: `WhatsApp command: ${String(data.content || "").trim()}`,
      identity_confidence: 1,
    });
    const rows = await db.insert(dataCaseBatches).values({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      patientId: patient.id,
      patientNameHint: patient.canonicalName,
      sourcePhoneNumber: data.phoneNumber,
      status: "collecting",
      expectedAttachmentCount: expectedMatch ? Number(expectedMatch[1]) : null,
      eventDate: dateMatch?.[1] || null,
    }).returning();
    const expected = rows[0].expectedAttachmentCount ? ` Expected: ${rows[0].expectedAttachmentCount}.` : "";
    return `Case opened for ${patient.canonicalName}.${expected} Send all attachments, then send DONE.`;
  }

  private async completeCaseBatchCollection(tenant: TenantContext, data: IncomingDataMessage): Promise<string> {
    const active = await this.getActiveCaseBatch(tenant);
    if (!active) return "No open case found. Send: Start case for Patient Name";
    if (active.receivedAttachmentCount === 0) return "This case has no attachments yet. Send the photos/files, then send DONE.";

    const rows = await db.update(dataCaseBatches).set({
      status: "processing",
      collectionCompletedAt: new Date(),
      processingStartedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(dataCaseBatches.id, active.id),
      eq(dataCaseBatches.organizationId, tenant.organizationId),
      eq(dataCaseBatches.userId, tenant.userId),
      eq(dataCaseBatches.status, "collecting"),
    )).returning();
    if (!rows[0]) return "This case is already being processed.";

    const replyTarget = data.replyTo || data.from || data.phoneNumber;
    void this.finalizeCaseBatch(tenant, rows[0])
      .then((message) => this.whatsappService?.sendTextMessage(replyTarget, message))
      .catch(async (error: any) => {
        console.error("[DataManagementAgentService] Batch processing failed:", error?.message || error);
        await db.update(dataCaseBatches).set({
          status: "failed",
          errorMessage: error?.message || "Batch processing failed",
          updatedAt: new Date(),
        }).where(eq(dataCaseBatches.id, active.id));
        await this.whatsappService?.sendTextMessage(replyTarget, `Case processing failed for ${active.patientNameHint}. The attachments remain saved for retry.`);
      });

    return `Received ${active.receivedAttachmentCount} attachment(s) for ${active.patientNameHint}. Processing has started; I will send the consolidated result when ready.`;
  }

  private async cancelCaseBatch(tenant: TenantContext): Promise<string> {
    const active = await this.getActiveCaseBatch(tenant);
    if (!active) return "No open case found.";
    await db.update(dataCaseBatches).set({
      status: "cancelled",
      collectionCompletedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(dataCaseBatches.id, active.id));
    return `Cancelled the open case for ${active.patientNameHint}. Its ${active.receivedAttachmentCount} saved attachment(s) were retained.`;
  }

  private async describeCurrentCaseBatch(tenant: TenantContext): Promise<string> {
    const active = await this.getActiveCaseBatch(tenant);
    if (!active) return "No case is currently collecting attachments.";
    const expected = active.expectedAttachmentCount ? ` of ${active.expectedAttachmentCount}` : "";
    return `Current case: ${active.patientNameHint}. Received ${active.receivedAttachmentCount}${expected} attachment(s). Send DONE when complete.`;
  }

  private async removeLastCaseAttachment(tenant: TenantContext): Promise<string> {
    const active = await this.getActiveCaseBatch(tenant);
    if (!active) return "No open case found.";
    const document = (await db.select().from(dataDocuments).where(and(
      eq(dataDocuments.organizationId, tenant.organizationId),
      eq(dataDocuments.userId, tenant.userId),
      eq(dataDocuments.caseBatchId, active.id),
    )).orderBy(desc(dataDocuments.sequenceNumber)).limit(1))[0];
    if (!document) return "The current case has no attachments.";

    if (document.storageBucket && document.storagePath) {
      await this.deleteArchivedAttachment(document.storageBucket, document.storagePath);
    }
    await db.delete(dataDocuments).where(eq(dataDocuments.id, document.id));
    await db.update(dataCaseBatches).set({
      receivedAttachmentCount: Math.max(0, active.receivedAttachmentCount - 1),
      updatedAt: new Date(),
    }).where(eq(dataCaseBatches.id, active.id));
    return `Removed attachment ${document.sequenceNumber || active.receivedAttachmentCount} from ${active.patientNameHint}.`;
  }

  private async getActiveCaseBatch(tenant: TenantContext) {
    return (await db.select().from(dataCaseBatches).where(and(
      eq(dataCaseBatches.organizationId, tenant.organizationId),
      eq(dataCaseBatches.userId, tenant.userId),
      eq(dataCaseBatches.status, "collecting"),
    )).orderBy(desc(dataCaseBatches.createdAt)).limit(1))[0] || null;
  }

  private async isOwnerMessage(ownerUserId: string, data: IncomingDataMessage): Promise<boolean> {
    const liveSenderIds = [data.from, data.replyTo].filter(Boolean);
    if (liveSenderIds.some((jid) => this.whatsappService?.isAuthenticatedSelfChat?.(jid))) {
      return true;
    }

    const senderTokens = this.identityTokens([
      data.phoneNumber,
      data.from,
      data.replyTo,
      data.senderPn,
    ]);
    if (senderTokens.size === 0) return false;

    const ownerValues: unknown[] = [];
    const sessionInfo = this.whatsappService?.getStatus?.().sessionInfo;
    this.collectIdentityValues(sessionInfo, ownerValues);

    const sessionRows = await db.select({ phoneNumber: whatsappSessions.phoneNumber })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.userId, ownerUserId));
    ownerValues.push(...sessionRows.map((row) => row.phoneNumber));

    const ownerTokens = this.identityTokens(ownerValues);
    if (ownerTokens.size === 0) {
      console.warn(`[DataManagementAgentService] Owner identity unavailable for user ${ownerUserId}; denying data access`);
      return false;
    }

    return Array.from(senderTokens).some((token) => ownerTokens.has(token));
  }

  private collectIdentityValues(value: unknown, output: unknown[], depth = 0): void {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number") {
      output.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.collectIdentityValues(item, output, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    for (const key of ["id", "jid", "lid", "phoneNumber", "user", "me"]) {
      if (key in record) this.collectIdentityValues(record[key], output, depth + 1);
    }
  }

  private identityTokens(values: unknown[]): Set<string> {
    const tokens = new Set<string>();
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const normalized = String(value)
        .split(":")[0]
        .replace(/@(s\.whatsapp\.net|lid)$/i, "")
        .replace(/\D/g, "");
      if (!normalized) continue;
      tokens.add(normalized);
      if (normalized.length >= 10) tokens.add(normalized.slice(-10));
    }
    return tokens;
  }

  private isExcelExportCommand(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
    return /^(excel|export excel|excel export|download excel|export (?:all )?(?:patient |clinical )?data(?: to excel)?)$/.test(normalized);
  }

  private async exportDataToExcel(tenant: TenantContext, data: IncomingDataMessage): Promise<string> {
    if (!this.whatsappService?.sendMediaMessage) {
      return "Excel export is unavailable because document sending is not configured.";
    }

    const [patients, caseBatches, events, documents, generalRecords] = await Promise.all([
      db.select().from(dataPatients).where(and(
        eq(dataPatients.organizationId, tenant.organizationId),
        eq(dataPatients.userId, tenant.userId),
      )).orderBy(dataPatients.canonicalName),
      db.select().from(dataCaseBatches).where(and(
        eq(dataCaseBatches.organizationId, tenant.organizationId),
        eq(dataCaseBatches.userId, tenant.userId),
      )).orderBy(dataCaseBatches.createdAt),
      db.select().from(dataPatientEvents).where(and(
        eq(dataPatientEvents.organizationId, tenant.organizationId),
        eq(dataPatientEvents.userId, tenant.userId),
      )).orderBy(dataPatientEvents.eventDate, dataPatientEvents.createdAt),
      db.select().from(dataDocuments).where(and(
        eq(dataDocuments.organizationId, tenant.organizationId),
        eq(dataDocuments.userId, tenant.userId),
      )).orderBy(dataDocuments.createdAt),
      db.select().from(dataGeneralRecords).where(and(
        eq(dataGeneralRecords.organizationId, tenant.organizationId),
        eq(dataGeneralRecords.userId, tenant.userId),
      )).orderBy(dataGeneralRecords.createdAt),
    ]);

    const patientById = new Map(patients.map((patient) => [patient.id, patient]));
    const observations: Record<string, unknown>[] = [];
    const prescriptions: Record<string, unknown>[] = [];
    const diagnoses: Record<string, unknown>[] = [];

    const eventRows = events.map((event) => {
      const patient = patientById.get(event.patientId);
      const structured = this.asRecord(event.structuredData);
      const common = {
        Patient_ID: event.patientId,
        Patient_Name: patient?.canonicalName || "",
        Event_Date: event.eventDate || this.dateCell(event.createdAt),
        Event_Type: event.eventType,
        Document_ID: event.documentId || "",
      };

      for (const observation of this.asRecordArray(structured.observations)) {
        observations.push({
          ...common,
          Category: observation.category,
          Field_Name: observation.name,
          Value: observation.value,
          Numeric_Value: observation.numeric_value,
          Unit: observation.unit,
          Reference_Range: observation.reference_range,
          Flag: observation.flag,
          Confidence: observation.confidence,
          Needs_Confirmation: Boolean(observation.needs_confirmation),
          Source_Text: observation.source_text,
        });
      }
      for (const prescription of this.asRecordArray(structured.prescriptions)) {
        prescriptions.push({
          ...common,
          Medicine: prescription.medicine,
          Dosage: prescription.dosage,
          Frequency: prescription.frequency,
          Duration: prescription.duration,
          Instructions: prescription.instructions,
          Quantity: prescription.quantity,
          Source_Text: prescription.source_text,
        });
      }
      for (const diagnosis of this.asRecordArray(structured.diagnoses)) {
        diagnoses.push({
          ...common,
          Diagnosis: diagnosis.name,
          ICD10_Code: diagnosis.icd10_code,
          Is_Primary: Boolean(diagnosis.is_primary),
          Notes: diagnosis.notes,
          Source_Text: diagnosis.source_text,
        });
      }

      return {
        ...common,
        Summary: event.summary,
        Chief_Complaint: structured.chief_complaint,
        Follow_Up: structured.follow_up,
        Follow_Up_Date: structured.follow_up_date,
        Physical_Examination: this.jsonCell(structured.physical_examination),
        Doctor_Notes: structured.doctor_notes,
        Imaging_Analysis: this.jsonCell(structured.imaging_analysis),
        Advice: this.joinCell(structured.advice),
        Allergies: this.joinCell(structured.allergies),
        History: this.joinCell(structured.history),
        Warnings: this.joinCell(structured.warnings),
        Created_At: this.dateTimeCell(event.createdAt),
      };
    });

    const observationMatrix = new Map<string, Record<string, unknown>>();
    for (const observation of observations) {
      const patientId = String(observation.Patient_ID || "");
      const category = String(observation.Category || "other");
      const fieldName = String(observation.Field_Name || "");
      const eventDate = String(observation.Event_Date || "Unknown date");
      if (!fieldName) continue;

      const key = `${patientId}|${category}|${fieldName.toLowerCase()}`;
      const row = observationMatrix.get(key) || {
        Patient_ID: patientId,
        Patient_Name: observation.Patient_Name,
        Category: category,
        Field_Name: fieldName,
      };
      const value = observation.Value || (observation.Numeric_Value ?? "");
      const display = [
        value,
        observation.Unit,
        observation.Flag && observation.Flag !== "unknown" ? `(${observation.Flag})` : "",
        observation.Needs_Confirmation ? "[verify]" : "",
      ].filter(Boolean).join(" ");
      row[eventDate] = row[eventDate] ? `${row[eventDate]} | ${display}` : display;
      observationMatrix.set(key, row);
    }

    const workbook = XLSX.utils.book_new();
    this.appendExcelSheet(workbook, "Patients", patients.map((patient) => ({
      Patient_ID: patient.id,
      Patient_Name: patient.canonicalName,
      Age: patient.age,
      Gender: patient.gender,
      DOB: patient.dob,
      Phone_Numbers: this.joinCell(patient.phoneNumbers),
      Aliases: this.joinCell(patient.aliases),
      Latest_Summary: patient.summary,
      First_Seen: this.dateTimeCell(patient.firstSeenAt),
      Last_Updated: this.dateTimeCell(patient.lastUpdatedAt),
    })));
    this.appendExcelSheet(workbook, "Case Batches", caseBatches.map((batch) => ({
      Case_Batch_ID: batch.id,
      Patient_ID: batch.patientId,
      Patient_Name: batch.patientNameHint,
      Status: batch.status,
      Expected_Attachments: batch.expectedAttachmentCount,
      Received_Attachments: batch.receivedAttachmentCount,
      Event_Date: batch.eventDate,
      Summary: batch.summary,
      Error: batch.errorMessage,
      Started_At: this.dateTimeCell(batch.startedAt),
      Completed_At: this.dateTimeCell(batch.completedAt),
    })));
    this.appendExcelSheet(workbook, "Timeline", eventRows);
    this.appendExcelSheet(workbook, "Observations", observations);
    this.appendExcelSheet(workbook, "Observation Matrix", Array.from(observationMatrix.values()));
    this.appendExcelSheet(workbook, "Prescriptions", prescriptions);
    this.appendExcelSheet(workbook, "Diagnoses", diagnoses);
    this.appendExcelSheet(workbook, "Documents", documents.map((document) => ({
      Document_ID: document.id,
      Patient_ID: document.patientId,
      Patient_Name: document.patientId ? patientById.get(document.patientId)?.canonicalName || "" : "",
      Document_Type: document.documentType,
      File_Name: document.fileName,
      MIME_Type: document.mimeType,
      File_URL: document.fileUrl,
      Storage_Bucket: document.storageBucket,
      Storage_Path: document.storagePath,
      Case_Batch_ID: document.caseBatchId,
      Sequence_Number: document.sequenceNumber,
      Caption: document.caption,
      Status: document.status,
      Confidence: document.confidence,
      Received_At: this.dateTimeCell(document.receivedAt),
      Processed_At: this.dateTimeCell(document.processedAt),
      Error: document.errorMessage,
      OCR_Text: document.ocrText,
      Extracted_JSON: this.jsonCell(document.extractedJson),
    })));
    this.appendExcelSheet(workbook, "General Records", generalRecords.map((record) => ({
      Record_ID: record.id,
      Record_Type: record.recordType,
      Title: record.title,
      Period_Start: record.periodStart,
      Period_End: record.periodEnd,
      Raw_Text: record.rawText,
      Confidence: record.confidence,
      Structured_Data: this.jsonCell(record.structuredData),
      Created_At: this.dateTimeCell(record.createdAt),
    })));

    const dateStamp = new Date().toISOString().slice(0, 10);
    const fileName = `patient-data-${dateStamp}.xlsx`;
    const workbookBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
    const savedFile = await persistentFileService.saveFile({
      originalname: fileName,
      size: workbookBuffer.length,
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: workbookBuffer,
    });
    const target = data.replyTo || data.from || data.phoneNumber;

    try {
      await this.whatsappService.sendMediaMessage(
        target,
        savedFile.filePath,
        `Clinical data export: ${patients.length} patients, ${events.length} timeline events, ${observations.length} observations.`,
        fileName,
      );
    } catch (error) {
      await persistentFileService.deleteFile(savedFile.fileName);
      throw error;
    }

    const cleanupTimer = setTimeout(() => {
      void persistentFileService.deleteFile(savedFile.fileName);
    }, 5 * 60 * 1000);
    cleanupTimer.unref?.();

    return `Excel sent with ${patients.length} patients, ${events.length} timeline events, and ${observations.length} analysis-ready observations.`;
  }

  private appendExcelSheet(workbook: XLSX.WorkBook, name: string, rows: Record<string, unknown>[]): void {
    const safeRows = (rows.length ? rows : [{ Status: "No records" }]).map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, this.safeExcelCell(value)])),
    );
    const sheet = XLSX.utils.json_to_sheet(safeRows);
    const headers = Object.keys(safeRows[0]);
    sheet["!cols"] = headers.map((header) => ({
      wch: Math.min(60, Math.max(12, header.length + 2)),
    }));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }

  private safeExcelCell(value: unknown): string | number | boolean {
    if (value === null || value === undefined) return "";
    if (typeof value === "number" || typeof value === "boolean") return value;
    const text = typeof value === "string" ? value : this.jsonCell(value);
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
  }

  private joinCell(value: unknown): string {
    if (!Array.isArray(value)) return this.nullableString(value) || "";
    return value.map((item) => typeof item === "string" ? item : this.jsonCell(item)).filter(Boolean).join(" | ");
  }

  private jsonCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private dateCell(value: Date | string | null | undefined): string {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
  }

  private dateTimeCell(value: Date | string | null | undefined): string {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }

  private async processDocument(tenant: TenantContext, data: IncomingDataMessage): Promise<string> {
    if (await this.findDocumentBySourceMessage(tenant, data.sourceMessageId)) {
      return "That attachment is already saved.";
    }
    if (!data.mediaData) {
      await db.insert(dataDocuments).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        sourcePhoneNumber: data.phoneNumber,
        sourceMessageId: data.sourceMessageId || null,
        fileName: data.mediaInfo?.fileName || null,
        mimeType: data.mediaInfo?.mimetype || null,
        fileSize: this.toFileSize(data.mediaInfo?.fileLength),
        status: "failed",
        errorMessage: "WhatsApp media download failed",
      });
      return "I received the file, but could not download it for parsing. Please resend it.";
    }

    let attachment: ArchivedAttachment;
    try {
      attachment = await this.archiveAttachment(tenant, data);
    } catch (error: any) {
      const errorMessage = error?.message || "Attachment storage upload failed";
      await db.insert(dataDocuments).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        sourcePhoneNumber: data.phoneNumber,
        sourceMessageId: data.sourceMessageId || null,
        fileName: data.mediaInfo?.fileName || this.defaultAttachmentName(data),
        mimeType: data.mediaInfo?.mimetype || "application/octet-stream",
        fileSize: this.toFileSize(data.mediaInfo?.fileLength),
        status: "failed",
        errorMessage,
      });
      console.error("[DataManagementAgentService] Attachment archive failed:", errorMessage);
      return "I received the attachment, but could not save it to secure storage, so I did not process it. Please try again.";
    }

    const extraction = await this.extractStructuredData(tenant, data);
    return this.persistExtraction(tenant, data, extraction, attachment);
  }

  private async collectCaseBatchAttachment(
    tenant: TenantContext,
    data: IncomingDataMessage,
    batch: typeof dataCaseBatches.$inferSelect,
  ): Promise<string> {
    if (!data.mediaData && !data.mediaBuffer) {
      return "I received the attachment, but could not download it. Please resend it.";
    }

    if (data.sourceMessageId) {
      const duplicate = (await db.select({ id: dataDocuments.id, sequenceNumber: dataDocuments.sequenceNumber })
        .from(dataDocuments)
        .where(and(
          eq(dataDocuments.organizationId, tenant.organizationId),
          eq(dataDocuments.userId, tenant.userId),
          eq(dataDocuments.sourceMessageId, data.sourceMessageId),
        )).limit(1))[0];
      if (duplicate) {
        return `That attachment is already saved as item ${duplicate.sequenceNumber || "?"}.`;
      }
    }

    const attachment = await this.archiveAttachment(tenant, data, {
      patientId: batch.patientId,
      caseBatchId: batch.id,
    });
    try {
      const updated = (await db.update(dataCaseBatches).set({
        receivedAttachmentCount: sql`${dataCaseBatches.receivedAttachmentCount} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(dataCaseBatches.id, batch.id),
        eq(dataCaseBatches.status, "collecting"),
      )).returning())[0];
      if (!updated) {
        await this.deleteArchivedAttachment(attachment.storageBucket, attachment.storagePath);
        return "This case was already closed; the attachment was not added.";
      }

      const sequenceNumber = updated.receivedAttachmentCount;
      await db.insert(dataDocuments).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        patientId: batch.patientId,
        sourcePhoneNumber: data.phoneNumber,
        sourceMessageId: data.sourceMessageId || null,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileSize: attachment.fileSize,
        fileUrl: attachment.fileUrl,
        storageBucket: attachment.storageBucket,
        storagePath: attachment.storagePath,
        caseBatchId: batch.id,
        sequenceNumber,
        caption: data.mediaInfo?.caption || data.content || null,
        documentType: data.messageType || "attachment",
        extractedJson: {},
        status: "pending",
      });
      const expected = updated.expectedAttachmentCount ? ` of ${updated.expectedAttachmentCount}` : "";
      return `Received attachment ${sequenceNumber}${expected} for ${batch.patientNameHint}. Send DONE when all files are uploaded.`;
    } catch (error) {
      await this.deleteArchivedAttachment(attachment.storageBucket, attachment.storagePath);
      await db.update(dataCaseBatches).set({
        receivedAttachmentCount: sql`GREATEST(${dataCaseBatches.receivedAttachmentCount} - 1, 0)`,
        updatedAt: new Date(),
      }).where(eq(dataCaseBatches.id, batch.id));
      throw error;
    }
  }

  private async finalizeCaseBatch(
    tenant: TenantContext,
    batch: typeof dataCaseBatches.$inferSelect,
  ): Promise<string> {
    const patient = (await db.select().from(dataPatients).where(and(
      eq(dataPatients.id, batch.patientId),
      eq(dataPatients.organizationId, tenant.organizationId),
      eq(dataPatients.userId, tenant.userId),
    )).limit(1))[0];
    if (!patient) throw new Error("Batch patient no longer exists");

    const documents = await db.select().from(dataDocuments).where(and(
      eq(dataDocuments.organizationId, tenant.organizationId),
      eq(dataDocuments.userId, tenant.userId),
      eq(dataDocuments.caseBatchId, batch.id),
    )).orderBy(dataDocuments.sequenceNumber);
    const parsed: Array<{ document: typeof dataDocuments.$inferSelect; extraction: DataExtraction }> = [];
    let failedCount = 0;

    for (const document of documents) {
      if (!document.storageBucket || !document.storagePath) {
        failedCount += 1;
        await db.update(dataDocuments).set({
          status: "failed",
          errorMessage: "Stored attachment path is missing",
          processedAt: new Date(),
        }).where(eq(dataDocuments.id, document.id));
        continue;
      }

      try {
        const buffer = await this.downloadArchivedAttachment(document.storageBucket, document.storagePath);
        const extraction = await this.extractStructuredData(tenant, {
          phoneNumber: batch.sourcePhoneNumber || "",
          messageType: document.mimeType?.startsWith("image/") ? "image" : "document",
          content: [
            `This is attachment ${document.sequenceNumber || "?"} in one multi-file case for patient ${patient.canonicalName}.`,
            "Use this explicit batch patient identity; do not replace it with names printed elsewhere.",
            document.caption ? `Original caption: ${document.caption}` : "",
          ].filter(Boolean).join("\n"),
          mediaInfo: {
            mimetype: document.mimeType || "application/octet-stream",
            fileName: document.fileName || undefined,
            fileLength: document.fileSize || undefined,
            caption: document.caption || undefined,
          },
          mediaBuffer: buffer,
          mediaData: buffer.toString("base64"),
          sourceMessageId: document.sourceMessageId || undefined,
        });
        extraction.record_scope = "patient";
        extraction.patient = {
          ...(extraction.patient || {}),
          name: patient.canonicalName,
          age: patient.age,
          gender: patient.gender,
          dob: patient.dob,
          name_source_text: `Batch command for ${patient.canonicalName}`,
          identity_confidence: 1,
        };
        extraction.needs_confirmation = Boolean(extraction.needs_confirmation);

        await db.update(dataDocuments).set({
          patientId: patient.id,
          documentType: extraction.document_type || document.documentType || "unknown",
          ocrText: extraction.raw_text || null,
          extractedJson: extraction as any,
          confidence: extraction.confidence || null,
          status: extraction.needs_confirmation ? "needs_review" : "processed",
          errorMessage: null,
          processedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(dataDocuments.id, document.id));
        parsed.push({ document, extraction });
      } catch (error: any) {
        failedCount += 1;
        await db.update(dataDocuments).set({
          status: "failed",
          errorMessage: error?.message || "Attachment parsing failed",
          processedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(dataDocuments.id, document.id));
      }
    }

    if (parsed.length === 0) throw new Error("No attachment could be parsed");

    const consolidated = await this.consolidateCaseBatch(tenant, patient, batch, parsed);
    const sourceDocuments = parsed.map(({ document, extraction }) => ({
      document_id: document.id,
      sequence_number: document.sequenceNumber,
      file_name: document.fileName,
      document_type: extraction.document_type,
      confidence: extraction.confidence,
    }));
    const structuredData = {
      ...(consolidated.emr_fields || consolidated.structured_data || {}),
      case_batch_id: batch.id,
      source_documents: sourceDocuments,
    };
    const eventDate = batch.eventDate || consolidated.event_date || null;
    const summary = consolidated.summary || `Consolidated ${parsed.length}-attachment case for ${patient.canonicalName}.`;

    await db.insert(dataPatientEvents).values({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      patientId: patient.id,
      documentId: parsed[0].document.id,
      eventType: "case_batch",
      eventDate,
      summary,
      structuredData: structuredData as any,
    });
    await db.update(dataPatients).set({
      age: consolidated.patient?.age ?? patient.age,
      gender: consolidated.patient?.gender || patient.gender,
      dob: consolidated.patient?.dob || patient.dob,
      summary,
      lastUpdatedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(dataPatients.id, patient.id));

    const expectedMismatch = Boolean(
      batch.expectedAttachmentCount
      && batch.expectedAttachmentCount !== documents.length,
    );
    const needsReview = failedCount > 0 || expectedMismatch || Boolean(consolidated.needs_confirmation);
    await db.update(dataCaseBatches).set({
      status: needsReview ? "needs_review" : "completed",
      summary,
      errorMessage: failedCount ? `${failedCount} attachment(s) failed parsing` : null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(dataCaseBatches.id, batch.id));

    const reviewNote = needsReview
      ? ` Review needed${failedCount ? `: ${failedCount} attachment(s) failed` : ""}${expectedMismatch ? `; expected ${batch.expectedAttachmentCount}, received ${documents.length}` : ""}.`
      : "";
    return `Completed case for ${patient.canonicalName}: ${parsed.length} attachment(s) consolidated into one visit.${reviewNote} Summary: ${summary}`;
  }

  private async processAttachmentOnly(tenant: TenantContext, data: IncomingDataMessage): Promise<string> {
    if (await this.findDocumentBySourceMessage(tenant, data.sourceMessageId)) {
      return "That attachment is already saved.";
    }
    if (!data.mediaData && !data.mediaBuffer) {
      return "I received the attachment, but could not download it for secure storage. Please resend it.";
    }

    try {
      const attachment = await this.archiveAttachment(tenant, data);
      await db.insert(dataDocuments).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        sourcePhoneNumber: data.phoneNumber,
        sourceMessageId: data.sourceMessageId || null,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileSize: attachment.fileSize,
        fileUrl: attachment.fileUrl,
        storageBucket: attachment.storageBucket,
        storagePath: attachment.storagePath,
        caption: data.mediaInfo?.caption || data.content || null,
        documentType: data.messageType || "attachment",
        extractedJson: {},
        confidence: null,
        status: "processed",
        processedAt: new Date(),
      });
      return `Saved ${data.messageType || "attachment"} securely.`;
    } catch (error: any) {
      const errorMessage = error?.message || "Attachment storage upload failed";
      await db.insert(dataDocuments).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        sourcePhoneNumber: data.phoneNumber,
        sourceMessageId: data.sourceMessageId || null,
        fileName: data.mediaInfo?.fileName || this.defaultAttachmentName(data),
        mimeType: data.mediaInfo?.mimetype || "application/octet-stream",
        fileSize: this.toFileSize(data.mediaInfo?.fileLength),
        documentType: data.messageType || "attachment",
        status: "failed",
        errorMessage,
      });
      console.error("[DataManagementAgentService] Attachment archive failed:", errorMessage);
      return "I received the attachment, but could not save it to secure storage. Please try again.";
    }
  }

  private async findDocumentBySourceMessage(tenant: TenantContext, sourceMessageId?: string) {
    if (!sourceMessageId) return null;
    return (await db.select().from(dataDocuments).where(and(
      eq(dataDocuments.organizationId, tenant.organizationId),
      eq(dataDocuments.userId, tenant.userId),
      eq(dataDocuments.sourceMessageId, sourceMessageId),
    )).limit(1))[0] || null;
  }

  private async consolidateCaseBatch(
    tenant: TenantContext,
    patient: typeof dataPatients.$inferSelect,
    batch: typeof dataCaseBatches.$inferSelect,
    parsed: Array<{ document: typeof dataDocuments.$inferSelect; extraction: DataExtraction }>,
  ): Promise<DataExtraction> {
    const fallback = this.mergeCaseBatchExtractions(patient, batch, parsed.map((item) => item.extraction));
    if (!this.anthropic) return fallback;

    const source = parsed.map(({ document, extraction }) => ({
      sequence_number: document.sequenceNumber,
      document_id: document.id,
      file_name: document.fileName,
      extraction,
    }));
    try {
      const response = await this.anthropic.messages.create({
        model: process.env.DATA_AGENT_MODEL || "claude-sonnet-4-6",
        max_tokens: 8000,
        system: await this.getSystemPrompt(tenant.userId),
        tools: [DATA_EXTRACTION_TOOL],
        tool_choice: { type: "tool", name: DATA_EXTRACTION_TOOL.name },
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: [
              `Consolidate these separately parsed attachments into one clinical visit for ${patient.canonicalName}.`,
              `The patient identity was explicitly supplied by the doctor in the batch command. Event date hint: ${batch.eventDate || "none"}.`,
              "Deduplicate repeated facts. Preserve conflicting values as separate observations with source_text. Do not invent facts.",
              "Return one complete patient extraction. Include all examination findings, advice, medicines, tests, results, imaging findings, and doctor notes.",
              JSON.stringify(source),
            ].join("\n"),
          }],
        }],
      } as any);
      const toolUse = response.content.find(
        (block: any) => block.type === "tool_use" && block.name === DATA_EXTRACTION_TOOL.name,
      ) as Anthropic.ToolUseBlock | undefined;
      if (!toolUse?.input || typeof toolUse.input !== "object") return fallback;

      const consolidated = toolUse.input as DataExtraction;
      consolidated.record_scope = "patient";
      consolidated.patient = {
        ...(consolidated.patient || {}),
        name: patient.canonicalName,
        age: consolidated.patient?.age ?? patient.age,
        gender: consolidated.patient?.gender || patient.gender,
        dob: consolidated.patient?.dob || patient.dob,
        name_source_text: `Batch command for ${patient.canonicalName}`,
        identity_confidence: 1,
      };
      consolidated.event_date = batch.eventDate || consolidated.event_date || null;
      return this.normalizeExtraction(consolidated);
    } catch (error: any) {
      console.warn("[DataManagementAgentService] Batch consolidation fallback:", error?.message || error);
      return fallback;
    }
  }

  private mergeCaseBatchExtractions(
    patient: typeof dataPatients.$inferSelect,
    batch: typeof dataCaseBatches.$inferSelect,
    extractions: DataExtraction[],
  ): DataExtraction {
    const emrSources = extractions.map((item) => this.asRecord(item.emr_fields));
    const uniqueRecords = (field: string) => {
      const seen = new Set<string>();
      return emrSources.flatMap((source) => this.asRecordArray(source[field])).filter((item) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const uniqueStrings = (field: string) => Array.from(new Set(
      emrSources.flatMap((source) => this.stringArray(source[field])),
    ));
    const joined = (field: string) => Array.from(new Set(
      emrSources.map((source) => this.nullableString(source[field])).filter((value): value is string => Boolean(value)),
    )).join("\n") || null;
    const imaging = emrSources
      .map((source) => this.asRecord(source.imaging_analysis))
      .filter((value) => Object.keys(value).length);

    return this.normalizeExtraction({
      record_scope: "patient",
      document_type: extractions.length === 1 ? extractions[0].document_type : "case_paper",
      patient: {
        name: patient.canonicalName,
        age: patient.age,
        gender: patient.gender,
        phone: null,
        dob: patient.dob,
        name_source_text: `Batch command for ${patient.canonicalName}`,
        identity_confidence: 1,
      },
      event_date: batch.eventDate || extractions.find((item) => item.event_date)?.event_date || null,
      summary: extractions.map((item) => item.summary).filter(Boolean).join(" "),
      raw_text: extractions.map((item, index) => `Attachment ${index + 1}\n${item.raw_text || ""}`).join("\n\n"),
      emr_fields: {
        chief_complaint: joined("chief_complaint"),
        symptoms: uniqueRecords("symptoms"),
        vitals: uniqueRecords("vitals"),
        physical_examination: uniqueRecords("physical_examination"),
        diagnoses: uniqueRecords("diagnoses"),
        prescriptions: uniqueRecords("prescriptions"),
        tests_ordered: uniqueRecords("tests_ordered"),
        results: uniqueRecords("results"),
        procedures: uniqueRecords("procedures"),
        allergies: uniqueStrings("allergies"),
        history: uniqueStrings("history"),
        advice: uniqueStrings("advice"),
        follow_up: joined("follow_up"),
        follow_up_date: emrSources.map((source) => this.isoDateString(source.follow_up_date)).find(Boolean) || null,
        doctor_notes: joined("doctor_notes"),
        warnings: uniqueStrings("warnings"),
        imaging_analysis: imaging.length === 1 ? imaging[0] : imaging.length ? { studies: imaging, needs_confirmation: true } : null,
        observations: uniqueRecords("observations"),
      },
      confidence: Math.min(...extractions.map((item) => Number(item.confidence) || 0)),
      needs_confirmation: extractions.some((item) => item.needs_confirmation),
    });
  }

  private async archiveAttachment(
    tenant: TenantContext,
    data: IncomingDataMessage,
    batchContext?: { patientId: string; caseBatchId: string },
  ): Promise<ArchivedAttachment> {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    const storageBucket = process.env.DATA_ATTACHMENTS_BUCKET || "ocruploads";
    if (!supabaseUrl || !serviceKey) {
      throw new Error("Supabase attachment storage is not configured");
    }

    const buffer = data.mediaBuffer || (data.mediaData ? Buffer.from(data.mediaData, "base64") : null);
    if (!buffer?.length) throw new Error("Attachment data is empty");

    const mimeType = data.mediaInfo?.mimetype || "application/octet-stream";
    const originalName = data.mediaInfo?.fileName || this.defaultAttachmentName(data);
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "attachment";
    const date = new Date(data.timestamp || Date.now());
    const datePath = Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`;
    const storagePath = [
      tenant.organizationId,
      tenant.userId,
      "clinical-attachments",
      batchContext?.patientId || "unassigned",
      batchContext?.caseBatchId || datePath,
      uniqueName,
    ].map((part) => encodeURIComponent(part)).join("/");

    const response = await fetch(
      `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(storageBucket)}/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          "Content-Type": mimeType,
          "x-upsert": "false",
        },
        body: buffer,
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Storage upload failed (${response.status}): ${detail}`);
    }

    return {
      fileName: originalName,
      mimeType,
      fileSize: buffer.length,
      storageBucket,
      storagePath: decodeURIComponent(storagePath),
      fileUrl: `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/authenticated/${encodeURIComponent(storageBucket)}/${storagePath}`,
    };
  }

  private async downloadArchivedAttachment(storageBucket: string, storagePath: string): Promise<Buffer> {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!supabaseUrl || !serviceKey) throw new Error("Supabase attachment storage is not configured");
    const objectPath = storagePath.split("/").map((part) => encodeURIComponent(part)).join("/");
    const response = await fetch(
      `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(storageBucket)}/${objectPath}`,
      { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } },
    );
    if (!response.ok) throw new Error(`Stored attachment download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async deleteArchivedAttachment(storageBucket: string, storagePath: string): Promise<void> {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!supabaseUrl || !serviceKey) return;
    const objectPath = storagePath.split("/").map((part) => encodeURIComponent(part)).join("/");
    const response = await fetch(
      `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(storageBucket)}/${objectPath}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
      },
    );
    if (!response.ok && response.status !== 404) {
      console.warn(`[DataManagementAgentService] Storage delete failed (${response.status}) for ${storagePath}`);
    }
  }

  private defaultAttachmentName(data: IncomingDataMessage): string {
    const mimeType = data.mediaInfo?.mimetype || "";
    const extensionByMime: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/heic": "heic",
      "image/heif": "heif",
      "application/pdf": "pdf",
      "audio/ogg": "ogg",
      "audio/mpeg": "mp3",
      "audio/mp4": "m4a",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
    };
    const extension = extensionByMime[mimeType.toLowerCase()] || "bin";
    return `${data.messageType || "attachment"}-${data.timestamp || Date.now()}.${extension}`;
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
        .where(and(
          eq(dataPatientEvents.organizationId, tenant.organizationId),
          eq(dataPatientEvents.userId, tenant.userId),
          eq(dataPatientEvents.patientId, patient.id),
        ))
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

  private async answerQuestionWithClaudeTools(tenant: TenantContext, question: string): Promise<string> {
    const text = question.trim();
    if (!text) return "Please send a data question, patient name, or report.";

    if (!this.anthropic) {
      return this.answerDataQuestion(tenant, text);
    }

    const systemPrompt = await this.getQuestionSystemPrompt(tenant.userId);
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Doctor question: ${text}`,
      },
    ];

    try {
      let response = await this.anthropic.messages.create({
        model: process.env.DATA_AGENT_MODEL || "claude-sonnet-4-6",
        max_tokens: 1200,
        system: systemPrompt,
        tools: DATA_QA_TOOLS,
        messages,
      });

      let rounds = 0;
      while (response.stop_reason === "tool_use" && rounds < 6) {
        rounds += 1;
        const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUses) {
          console.log(`[DataManagementAgentService] Claude tool requested: ${toolUse.name} input=${JSON.stringify(toolUse.input || {})}`);
          const result = await this.executeDataTool(tenant, toolUse.name, (toolUse.input || {}) as Record<string, unknown>);
          console.log(`[DataManagementAgentService] Claude tool result: ${toolUse.name} success=${result.success}${result.error ? ` error=${result.error}` : ""}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        }

        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });

        response = await this.anthropic.messages.create({
          model: process.env.DATA_AGENT_MODEL || "claude-sonnet-4-6",
          max_tokens: 1200,
          system: systemPrompt,
          tools: DATA_QA_TOOLS,
          messages,
        });
      }

      const answer = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      return answer || "I checked the saved data, but could not form an answer.";
    } catch (error: any) {
      console.error("[DataManagementAgentService] Claude Q&A failed:", error?.message || error);
      return this.answerDataQuestion(tenant, text);
    }
  }

  private async executeDataTool(tenant: TenantContext, toolName: string, input: Record<string, unknown>): Promise<DataToolResult> {
    try {
      switch (toolName) {
        case "count_patients": {
          const rows = await db
            .select({ count: sql<number>`count(*)` })
            .from(dataPatients)
            .where(and(eq(dataPatients.organizationId, tenant.organizationId), eq(dataPatients.userId, tenant.userId)));
          return { success: true, data: { count: Number(rows[0]?.count || 0) } };
        }

        case "search_patient": {
          const query = String(input.query || "").trim();
          const limit = this.limitNumber(input.limit, 10, 1, 25);
          const patients = await this.searchPatients(tenant, query, limit);
          return { success: true, data: patients };
        }

        case "get_patient_timeline": {
          const patient = await this.resolvePatientForTool(tenant, input);
          if (!patient) return { success: false, error: "Patient not found" };
          const limit = this.limitNumber(input.limit, 8, 1, 25);
          const events = await db.select().from(dataPatientEvents)
            .where(and(
              eq(dataPatientEvents.organizationId, tenant.organizationId),
              eq(dataPatientEvents.userId, tenant.userId),
              eq(dataPatientEvents.patientId, patient.id),
            ))
            .orderBy(desc(dataPatientEvents.createdAt))
            .limit(limit);
          return { success: true, data: { patient: this.publicPatient(patient), events } };
        }

        case "get_patient_documents": {
          const patient = await this.resolvePatientForTool(tenant, input);
          if (!patient) return { success: false, error: "Patient not found" };
          const limit = this.limitNumber(input.limit, 8, 1, 25);
          const documents = await db.select().from(dataDocuments)
            .where(and(
              eq(dataDocuments.organizationId, tenant.organizationId),
              eq(dataDocuments.userId, tenant.userId),
              eq(dataDocuments.patientId, patient.id),
            ))
            .orderBy(desc(dataDocuments.createdAt))
            .limit(limit);
          return { success: true, data: { patient: this.publicPatient(patient), documents: this.compactDocuments(documents) } };
        }

        case "search_general_records": {
          const query = String(input.query || "").trim();
          const recordType = String(input.recordType || "").trim();
          const limit = this.limitNumber(input.limit, 8, 1, 25);
          const conditions = [
            eq(dataGeneralRecords.organizationId, tenant.organizationId),
            eq(dataGeneralRecords.userId, tenant.userId),
          ];
          if (recordType) conditions.push(eq(dataGeneralRecords.recordType, recordType));
          if (query) conditions.push(sql`(
            ${dataGeneralRecords.title} ILIKE ${`%${query}%`}
            OR ${dataGeneralRecords.rawText} ILIKE ${`%${query}%`}
            OR ${dataGeneralRecords.recordType} ILIKE ${`%${query}%`}
            OR ${dataGeneralRecords.structuredData}::text ILIKE ${`%${query}%`}
          )` as any);
          const records = await db.select().from(dataGeneralRecords)
            .where(and(...conditions))
            .orderBy(desc(dataGeneralRecords.createdAt))
            .limit(limit);
          return { success: true, data: records };
        }

        case "get_recent_updates": {
          const limit = this.limitNumber(input.limit, 8, 1, 25);
          const [events, records] = await Promise.all([
            db.select().from(dataPatientEvents)
              .where(and(eq(dataPatientEvents.organizationId, tenant.organizationId), eq(dataPatientEvents.userId, tenant.userId)))
              .orderBy(desc(dataPatientEvents.createdAt))
              .limit(limit),
            db.select().from(dataGeneralRecords)
              .where(and(eq(dataGeneralRecords.organizationId, tenant.organizationId), eq(dataGeneralRecords.userId, tenant.userId)))
              .orderBy(desc(dataGeneralRecords.createdAt))
              .limit(limit),
          ]);
          return { success: true, data: { patientEvents: events, generalRecords: records } };
        }

        case "find_lab_values": {
          const patient = await this.resolvePatientForTool(tenant, input);
          if (!patient) return { success: false, error: "Patient not found" };
          const testName = String(input.testName || "").trim();
          if (!testName) return { success: false, error: "testName is required" };
          const limit = this.limitNumber(input.limit, 10, 1, 30);
          const matches = await this.findLabValueMatches(tenant, patient.id, testName, limit);
          return { success: true, data: { patient: this.publicPatient(patient), testName, matches } };
        }

        case "save_general_record": {
          const title = String(input.title || "").trim();
          const rawText = String(input.rawText || "").trim();
          const recordType = String(input.recordType || "general_note").trim() || "general_note";
          if (!title || !rawText) return { success: false, error: "title and rawText are required" };
          const rows = await db.insert(dataGeneralRecords).values({
            organizationId: tenant.organizationId,
            userId: tenant.userId,
            recordType,
            title,
            rawText,
            periodStart: typeof input.periodStart === "string" ? input.periodStart : null,
            periodEnd: typeof input.periodEnd === "string" ? input.periodEnd : null,
            structuredData: (input.structuredData && typeof input.structuredData === "object" ? input.structuredData : {}) as any,
            confidence: 1,
          }).returning();
          return { success: true, data: rows[0] };
        }

        default:
          return { success: false, error: `Unknown tool: ${toolName}` };
      }
    } catch (error: any) {
      return { success: false, error: error?.message || "Tool execution failed" };
    }
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
      model: process.env.DATA_AGENT_MODEL || "claude-sonnet-4-6",
      max_tokens: 8000,
      system: await this.getSystemPrompt(tenant.userId),
      tools: [DATA_EXTRACTION_TOOL],
      tool_choice: { type: "tool", name: DATA_EXTRACTION_TOOL.name },
      messages: [{ role: "user", content: contentBlocks }],
    } as any);

    const toolUse = response.content.find(
      (block: any) => block.type === "tool_use" && block.name === DATA_EXTRACTION_TOOL.name,
    ) as Anthropic.ToolUseBlock | undefined;
    if (toolUse?.input && typeof toolUse.input === "object") {
      return this.normalizeExtraction(toolUse.input as DataExtraction);
    }

    const text = response.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n")
      .trim();

    return this.normalizeExtraction(this.parseExtractionJson(text));
  }

  private async persistExtraction(
    tenant: TenantContext,
    data: IncomingDataMessage,
    extraction: DataExtraction,
    attachment?: ArchivedAttachment,
  ): Promise<string> {
    const attachmentValues = attachment ? {
      sourceMessageId: data.sourceMessageId || null,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      fileUrl: attachment.fileUrl,
      storageBucket: attachment.storageBucket,
      storagePath: attachment.storagePath,
      caption: data.mediaInfo?.caption || data.content || null,
    } : {
      sourceMessageId: data.sourceMessageId || null,
      fileName: data.mediaInfo?.fileName || null,
      mimeType: data.mediaInfo?.mimetype || null,
      fileSize: this.toFileSize(data.mediaInfo?.fileLength),
      caption: data.mediaInfo?.caption || data.content || null,
    };

    if (extraction.record_scope === "patient") {
      const patientName = extraction.patient?.name?.trim();
      if (!patientName) {
        await db.insert(dataDocuments).values({
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          sourcePhoneNumber: data.phoneNumber,
          ...attachmentValues,
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
        ...attachmentValues,
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
        .where(and(
          eq(dataPatients.id, patient.id),
          eq(dataPatients.organizationId, tenant.organizationId),
          eq(dataPatients.userId, tenant.userId),
        ));

      return `Saved ${extraction.document_type || "document"} for ${patient.canonicalName}. Summary: ${extraction.summary || "No summary extracted."}`;
    }

    if (extraction.record_scope === "general") {
      const documentRows = await db.insert(dataDocuments).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        sourcePhoneNumber: data.phoneNumber,
        ...attachmentValues,
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
      ...attachmentValues,
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

  private async searchPatients(tenant: TenantContext, query: string, limit: number) {
    const normalizedQuery = this.normalizeName(query);
    const rows = await db.select().from(dataPatients).where(and(
      eq(dataPatients.organizationId, tenant.organizationId),
      eq(dataPatients.userId, tenant.userId),
    )).orderBy(desc(dataPatients.updatedAt)).limit(200);

    const scored = rows
      .map((patient) => {
        const haystack = [
          patient.canonicalName,
          patient.age,
          patient.gender,
          patient.summary,
          JSON.stringify(patient.phoneNumbers || []),
          JSON.stringify(patient.aliases || []),
          JSON.stringify(patient.metadata || {}),
        ].join(" ").toLowerCase();
        const normalizedName = this.normalizeName(patient.canonicalName);
        let score = 0;
        if (!query) score = 1;
        else if (normalizedName === normalizedQuery) score = 100;
        else if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) score = 80;
        else if (haystack.includes(query.toLowerCase())) score = 50;
        return { patient, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => this.publicPatient(item.patient));

    return scored;
  }

  private async resolvePatientForTool(tenant: TenantContext, input: Record<string, unknown>) {
    const patientId = typeof input.patientId === "string" ? input.patientId.trim() : "";
    if (patientId) {
      const rows = await db.select().from(dataPatients).where(and(
        eq(dataPatients.organizationId, tenant.organizationId),
        eq(dataPatients.userId, tenant.userId),
        eq(dataPatients.id, patientId),
      )).limit(1);
      if (rows[0]) return rows[0];
    }

    const patientName = typeof input.patientName === "string" ? input.patientName.trim() : "";
    if (patientName) return this.findPatientByName(tenant, patientName);

    return null;
  }

  private publicPatient(patient: typeof dataPatients.$inferSelect) {
    return {
      id: patient.id,
      name: patient.canonicalName,
      age: patient.age,
      gender: patient.gender,
      phoneNumbers: patient.phoneNumbers,
      dob: patient.dob,
      summary: patient.summary,
      firstSeenAt: patient.firstSeenAt,
      lastUpdatedAt: patient.lastUpdatedAt,
    };
  }

  private compactDocuments(documents: Array<typeof dataDocuments.$inferSelect>) {
    return documents.map((document) => ({
      id: document.id,
      fileName: document.fileName,
      documentType: document.documentType,
      status: document.status,
      confidence: document.confidence,
      receivedAt: document.receivedAt,
      processedAt: document.processedAt,
      ocrText: this.truncateText(document.ocrText || "", 1200),
      extractedJson: document.extractedJson,
    }));
  }

  private async findLabValueMatches(tenant: TenantContext, patientId: string, testName: string, limit: number) {
    const needle = this.normalizeName(testName);
    const [events, documents] = await Promise.all([
      db.select().from(dataPatientEvents).where(and(
        eq(dataPatientEvents.organizationId, tenant.organizationId),
        eq(dataPatientEvents.userId, tenant.userId),
        eq(dataPatientEvents.patientId, patientId),
      )).orderBy(desc(dataPatientEvents.createdAt)).limit(100),
      db.select().from(dataDocuments).where(and(
        eq(dataDocuments.organizationId, tenant.organizationId),
        eq(dataDocuments.userId, tenant.userId),
        eq(dataDocuments.patientId, patientId),
      )).orderBy(desc(dataDocuments.createdAt)).limit(100),
    ]);

    const matches: Array<Record<string, unknown>> = [];

    for (const event of events) {
      const text = JSON.stringify(event.structuredData || {});
      if (this.normalizeName(text).includes(needle)) {
        matches.push({
          source: "timeline_event",
          id: event.id,
          date: event.eventDate || event.createdAt,
          summary: event.summary,
          structuredData: event.structuredData,
        });
      }
      if (matches.length >= limit) return matches;
    }

    for (const document of documents) {
      const text = [document.ocrText || "", JSON.stringify(document.extractedJson || {})].join(" ");
      if (this.normalizeName(text).includes(needle)) {
        matches.push({
          source: "document",
          id: document.id,
          fileName: document.fileName,
          documentType: document.documentType,
          date: document.processedAt || document.createdAt,
          extractedJson: document.extractedJson,
          ocrText: this.truncateText(document.ocrText || "", 1200),
        });
      }
      if (matches.length >= limit) return matches;
    }

    return matches;
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

  private normalizeExtraction(input: DataExtraction): DataExtraction {
    const scope = ["patient", "general", "unknown"].includes(input.record_scope)
      ? input.record_scope
      : "unknown";
    const confidence = Math.max(0, Math.min(1, Number(input.confidence) || 0));

    if (scope !== "patient") {
      return {
        ...input,
        record_scope: scope,
        confidence,
        needs_confirmation: scope === "unknown" ? true : Boolean(input.needs_confirmation),
      };
    }

    const source = this.asRecord(input.emr_fields);
    const results = this.asRecordArray(source.results);
    const vitals = this.asRecordArray(source.vitals);
    const patient = input.patient ? { ...input.patient } : input.patient;
    if (patient) {
      const identityConfidence = typeof patient.identity_confidence === "number"
        ? Math.max(0, Math.min(1, patient.identity_confidence))
        : null;
      patient.identity_confidence = identityConfidence;

      const name = patient.name?.trim() || "";
      const identitySource = patient.name_source_text?.trim() || "";
      const clinicianSource = /(?:^|\b)dr\.?\s|consultant|surgeon|neurosurg|m\.?\s*ch|dnb|reg(?:istration)?\s*no/i;
      if (/^dr\.?\s/i.test(name) || clinicianSource.test(identitySource)) {
        patient.name = null;
        patient.name_source_text = null;
        patient.identity_confidence = 0;
      }
    }
    const observations = this.asRecordArray(source.observations)
      .map((value) => this.normalizeObservation(value))
      .filter((value): value is ClinicalObservation => Boolean(value));

    for (const vital of vitals) {
      const observation = this.normalizeObservation({ ...vital, category: "vital" });
      if (observation && !this.hasObservation(observations, observation)) observations.push(observation);
    }
    for (const result of results) {
      const observation = this.normalizeObservation({ ...result, category: "lab_result" });
      if (observation && !this.hasObservation(observations, observation)) observations.push(observation);
    }
    for (const symptom of this.asRecordArray(source.symptoms)) {
      const observation = this.normalizeObservation({
        category: "symptom",
        name: symptom.name,
        value: [symptom.severity, symptom.duration].filter(Boolean).join(", ") || symptom.notes,
        source_text: symptom.source_text,
        needs_confirmation: false,
      });
      if (observation && !this.hasObservation(observations, observation)) observations.push(observation);
    }
    for (const diagnosis of this.asRecordArray(source.diagnoses)) {
      const observation = this.normalizeObservation({
        category: "diagnosis",
        name: diagnosis.name,
        value: diagnosis.notes,
        source_text: diagnosis.source_text,
        needs_confirmation: false,
      });
      if (observation && !this.hasObservation(observations, observation)) observations.push(observation);
    }
    for (const prescription of this.asRecordArray(source.prescriptions)) {
      const observation = this.normalizeObservation({
        category: "medicine",
        name: prescription.medicine,
        value: [prescription.dosage, prescription.frequency, prescription.duration, prescription.instructions]
          .filter(Boolean)
          .join(" | "),
        source_text: prescription.source_text,
        needs_confirmation: false,
      });
      if (observation && !this.hasObservation(observations, observation)) observations.push(observation);
    }
    for (const procedure of this.asRecordArray(source.procedures)) {
      const observation = this.normalizeObservation({
        category: "procedure",
        name: procedure.name,
        value: [procedure.date, procedure.notes].filter(Boolean).join(" | "),
        source_text: procedure.source_text,
        needs_confirmation: false,
      });
      if (observation && !this.hasObservation(observations, observation)) observations.push(observation);
    }
    const physicalExamination = this.asRecordArray(source.physical_examination);
    for (const examination of physicalExamination) {
      const observation = this.normalizeObservation({
        category: "examination",
        name: examination.system || "Physical examination",
        value: examination.finding,
        source_text: examination.source_text,
        confidence: examination.confidence,
        needs_confirmation: examination.needs_confirmation,
      });
      if (observation && !this.hasObservation(observations, observation)) observations.push(observation);
    }
    const imagingAnalysis = this.asRecord(source.imaging_analysis);
    for (const finding of this.asRecordArray(imagingAnalysis.findings)) {
      const observation = this.normalizeObservation({
        category: "imaging_finding",
        name: [imagingAnalysis.modality, imagingAnalysis.body_part].filter(Boolean).join(" ") || "Imaging finding",
        value: [finding.finding, finding.location].filter(Boolean).join(" | "),
        source_text: finding.source_text,
        confidence: imagingAnalysis.confidence,
        needs_confirmation: imagingAnalysis.needs_confirmation ?? true,
      });
      if (observation && !this.hasObservation(observations, observation)) observations.push(observation);
    }

    return {
      ...input,
      record_scope: "patient",
      patient,
      confidence,
      needs_confirmation: Boolean(input.needs_confirmation)
        || !patient?.name_source_text
        || (typeof patient?.identity_confidence === "number" && patient.identity_confidence < 0.75),
      emr_fields: {
        chief_complaint: this.nullableString(source.chief_complaint),
        symptoms: this.asRecordArray(source.symptoms),
        vitals,
        physical_examination: physicalExamination,
        diagnoses: this.asRecordArray(source.diagnoses),
        prescriptions: this.asRecordArray(source.prescriptions),
        tests_ordered: this.asRecordArray(source.tests_ordered),
        results,
        procedures: this.asRecordArray(source.procedures),
        allergies: this.stringArray(source.allergies),
        history: this.stringArray(source.history),
        advice: this.stringArray(source.advice),
        follow_up: this.nullableString(source.follow_up),
        follow_up_date: this.isoDateString(source.follow_up_date),
        doctor_notes: this.nullableString(source.doctor_notes),
        warnings: this.stringArray(source.warnings),
        imaging_analysis: Object.keys(imagingAnalysis).length ? imagingAnalysis : null,
        observations,
        schema_version: "clinical-record-v2",
      },
    };
  }

  private normalizeObservation(value: Record<string, unknown>): ClinicalObservation | null {
    const name = this.nullableString(value.name);
    if (!name) return null;
    const allowedFlags = new Set(["normal", "high", "low", "abnormal", "critical", "unknown"]);
    const flag = this.nullableString(value.flag)?.toLowerCase() || null;
    const numericValue = typeof value.numeric_value === "number" && Number.isFinite(value.numeric_value)
      ? value.numeric_value
      : null;

    return {
      category: this.nullableString(value.category) || "other",
      name,
      value: this.nullableString(value.value),
      numeric_value: numericValue,
      unit: this.nullableString(value.unit),
      reference_range: this.nullableString(value.reference_range),
      flag: flag && allowedFlags.has(flag) ? flag as ClinicalObservation["flag"] : null,
      source_text: this.nullableString(value.source_text),
      confidence: typeof value.confidence === "number"
        ? Math.max(0, Math.min(1, value.confidence))
        : null,
      needs_confirmation: Boolean(value.needs_confirmation),
    };
  }

  private hasObservation(existing: ClinicalObservation[], candidate: ClinicalObservation): boolean {
    const key = `${candidate.category}|${this.normalizeName(candidate.name)}|${candidate.value || ""}|${candidate.numeric_value ?? ""}`;
    return existing.some((item) =>
      `${item.category}|${this.normalizeName(item.name)}|${item.value || ""}|${item.numeric_value ?? ""}` === key,
    );
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private asRecordArray(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  }

  private nullableString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private isoDateString(value: unknown): string | null {
    const date = this.nullableString(value);
    return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
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

  private async getQuestionSystemPrompt(userId: string): Promise<string> {
    const features = await this.getUserFeatures(userId);
    const userPrompt = String(features.dataManagementPrompt || features.dataManagementSystemPrompt || "").trim();
    if (!userPrompt) return DATA_QA_SYSTEM_PROMPT;

    return `${DATA_QA_SYSTEM_PROMPT}

User-level clinic instructions:
${userPrompt}`;
  }

  private limitNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
  }

  private toFileSize(value: number | string | bigint | undefined): number | null {
    if (value === undefined || value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
