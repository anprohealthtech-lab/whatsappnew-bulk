import { sql } from 'drizzle-orm';
import { pgTable,text,jsonb,integer,timestamp,index,uniqueIndex,check } from 'drizzle-orm/pg-core';

// Kept separate from the legacy Baileys campaign model. Mirrors server/cloud/schema.ts.
export const cloudCampaigns=pgTable('cloud_campaigns',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),userId:text('user_id').notNull(),
  name:text('name').notNull(),sessionId:text('session_id').notNull(),phoneNumberId:text('phone_number_id').notNull(),wabaId:text('waba_id').notNull(),
  templateName:text('template_name').notNull(),language:text('language').notNull(),templateSnapshot:jsonb('template_snapshot').notNull(),
  headerParams:jsonb('header_params').notNull().default([]),buttonParams:jsonb('button_params').notNull().default([]),
  status:text('status').notNull().default('draft'),scheduledAt:timestamp('scheduled_at',{withTimezone:true}),nextSendAt:timestamp('next_send_at',{withTimezone:true}),
  intervalSeconds:integer('interval_seconds').notNull().default(25),dailyLimit:integer('daily_limit').notNull().default(100),
  errorReason:text('error_reason'),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  index('cloud_campaigns_owner').on(t.organizationId,t.userId,t.createdAt),
  check('cloud_campaigns_interval_seconds_check',sql`${t.intervalSeconds} >= 5`),
  check('cloud_campaigns_daily_limit_check',sql`${t.dailyLimit} BETWEEN 1 AND 250`),
]);
export const cloudCampaignRecipients=pgTable('cloud_campaign_recipients',{
  id:text('id').primaryKey(),campaignId:text('campaign_id').notNull().references(()=>cloudCampaigns.id),
  name:text('name').notNull(),phone:text('phone').notNull(),bodyParams:jsonb('body_params').notNull().default([]),
  consentNote:text('consent_note').notNull(),status:text('status').notNull().default('pending'),latestAttemptId:text('latest_attempt_id'),errorReason:text('error_reason'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('cloud_campaign_recipients_campaign_id_phone_key').on(t.campaignId,t.phone),index('cloud_recipients_pending').on(t.campaignId,t.status)]);
export const cloudMessageAttempts=pgTable('cloud_message_attempts',{
  id:text('id').primaryKey(),campaignId:text('campaign_id').notNull().references(()=>cloudCampaigns.id),recipientId:text('recipient_id').notNull().references(()=>cloudCampaignRecipients.id),
  organizationId:text('organization_id').notNull(),userId:text('user_id').notNull(),phoneNumberId:text('phone_number_id').notNull(),phone:text('phone').notNull(),
  messageId:text('message_id'),status:text('status').notNull().default('dispatching'),requestSnapshot:jsonb('request_snapshot').notNull(),
  acceptedAt:timestamp('accepted_at',{withTimezone:true}),sentAt:timestamp('sent_at',{withTimezone:true}),deliveredAt:timestamp('delivered_at',{withTimezone:true}),
  readAt:timestamp('read_at',{withTimezone:true}),failedAt:timestamp('failed_at',{withTimezone:true}),errorReason:text('error_reason'),errorCode:text('error_code'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('cloud_message_attempts_phone_number_id_message_id_key').on(t.phoneNumberId,t.messageId),index('cloud_attempts_recipient').on(t.recipientId,t.createdAt)]);
export const cloudMessageStatusEvents=pgTable('cloud_message_status_events',{
  id:text('id').primaryKey(),eventKey:text('event_key').notNull().unique(),organizationId:text('organization_id').notNull(),userId:text('user_id').notNull(),
  phoneNumberId:text('phone_number_id').notNull(),wabaId:text('waba_id').notNull(),messageId:text('message_id').notNull(),recipientPhone:text('recipient_phone').notNull(),
  status:text('status').notNull(),occurredAt:timestamp('occurred_at',{withTimezone:true}).notNull(),receivedAt:timestamp('received_at',{withTimezone:true}).notNull().defaultNow(),
  attemptId:text('attempt_id'),payload:jsonb('payload').notNull(),
},t=>[index('cloud_events_message').on(t.organizationId,t.userId,t.phoneNumberId,t.messageId),index('cloud_events_suppression').on(t.organizationId,t.userId,t.recipientPhone,t.status)]);
