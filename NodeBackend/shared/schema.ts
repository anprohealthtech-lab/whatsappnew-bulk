import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
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
  name: text("name").notNull(),
  originalMessage: text("original_message").notNull(),
  fixedParams: jsonb("fixed_params"),
  selectedVariation: text("selected_variation"),
  buttons: jsonb("buttons"), // Array of { text: string; url?: string; phoneNumber?: string }
  includeStopButton: text("include_stop_button").default("false"), // "true" or "false"
  totalContacts: integer("total_contacts").default(0),
  attachmentPath: text("attachment_path"),
  attachmentName: text("attachment_name"),
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
  phoneNumber: text("phone_number").notNull().unique(),
  reason: text("reason").default("user_requested"), // 'user_requested', 'spam', 'admin_blocked'
  blockedAt: timestamp("blocked_at").defaultNow(),
});

export const autoResponses = pgTable("auto_responses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  keyword: text("keyword").notNull(),
  response: text("response").notNull(),
  isActive: text("is_active").default("true").notNull(), // "true" or "false"
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
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
export type BlockedNumber = typeof blockedNumbers.$inferSelect;
export type AutoResponse = typeof autoResponses.$inferSelect;

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
  contacts: z.array(z.object({
    name: z.string(),
    phone: z.string(),
    extra: z.record(z.any()).optional(),
  })).optional(),
});

export type SendMessageRequest = z.infer<typeof sendMessageSchema>;
export type SendReportRequest = z.infer<typeof sendReportSchema>;
export type CreateCampaignRequest = z.infer<typeof createCampaignSchema>;
export type BulkSendRequest = z.infer<typeof bulkSendSchema>;
