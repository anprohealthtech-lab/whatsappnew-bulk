import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, integer, boolean as pgBoolean, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(), // bcrypt hash
  email: text("email").unique(),
  organizationId: text("organization_id").default("default_org").notNull(),
  role: text("role").default("user").notNull(), // 'super_admin' | 'admin' | 'user'
  enabledFeatures: jsonb("enabled_features").default({ taskManagement: false, himsChatbot: false, voiceAgent: false }),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Per-user WhatsApp sessions
export const whatsappSessions = pgTable("whatsapp_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  organizationId: text("organization_id").default("default_org").notNull(),
  phoneNumber: text("phone_number"), // linked WhatsApp number once authenticated
  sessionName: text("session_name").default("default").notNull(),
  status: text("status").default("disconnected").notNull(), // 'disconnected' | 'connecting' | 'qr_pending' | 'connected'
  lastConnectedAt: timestamp("last_connected_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  phoneNumber: text("phone_number").notNull(),
  content: text("content").notNull(),
  type: text("type").notNull(), // 'text', 'report', 'image'
  status: text("status").notNull().default("pending"), // 'pending', 'sent', 'delivered', 'failed'
  fileUrl: text("file_url"),
  fileName: text("file_name"),
  fileSize: integer("file_size"),
  sampleId: text("sample_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  sentAt: timestamp("sent_at"),
  deliveredAt: timestamp("delivered_at"),
});

export const systemLogs = pgTable("system_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  level: text("level").notNull(), // 'info', 'warning', 'error'
  message: text("message").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const campaigns = pgTable("campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  name: text("name").notNull(),
  campaignType: text("campaign_type").default("campaign").notNull(), // 'campaign' | 'template'
  originalMessage: text("original_message").notNull(),
  fixedParams: jsonb("fixed_params"),
  selectedVariation: text("selected_variation"),
  buttons: jsonb("buttons"), // Array of { text: string; url?: string; phoneNumber?: string }
  includeStopButton: text("include_stop_button").default("false"), // "true" or "false"
  totalContacts: integer("total_contacts").default(0),
  attachmentPath: text("attachment_path"),
  attachmentName: text("attachment_name"),
  attachmentPaths: jsonb("attachment_paths"), // Array of file paths (up to 5) for random pick
  attachmentFileNames: jsonb("attachment_file_names"), // Array of custom filenames (up to 5) for random pick
  runStatus: text("run_status").default("idle").notNull(), // idle | running | paused | completed | failed | stopped
  defaultIntervalSeconds: integer("default_interval_seconds").default(25),
  defaultJitterSeconds: integer("default_jitter_seconds").default(0),
  runStartedAt: timestamp("run_started_at"),
  runPausedAt: timestamp("run_paused_at"),
  runCompletedAt: timestamp("run_completed_at"),
  runUpdatedAt: timestamp("run_updated_at"),
  lastRunSummary: jsonb("last_run_summary"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const campaignSchedules = pgTable("campaign_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  variationMessage: text("variation_message").notNull(),
  status: text("status").default("scheduled").notNull(), // scheduled | running | completed | failed | cancelled
  intervalSeconds: integer("interval_seconds").default(25).notNull(),
  jitterSeconds: integer("jitter_seconds").default(0).notNull(),
  startFromContact: integer("start_from_contact"),
  scheduledAt: timestamp("scheduled_at").notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  resultSummary: jsonb("result_summary"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const userRagAgents = pgTable("user_rag_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  agentName: text("agent_name").notNull(),
  ragBaseUrl: text("rag_base_url").notNull(),
  ragAccessKey: text("rag_access_key").notNull(),
  systemPrompt: text("system_prompt"),
  triggerKeywords: jsonb("trigger_keywords"), // per-user override: array of strings
  greetingMessage: text("greeting_message"), // per-user override: custom greeting for new leads
  contextMessageCount: integer("context_message_count"),
  replyCooldownSeconds: integer("reply_cooldown_seconds"),
  typingDelayMs: integer("typing_delay_ms"),
  // Intake mode: when "true", the bot engages ANY inbound message from a
  // non-lead (asks what they want and answers via RAG) instead of only
  // responding when a trigger keyword matches.
  intakeMode: text("intake_mode").default("false").notNull(),
  // Follow-up scheduling: when "true", the bot may emit a follow-up directive
  // (<<FOLLOWUP:2d:message>>) that gets queued in lead_followups and sent later.
  followupsEnabled: text("followups_enabled").default("false").notNull(),
  // Auto-sequence: when "true", the bot turns its OWN system prompt (which the
  // user writes as a plain-language workflow, e.g. "day 1 send X, day 2 send Y")
  // into a timed message sequence and schedules it on every new lead. The
  // generated sequence is cached in sequenceTemplate so it is produced once, not
  // per lead. Reuses the same lead_followups scheduling as the pipeline drip.
  autoSequenceEnabled: text("auto_sequence_enabled").default("false").notNull(),
  sequenceTemplate: jsonb("sequence_template"), // [{ delay: "1d", message: "..." }]
  isActive: text("is_active").default("true").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// A named lead pipeline: ties an external data source (Google Sheet via Apps
// Script webhook) to an optional bot flow (ragAgentId). Leads ingested through
// the pipeline's token are tagged with its id on the contact.
export const leadPipelines = pgTable("lead_pipelines", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  name: text("name").notNull(),
  ragAgentId: varchar("rag_agent_id"), // optional link to a user_rag_agents flow
  ingestToken: text("ingest_token").notNull().unique(), // secret for the webhook
  // Drip sequence: when enabled, a new lead in this pipeline is auto-scheduled a
  // sequence of messages. dripPrompt is the natural-language instruction; the LLM
  // turns it into dripTemplate (array of {delay, message}) once, reused per lead.
  dripEnabled: text("drip_enabled").default("false").notNull(),
  dripPrompt: text("drip_prompt"),
  dripTemplate: jsonb("drip_template"), // [{ delay: "4h", message: "..." }]
  isActive: text("is_active").default("true").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Bot-scheduled follow-up messages to a lead. Written by ChatbotService when the
// bot emits a <<FOLLOWUP:...>> directive; drained by LeadFollowupService's tick.
export const leadFollowups = pgTable("lead_followups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  phoneNumber: text("phone_number").notNull(),
  message: text("message").notNull(),
  status: text("status").default("scheduled").notNull(), // scheduled | sent | cancelled | failed
  scheduledAt: timestamp("scheduled_at").notNull(),
  sentAt: timestamp("sent_at"),
  errorReason: text("error_reason"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const userNotificationRecipients = pgTable("user_notification_recipients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  phoneNumber: text("phone_number").notNull(),
  label: text("label"),
  notifyOnLeadCreated: text("notify_on_lead_created").default("true").notNull(),
  notifyOnDemoScheduled: text("notify_on_demo_scheduled").default("true").notNull(),
  notifyOnBookingConfirmed: text("notify_on_booking_confirmed").default("true").notNull(),
  isActive: text("is_active").default("true").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const campaignRecipients = pgTable("campaign_recipients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  extra: jsonb("extra"),
  status: text("status").default("pending"), // 'pending', 'sent', 'failed'
  sentAt: timestamp("sent_at"),
  errorReason: text("error_reason"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const messageVariations = pgTable("message_variations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  message: text("message").notNull(),
  originalMessage: text("original_message"),
  variationNumber: integer("variation_number"),
  fixedParams: jsonb("fixed_params"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const blockedNumbers = pgTable("blocked_numbers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  phoneNumber: text("phone_number").notNull(),
  reason: text("reason").default("user_requested"), // 'user_requested', 'spam', 'admin_blocked'
  blockedAt: timestamp("blocked_at").defaultNow(),
});

export const autoResponses = pgTable("auto_responses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  keyword: text("keyword").notNull(),
  response: text("response").notNull(),
  isActive: text("is_active").default("true").notNull(), // "true" or "false"
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const contacts = pgTable("contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  phoneNumber: text("phone_number").notNull(),
  name: text("name"),
  isLead: text("is_lead").default("false").notNull(), // "true" or "false"
  leadTriggerKeyword: text("lead_trigger_keyword"),
  leadStage: text("lead_stage").default("new_lead").notNull(), // new_lead | qualified | enrolled | no_response | follow_up | lost
  pipelineId: varchar("pipeline_id"), // which lead pipeline this contact belongs to (if ingested via one)
  leadStageReason: text("lead_stage_reason"),
  leadStageUpdatedAt: timestamp("lead_stage_updated_at").defaultNow(),
  leadScore: integer("lead_score").default(0),
  chatbotActive: text("chatbot_active").default("true").notNull(), // "true" or "false" - can pause chatbot per lead
  userType: text("user_type"), // null, "lead", "hr_admin" - determines which chatbot handles
  conversationState: jsonb("conversation_state"),
  lastMessageAt: timestamp("last_message_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// HR Admin users - links WhatsApp number to Task Management app users
export const hrAdmins = pgTable("hr_admins", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumber: text("phone_number").notNull().unique(),
  name: text("name"),
  // Task Management app integration
  organizationId: text("organization_id").notNull(), // Supabase organization ID
  userId: text("user_id").notNull(), // Supabase user ID  
  whatsappUserId: text("whatsapp_user_id"), // WhatsApp backend user/session owner
  organizationName: text("organization_name"), // Cached org name
  // Chatbot settings
  chatbotActive: text("chatbot_active").default("true").notNull(), // "true" or "false"
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// HR Chatbot configuration - separate from lead chatbot
export const hrChatbotConfigs = pgTable("hr_chatbot_configs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentName: text("agent_name").notNull(),
  ragBaseUrl: text("rag_base_url").notNull(), // DO AI Agent endpoint
  ragAccessKey: text("rag_access_key").notNull(),
  // Supabase integration for function calling
  supabaseUrl: text("supabase_url").notNull(),
  supabaseServiceKey: text("supabase_service_key").notNull(), // Service role key for edge functions
  contextMessageCount: integer("context_message_count").default(5),
  isActive: text("is_active").default("true").notNull(), // "true" or "false"
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const chatbotConfigs = pgTable("chatbot_configs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentName: text("agent_name").notNull(),
  triggerKeywords: jsonb("trigger_keywords").notNull(), // array of strings
  ragBaseUrl: text("rag_base_url").notNull(),
  ragAccessKey: text("rag_access_key").notNull(),
  systemPrompt: text("system_prompt"), // System prompt for RAG agent personality & rules
  greetingMessage: text("greeting_message"), // Custom greeting for new leads
  contextMessageCount: integer("context_message_count").default(5),
  replyCooldownSeconds: integer("reply_cooldown_seconds").default(8), // Min gap between bot replies
  typingDelayMs: integer("typing_delay_ms").default(2000), // Simulate typing before reply
  isActive: text("is_active").default("true").notNull(), // "true" or "false"
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Demo schedules — manual demo booking from NodeBackend UI
export const demoSchedules = pgTable("demo_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  phoneNumber: text("phone_number").notNull(),
  contactName: text("contact_name"),
  meetingLink: text("meeting_link").notNull(),
  demoAt: timestamp("demo_at").notNull(), // UTC — converted from IST at insert time
  remind30SentAt: timestamp("remind_30_sent_at"),
  remind15SentAt: timestamp("remind_15_sent_at"),
  remind5SentAt: timestamp("remind_5_sent_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Connection session history — tracks connect/disconnect events for auditing
export const sessionConnectionHistory = pgTable("session_connection_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionName: text("session_name").notNull(),
  event: text("event").notNull(), // 'connected' | 'disconnected' | 'qr_pending' | 'auth_failure' | 'reconnecting'
  reason: text("reason"), // disconnect reason code/label, e.g. 'loggedOut', 'connectionLost', 'user_requested_disconnect'
  statusCode: integer("status_code"), // Baileys DisconnectReason numeric code
  phoneNumber: text("phone_number"), // linked WhatsApp number (if known)
  sessionDurationSeconds: integer("session_duration_seconds"), // duration of the session that just ended
  metadata: jsonb("metadata"), // extra info (waVersion, browser, etc.)
  createdAt: timestamp("created_at").defaultNow(),
});

// Baileys auth state stored in DB (survives ephemeral filesystem deploys)
export const baileysAuthKeys = pgTable("baileys_auth_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: text("session_id").notNull(),       // e.g. "user_5::My Session"
  category: text("category").notNull(),           // "creds" | "pre-key" | "session" | "sender-key" | etc.
  keyId: text("key_id").notNull(),                // key identifier (e.g. "creds" or the specific key id)
  data: jsonb("data").notNull(),                  // serialised JSON via BufferJSON
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// HIMS patient users — links WhatsApp number to HIMS (Hospital Information Management System)
// organizationId is the HIMS org ID, used for all DO→Edge function calls (get appointments, doctors, etc.)
export const himsPatients = pgTable("hims_patients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumber: text("phone_number").notNull().unique(),
  name: text("name"),
  organizationId: text("organization_id").notNull(), // HIMS organization ID — same as HIMS app org
  systemPrompt: text("system_prompt"),               // Optional per-org/doctor system prompt override
  triggerKeywords: jsonb("trigger_keywords"),         // Keywords that trigger HIMS chatbot (e.g. ["appointment", "book", "doctor"])
  greetingMessage: text("greeting_message"),          // Greeting sent when patient first triggers chatbot
  chatbotActive: text("chatbot_active").default("true").notNull(), // "true" or "false"
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const voiceProviderCredentials = pgTable("voice_provider_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  credentialType: text("credential_type").notNull(),
  name: text("name").notNull(),
  encryptedSecret: text("encrypted_secret").notNull(),
  accountId: text("account_id"),
  settings: jsonb("settings").default({}),
  isPlatformManaged: pgBoolean("is_platform_managed").default(false).notNull(),
  status: text("status").default("active").notNull(),
  lastVerifiedAt: timestamp("last_verified_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const voiceProfiles = pgTable("voice_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  credentialId: varchar("credential_id").notNull().references(() => voiceProviderCredentials.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  referenceId: text("reference_id"),
  model: text("model"),
  language: text("language"),
  audioFormat: text("audio_format").default("mp3").notNull(),
  settings: jsonb("settings").default({}),
  status: text("status").default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const voiceAgents = pgTable("voice_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  status: text("status").default("active").notNull(),
  systemPrompt: text("system_prompt"),
  languageMode: text("language_mode").default("match_speaker").notNull(),
  responseMode: text("response_mode").default("voice").notNull(),
  defaultFlowKey: text("default_flow_key"),
  ragAgentId: varchar("rag_agent_id").references(() => userRagAgents.id, { onDelete: "set null" }),
  sttCredentialId: varchar("stt_credential_id").references(() => voiceProviderCredentials.id, { onDelete: "set null" }),
  voiceProfileId: varchar("voice_profile_id").references(() => voiceProfiles.id, { onDelete: "set null" }),
  widgetSettings: jsonb("widget_settings").default({
    title: "Ask our AI assistant",
    welcomeMessage: "Tap the microphone and ask a question.",
    accentColor: "#6d5dfc",
    avatarUrl: null,
    starterText: "Hello! Ask me anything and I will do my best to help.",
    starterAudioUrl: null,
    starterAudioMimeType: null,
  }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const voiceFlows = pgTable("voice_flows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  voiceAgentId: varchar("voice_agent_id").references(() => voiceAgents.id, { onDelete: "cascade" }),
  flowKey: text("flow_key").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  version: integer("version").notNull(),
  status: text("status").default("draft").notNull(),
  startNode: text("start_node").notNull(),
  definition: jsonb("definition").notNull(),
  voiceProfileId: varchar("voice_profile_id").references(() => voiceProfiles.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const voiceGatewayDevices = pgTable("voice_gateway_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  deviceType: text("device_type").notNull(), // windows | android
  pairingCode: text("pairing_code"),
  deviceTokenHash: text("device_token_hash"),
  pairedDeviceId: varchar("paired_device_id"),
  phoneNumber: text("phone_number"),
  capabilities: jsonb("capabilities").default({}),
  status: text("status").default("offline").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const voiceCampaigns = pgTable("voice_campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  voiceAgentId: varchar("voice_agent_id").notNull().references(() => voiceAgents.id, { onDelete: "cascade" }),
  flowId: varchar("flow_id").notNull().references(() => voiceFlows.id, { onDelete: "restrict" }),
  gatewayDeviceId: varchar("gateway_device_id").references(() => voiceGatewayDevices.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  status: text("status").default("draft").notNull(),
  timezone: text("timezone").default("Asia/Kolkata").notNull(),
  maxAttempts: integer("max_attempts").default(1).notNull(),
  retryDelayMinutes: integer("retry_delay_minutes").default(30).notNull(),
  settings: jsonb("settings").default({}),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const voiceCampaignContacts = pgTable("voice_campaign_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  campaignId: varchar("campaign_id").notNull().references(() => voiceCampaigns.id, { onDelete: "cascade" }),
  name: text("name"),
  phoneNumber: text("phone_number").notNull(),
  variables: jsonb("variables").default({}),
  consentStatus: text("consent_status").default("confirmed").notNull(),
  status: text("status").default("queued").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at").defaultNow(),
  lastOutcome: text("last_outcome"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const voiceCallSessions = pgTable("voice_call_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  campaignId: varchar("campaign_id").references(() => voiceCampaigns.id, { onDelete: "set null" }),
  contactId: varchar("contact_id").references(() => voiceCampaignContacts.id, { onDelete: "set null" }),
  voiceAgentId: varchar("voice_agent_id").references(() => voiceAgents.id, { onDelete: "set null" }),
  flowId: varchar("flow_id").references(() => voiceFlows.id, { onDelete: "set null" }),
  gatewayDeviceId: varchar("gateway_device_id").references(() => voiceGatewayDevices.id, { onDelete: "set null" }),
  phoneNumber: text("phone_number").notNull(),
  direction: text("direction").default("outbound").notNull(),
  transport: text("transport").default("windows_bluetooth").notNull(),
  status: text("status").default("queued").notNull(),
  transcript: jsonb("transcript").default([]),
  outcome: text("outcome"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  connectedAt: timestamp("connected_at"),
  endedAt: timestamp("ended_at"),
  durationSeconds: integer("duration_seconds").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const voiceUsage = pgTable("voice_usage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  callSessionId: varchar("call_session_id").references(() => voiceCallSessions.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(),
  quantity: real("quantity").notNull(),
  unit: text("unit").notNull(),
  provider: text("provider"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export const dataPatients = pgTable("data_patients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  canonicalName: text("canonical_name").notNull(),
  aliases: jsonb("aliases").default([]),
  age: integer("age"),
  gender: text("gender"),
  phoneNumbers: jsonb("phone_numbers").default([]),
  dob: text("dob"),
  summary: text("summary"),
  metadata: jsonb("metadata").default({}),
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastUpdatedAt: timestamp("last_updated_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const dataCaseBatches = pgTable("data_case_batches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  patientId: varchar("patient_id").notNull().references(() => dataPatients.id, { onDelete: 'cascade' }),
  patientNameHint: text("patient_name_hint").notNull(),
  sourcePhoneNumber: text("source_phone_number"),
  status: text("status").default("collecting").notNull(),
  expectedAttachmentCount: integer("expected_attachment_count"),
  receivedAttachmentCount: integer("received_attachment_count").default(0).notNull(),
  eventDate: text("event_date"),
  summary: text("summary"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at").defaultNow(),
  collectionCompletedAt: timestamp("collection_completed_at"),
  processingStartedAt: timestamp("processing_started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const dataDocuments = pgTable("data_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  patientId: varchar("patient_id").references(() => dataPatients.id, { onDelete: 'set null' }),
  source: text("source").default("whatsapp").notNull(),
  sourcePhoneNumber: text("source_phone_number"),
  sourceMessageId: text("source_message_id"),
  fileName: text("file_name"),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  fileUrl: text("file_url"),
  storageBucket: text("storage_bucket"),
  storagePath: text("storage_path"),
  caseBatchId: varchar("case_batch_id").references(() => dataCaseBatches.id, { onDelete: 'set null' }),
  sequenceNumber: integer("sequence_number"),
  caption: text("caption"),
  documentType: text("document_type").default("unknown").notNull(),
  ocrText: text("ocr_text"),
  extractedJson: jsonb("extracted_json").default({}),
  confidence: real("confidence"),
  status: text("status").default("processed").notNull(),
  errorMessage: text("error_message"),
  receivedAt: timestamp("received_at").defaultNow(),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const dataPatientEvents = pgTable("data_patient_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  patientId: varchar("patient_id").notNull().references(() => dataPatients.id, { onDelete: 'cascade' }),
  documentId: varchar("document_id").references(() => dataDocuments.id, { onDelete: 'set null' }),
  eventType: text("event_type").default("document_received").notNull(),
  eventDate: text("event_date"),
  summary: text("summary").notNull(),
  structuredData: jsonb("structured_data").default({}),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const dataGeneralRecords = pgTable("data_general_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: text("organization_id").default("default_org").notNull(),
  userId: text("user_id").default("default_user").notNull(),
  documentId: varchar("document_id").references(() => dataDocuments.id, { onDelete: 'set null' }),
  recordType: text("record_type").default("general_note").notNull(),
  title: text("title").notNull(),
  periodStart: text("period_start"),
  periodEnd: text("period_end"),
  rawText: text("raw_text"),
  structuredData: jsonb("structured_data").default({}),
  confidence: real("confidence"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  email: true,
  organizationId: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
  sentAt: true,
  deliveredAt: true,
});

export const insertSystemLogSchema = createInsertSchema(systemLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertSystemLog = z.infer<typeof insertSystemLogSchema>;
export type SystemLog = typeof systemLogs.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type MessageVariation = typeof messageVariations.$inferSelect;
export type CampaignSchedule = typeof campaignSchedules.$inferSelect;
export type BlockedNumber = typeof blockedNumbers.$inferSelect;
export type AutoResponse = typeof autoResponses.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type ChatbotConfig = typeof chatbotConfigs.$inferSelect;
export type HRAdmin = typeof hrAdmins.$inferSelect;
export type HRChatbotConfig = typeof hrChatbotConfigs.$inferSelect;
export type DemoSchedule = typeof demoSchedules.$inferSelect;
export type UserRagAgent = typeof userRagAgents.$inferSelect;
export type LeadPipeline = typeof leadPipelines.$inferSelect;
export type LeadFollowup = typeof leadFollowups.$inferSelect;
export type UserNotificationRecipient = typeof userNotificationRecipients.$inferSelect;
export type WhatsAppSession = typeof whatsappSessions.$inferSelect;
export type SessionConnectionHistory = typeof sessionConnectionHistory.$inferSelect;
export type HIMSPatient = typeof himsPatients.$inferSelect;
export type DataPatient = typeof dataPatients.$inferSelect;
export type DataCaseBatch = typeof dataCaseBatches.$inferSelect;
export type DataDocument = typeof dataDocuments.$inferSelect;
export type DataPatientEvent = typeof dataPatientEvents.$inferSelect;
export type DataGeneralRecord = typeof dataGeneralRecords.$inferSelect;

// Additional schemas for API requests
export const sendMessageSchema = z.object({
  phoneNumber: z.string().min(1, "Phone number is required"),
  content: z.string().min(1, "Message content is required"),
});

export const sendReportSchema = z.object({
  phoneNumber: z.string().min(1, "Phone number is required"),
  sampleId: z.string().min(1, "Sample ID is required"),
  content: z.string().optional(),
});

export const createCampaignSchema = z.object({
  name: z.string().min(1, "Campaign name is required"),
  originalMessage: z.string().min(1, "Original message is required"),
  campaignType: z.enum(["campaign", "template"]).optional(),
  fixedParams: z.record(z.any()).optional(),
  buttons: z.array(z.object({
    text: z.string(),
    url: z.string().optional(),
    phoneNumber: z.string().optional(),
  })).optional(),
  includeStopButton: z.boolean().optional(), // Add quick reply "Stop Messages" button
});

export const bulkSendSchema = z.object({
  variation_message: z.string().min(1, "Variation message is required"),
  intervalSeconds: z.number().int().min(1).max(3600).optional(),
  jitterSeconds: z.number().int().min(0).max(300).optional(),
  startFromContact: z.number().int().min(1).optional(),
  contacts: z.array(z.object({
    name: z.string(),
    phone: z.string(),
    extra: z.record(z.any()).optional(),
  })).optional(),
});

export const scheduleCampaignSchema = z.object({
  variation_message: z.string().min(1, "Variation message is required"),
  scheduledAt: z.string().datetime({ offset: true }),
  intervalSeconds: z.number().int().min(1).max(3600).optional(),
  jitterSeconds: z.number().int().min(0).max(300).optional(),
  startFromContact: z.number().int().min(1).optional(),
});

export const userRagAgentSchema = z.object({
  agentName: z.string().min(1, "Agent name is required"),
  ragBaseUrl: z.string().min(1, "RAG base URL is required").refine(
    (val) => val === "supabase-knowledge-base" || /^https?:\/\/.+/.test(val),
    "Must be a valid URL or 'supabase-knowledge-base'"
  ),
  ragAccessKey: z.string().min(1, "RAG access key is required"),
  systemPrompt: z.string().optional(),
  triggerKeywords: z.array(z.string()).optional(),
  greetingMessage: z.string().optional(),
  contextMessageCount: z.number().int().min(1).max(20).optional(),
  replyCooldownSeconds: z.number().int().min(0).max(60).optional(),
  typingDelayMs: z.number().int().min(0).max(10000).optional(),
  intakeMode: z.boolean().optional(),
  followupsEnabled: z.boolean().optional(),
  autoSequenceEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const leadPipelineSchema = z.object({
  name: z.string().min(1, "Pipeline name is required"),
  ragAgentId: z.string().optional(),
  isActive: z.boolean().optional(),
  dripEnabled: z.boolean().optional(),
  dripPrompt: z.string().optional(),
});

export const userNotificationRecipientSchema = z.object({
  phoneNumber: z.string().min(10, "Phone number must be at least 10 digits"),
  label: z.string().optional(),
  notifyOnLeadCreated: z.boolean().optional(),
  notifyOnDemoScheduled: z.boolean().optional(),
  notifyOnBookingConfirmed: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const chatbotConfigSchema = z.object({
  agentName: z.string().min(1, "Agent name is required"),
  triggerKeywords: z.array(z.string()).min(1, "At least one trigger keyword is required"),
  ragBaseUrl: z.string().url("Valid RAG base URL is required"),
  ragAccessKey: z.string().min(1, "RAG access key is required"),
  systemPrompt: z.string().optional(),
  greetingMessage: z.string().optional(),
  contextMessageCount: z.number().int().min(1).max(20).optional(),
  replyCooldownSeconds: z.number().int().min(0).max(60).optional(),
  typingDelayMs: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});

export const flagLeadSchema = z.object({
  phoneNumber: z.string().min(1, "Phone number is required"),
  keyword: z.string().optional(),
  name: z.string().optional(),
});

// HR Admin registration schema
export const registerHRAdminSchema = z.object({
  phoneNumber: z.string().min(1, "Phone number is required"),
  name: z.string().optional(),
  organizationId: z.string().uuid("Organization ID must be a valid UUID"),
  userId: z.string().uuid("User ID must be a valid UUID"),
  organizationName: z.string().optional(),
});

// HR Chatbot config schema
export const hrChatbotConfigSchema = z.object({
  agentName: z.string().min(1, "Agent name is required"),
  ragBaseUrl: z.string().url("Valid RAG base URL is required"),
  ragAccessKey: z.string().min(1, "RAG access key is required"),
  supabaseUrl: z.string().url("Valid Supabase URL is required"),
  supabaseServiceKey: z.string().min(1, "Supabase service key is required"),
  contextMessageCount: z.number().int().min(1).max(10).optional(),
  isActive: z.boolean().optional(),
});

// HIMS patient registration schema
export const registerHIMSPatientSchema = z.object({
  phoneNumber: z.string().min(1, "Phone number is required"),
  name: z.string().optional(),
  organizationId: z.string().uuid("HIMS Clinic ID must be a valid UUID"),
  systemPrompt: z.string().optional(),
  triggerKeywords: z.array(z.string()).optional(),
  greetingMessage: z.string().optional(),
});

// Auth schemas
export const registerSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  email: z.string().email("Valid email is required").optional(),
  organizationId: z.string().optional(),
});

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export type SendMessageRequest = z.infer<typeof sendMessageSchema>;
export type SendReportRequest = z.infer<typeof sendReportSchema>;
export type CreateCampaignRequest = z.infer<typeof createCampaignSchema>;
export type BulkSendRequest = z.infer<typeof bulkSendSchema>;
export type ScheduleCampaignRequest = z.infer<typeof scheduleCampaignSchema>;
export type ChatbotConfigRequest = z.infer<typeof chatbotConfigSchema>;
export type FlagLeadRequest = z.infer<typeof flagLeadSchema>;
export type RegisterHRAdminRequest = z.infer<typeof registerHRAdminSchema>;
export type HRChatbotConfigRequest = z.infer<typeof hrChatbotConfigSchema>;
export type UserRagAgentRequest = z.infer<typeof userRagAgentSchema>;
export type UserNotificationRecipientRequest = z.infer<typeof userNotificationRecipientSchema>;
export type RegisterHIMSPatientRequest = z.infer<typeof registerHIMSPatientSchema>;
export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
