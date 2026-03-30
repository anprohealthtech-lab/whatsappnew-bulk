import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, integer, boolean as pgBoolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(), // bcrypt hash
  email: text("email").unique(),
  organizationId: text("organization_id").default("default_org").notNull(),
  role: text("role").default("user").notNull(), // 'super_admin' | 'admin' | 'user'
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
  isActive: text("is_active").default("true").notNull(),
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
export type UserNotificationRecipient = typeof userNotificationRecipients.$inferSelect;
export type WhatsAppSession = typeof whatsappSessions.$inferSelect;
export type SessionConnectionHistory = typeof sessionConnectionHistory.$inferSelect;

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
  isActive: z.boolean().optional(),
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
  organizationId: z.string().min(1, "Organization ID is required"),
  userId: z.string().min(1, "User ID is required"),
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
export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
