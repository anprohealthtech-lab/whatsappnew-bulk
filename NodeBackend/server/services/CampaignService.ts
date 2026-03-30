import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { campaigns, campaignRecipients, messageVariations, campaignSchedules } from '@shared/schema';
import { eq, and, desc, lte } from 'drizzle-orm';
import { sessionManager } from './WhatsAppSessionManager';
import type { WhatsAppService } from './WhatsAppService';
import { messageService } from './MessageService';
import { variationService } from './VariationService';
import { storage } from '../storage';
import { log } from '../utils';
import { persistentFileService } from './PersistentFileService';

interface ContactRow {
  name: string;
  phone: string;
  extra?: Record<string, any>;
}

interface BulkSendResult {
  success: boolean;
  campaign_id: string;
  total: number;
  sent: number;
  failed: number;
  runStatus: 'completed' | 'stopped';
  failed_list: Array<{ phone: string; name: string; reason: string }>;
}

interface CampaignRunProgress {
  campaignId: string;
  campaignName: string;
  organizationId: string;
  userId: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  total: number;
  processed: number;
  pending: number;
  sent: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  lastContactName?: string;
  lastContactPhone?: string;
  error?: string;
}

interface TenantContext {
  organizationId: string;
  userId: string;
}

interface SendOptions {
  intervalSeconds?: number;
  jitterSeconds?: number;
}

export class CampaignService {
  private stopFlags = new Map<string, boolean>();
  private pauseFlags = new Map<string, boolean>();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerRunning = false;
  private liveRuns = new Map<string, CampaignRunProgress>();

  private getAttachmentPool(campaign: typeof campaigns.$inferSelect): string[] {
    if (!Array.isArray(campaign.attachmentPaths)) return [];
    return campaign.attachmentPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  private getAttachmentFileNamePool(campaign: typeof campaigns.$inferSelect): string[] {
    if (!Array.isArray(campaign.attachmentFileNames)) return [];
    return campaign.attachmentFileNames.filter((value): value is string => typeof value === 'string');
  }

  private pickAttachmentForSend(campaign: typeof campaigns.$inferSelect): { path: string; fileName?: string } | null {
    const paths = this.getAttachmentPool(campaign);
    const fileNames = this.getAttachmentFileNamePool(campaign);

    if (paths.length > 0) {
      const index = Math.floor(Math.random() * paths.length);
      return {
        path: paths[index],
        fileName: fileNames[index],
      };
    }

    if (campaign.attachmentPath) {
      return {
        path: campaign.attachmentPath,
        fileName: campaign.attachmentName || undefined,
      };
    }

    return null;
  }

  private resolveAttachmentPath(filePath: string): string | null {
    if (fs.existsSync(filePath)) {
      return filePath;
    }

    const fileName = path.basename(filePath);
    const uploadCandidates = [
      path.join(persistentFileService.getUploadDirectory(), fileName),
      path.join(process.cwd(), 'uploads', fileName),
    ];

    for (const candidate of uploadCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private upsertRunProgress(
    campaignId: string,
    patch: Partial<CampaignRunProgress> & Pick<CampaignRunProgress, 'campaignId' | 'campaignName' | 'organizationId' | 'userId' | 'total'>
  ): CampaignRunProgress {
    const existing = this.liveRuns.get(campaignId);
    const processed = patch.processed ?? existing?.processed ?? 0;
    const total = patch.total ?? existing?.total ?? 0;
    const sent = patch.sent ?? existing?.sent ?? 0;
    const failed = patch.failed ?? existing?.failed ?? 0;

    const next: CampaignRunProgress = {
      campaignId,
      campaignName: patch.campaignName ?? existing?.campaignName ?? campaignId,
      organizationId: patch.organizationId ?? existing?.organizationId ?? 'default_org',
      userId: patch.userId ?? existing?.userId ?? 'default_user',
      status: patch.status ?? existing?.status ?? 'running',
      total,
      processed,
      pending: Math.max(0, total - processed),
      sent,
      failed,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastContactName: patch.lastContactName ?? existing?.lastContactName,
      lastContactPhone: patch.lastContactPhone ?? existing?.lastContactPhone,
      error: patch.error ?? existing?.error,
    };

    this.liveRuns.set(campaignId, next);
    return next;
  }

  listLiveRuns(tenant?: Partial<TenantContext>): CampaignRunProgress[] {
    const normalizedTenant = this.normalizeTenant(tenant);
    return Array.from(this.liveRuns.values())
      .filter((run) =>
        run.organizationId === normalizedTenant.organizationId &&
        run.userId === normalizedTenant.userId
      )
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  private enrichCampaign<T extends typeof campaigns.$inferSelect | undefined>(campaign: T) {
    if (!campaign) {
      return campaign;
    }

    const poolPaths = this.getAttachmentPool(campaign);
    const missingAttachmentNames = poolPaths
      .filter((filePath) => !this.resolveAttachmentPath(filePath))
      .map((filePath) => path.basename(filePath));

    if (campaign.attachmentPath && !this.resolveAttachmentPath(campaign.attachmentPath)) {
      missingAttachmentNames.push(path.basename(campaign.attachmentPath));
    }

    return {
      ...campaign,
      hasMissingAttachments: missingAttachmentNames.length > 0,
      missingAttachmentNames,
      availableAttachmentCount: poolPaths.length - missingAttachmentNames.filter((name) => poolPaths.some((filePath) => path.basename(filePath) === name)).length,
    };
  }

  private normalizeTenant(tenant?: Partial<TenantContext>): TenantContext {
    return {
      organizationId: tenant?.organizationId || 'default_org',
      userId: tenant?.userId || 'default_user',
    };
  }

  private randomDelaySeconds(baseInterval: number, jitter: number): number {
    if (jitter <= 0) return baseInterval;
    // Cap jitter so the delay never drops below 15% of baseInterval (minimum 30s)
    const minDelay = Math.max(30, Math.ceil(baseInterval * 0.15));
    const effectiveJitter = Math.min(jitter, baseInterval - minDelay);
    if (effectiveJitter <= 0) return baseInterval;
    const variance = Math.floor(Math.random() * (effectiveJitter * 2 + 1)) - effectiveJitter;
    return Math.max(minDelay, baseInterval + variance);
  }

  startScheduler(): void {
    if (this.schedulerTimer) return;

    this.schedulerTimer = setInterval(() => {
      this.runDueSchedules().catch((error) => {
        log(`❌ Scheduler tick failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      });
    }, 15000);

    log('⏰ Campaign scheduler started (15s tick)');
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  async createCampaign(
    name: string,
    originalMessage: string,
    campaignType: 'campaign' | 'template' = 'campaign',
    fixedParams?: Record<string, any>,
    buttons?: Array<{ text: string; url?: string; phoneNumber?: string }>,
    includeStopButton?: boolean,
    tenant?: Partial<TenantContext>
  ) {
    const normalizedTenant = this.normalizeTenant(tenant);
    const [campaign] = await db.insert(campaigns).values({
      organizationId: normalizedTenant.organizationId,
      userId: normalizedTenant.userId,
      name,
      campaignType,
      originalMessage,
      fixedParams: fixedParams || {},
      buttons: buttons || [],
      includeStopButton: includeStopButton ? 'true' : 'false',
    }).returning();

    return campaign;
  }

  async listCampaigns(tenant?: Partial<TenantContext>, campaignType: 'campaign' | 'template' = 'campaign') {
    const normalizedTenant = this.normalizeTenant(tenant);
    const result = await db
      .select()
      .from(campaigns)
      .where(and(
        eq(campaigns.organizationId, normalizedTenant.organizationId),
        eq(campaigns.userId, normalizedTenant.userId),
        eq(campaigns.campaignType, campaignType)
      ))
      .orderBy(desc(campaigns.createdAt));

    return result.map((campaign) => this.enrichCampaign(campaign));
  }

  async getCampaign(campaignId: string, tenant?: Partial<TenantContext>) {
    const normalizedTenant = this.normalizeTenant(tenant);
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(and(
        eq(campaigns.id, campaignId),
        eq(campaigns.organizationId, normalizedTenant.organizationId),
        eq(campaigns.userId, normalizedTenant.userId)
      ));

    return this.enrichCampaign(campaign);
  }

  async updateCampaignVariation(campaignId: string, variation: string, tenant?: Partial<TenantContext>) {
    const normalizedTenant = this.normalizeTenant(tenant);
    const [updated] = await db
      .update(campaigns)
      .set({
        selectedVariation: variation,
        updatedAt: new Date(),
      })
      .where(and(
        eq(campaigns.id, campaignId),
        eq(campaigns.organizationId, normalizedTenant.organizationId),
        eq(campaigns.userId, normalizedTenant.userId)
      ))
      .returning();

    return updated;
  }

  async updateCampaignAttachment(campaignId: string, filePath: string, fileName: string, tenant?: Partial<TenantContext>) {
    const normalizedTenant = this.normalizeTenant(tenant);
    const [updated] = await db
      .update(campaigns)
      .set({
        attachmentPath: filePath,
        attachmentName: fileName,
        updatedAt: new Date(),
      })
      .where(and(
        eq(campaigns.id, campaignId),
        eq(campaigns.organizationId, normalizedTenant.organizationId),
        eq(campaigns.userId, normalizedTenant.userId)
      ))
      .returning();

    return this.enrichCampaign(updated);
  }

  async addAttachmentToPool(campaignId: string, filePath: string, tenant?: Partial<TenantContext>) {
    const campaign = await this.getCampaign(campaignId, tenant);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const attachmentPaths = this.getAttachmentPool(campaign);
    if (attachmentPaths.length >= 5) {
      throw new Error('Maximum 5 attachments allowed per campaign');
    }

    attachmentPaths.push(filePath);
    const attachmentFileNames = this.getAttachmentFileNamePool(campaign);
    while (attachmentFileNames.length < attachmentPaths.length) {
      attachmentFileNames.push('');
    }

    const normalizedTenant = this.normalizeTenant(tenant);
    const [updated] = await db
      .update(campaigns)
      .set({
        attachmentPaths,
        attachmentFileNames,
        updatedAt: new Date(),
      })
      .where(and(
        eq(campaigns.id, campaignId),
        eq(campaigns.organizationId, normalizedTenant.organizationId),
        eq(campaigns.userId, normalizedTenant.userId)
      ))
      .returning();

    return this.enrichCampaign(updated);
  }

  async removeAttachmentFromPool(campaignId: string, index: number, tenant?: Partial<TenantContext>) {
    const campaign = await this.getCampaign(campaignId, tenant);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const attachmentPaths = this.getAttachmentPool(campaign);
    if (!Number.isInteger(index) || index < 0 || index >= attachmentPaths.length) {
      throw new Error('Invalid attachment index');
    }

    const attachmentFileNames = this.getAttachmentFileNamePool(campaign);
    attachmentPaths.splice(index, 1);
    if (attachmentFileNames.length > index) {
      attachmentFileNames.splice(index, 1);
    }

    const normalizedTenant = this.normalizeTenant(tenant);
    const [updated] = await db
      .update(campaigns)
      .set({
        attachmentPaths,
        attachmentFileNames,
        updatedAt: new Date(),
      })
      .where(and(
        eq(campaigns.id, campaignId),
        eq(campaigns.organizationId, normalizedTenant.organizationId),
        eq(campaigns.userId, normalizedTenant.userId)
      ))
      .returning();

    return this.enrichCampaign(updated);
  }

  async updateAttachmentFileNames(campaignId: string, fileNames: string[], tenant?: Partial<TenantContext>) {
    const campaign = await this.getCampaign(campaignId, tenant);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const attachmentPaths = this.getAttachmentPool(campaign);
    if (fileNames.length > attachmentPaths.length) {
      throw new Error('Cannot set more filenames than attachments');
    }

    const attachmentFileNames = attachmentPaths.map((_, index) => {
      const value = fileNames[index];
      return typeof value === 'string' ? value : '';
    });

    const normalizedTenant = this.normalizeTenant(tenant);
    const [updated] = await db
      .update(campaigns)
      .set({
        attachmentFileNames,
        updatedAt: new Date(),
      })
      .where(and(
        eq(campaigns.id, campaignId),
        eq(campaigns.organizationId, normalizedTenant.organizationId),
        eq(campaigns.userId, normalizedTenant.userId)
      ))
      .returning();

    return this.enrichCampaign(updated);
  }

  async saveMessageVariation(campaignId: string, variation: string, tenant?: Partial<TenantContext>) {
    const campaign = await this.getCampaign(campaignId, tenant);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const [saved] = await db
      .insert(messageVariations)
      .values({
        campaignId,
        message: variation, // Updated: variation column renamed to message
      })
      .returning();

    return saved;
  }

  async getMessageVariations(campaignId: string, tenant?: Partial<TenantContext>) {
    const campaign = await this.getCampaign(campaignId, tenant);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const variations = await db
      .select()
      .from(messageVariations)
      .where(eq(messageVariations.campaignId, campaignId))
      .orderBy(messageVariations.createdAt);

    return variations;
  }

  async uploadContacts(campaignId: string, contacts: ContactRow[], tenant?: Partial<TenantContext>) {
    // Validate campaign exists
    const campaign = await this.getCampaign(campaignId, tenant);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    // Remove duplicates based on phone number (keep first occurrence)
    const uniqueContacts: ContactRow[] = [];
    const seenPhones = new Set<string>();

    for (const contact of contacts) {
      const cleanPhone = contact.phone.replace(/\D/g, '');
      if (!seenPhones.has(cleanPhone)) {
        seenPhones.add(cleanPhone);
        uniqueContacts.push(contact);
      } else {
        log(`⚠️  Skipping duplicate phone number: ${contact.phone} (${contact.name})`);
      }
    }

    log(`📊 Original contacts: ${contacts.length}, After deduplication: ${uniqueContacts.length}`);

    // Insert contacts
    const insertedContacts = await db
      .insert(campaignRecipients)
      .values(
        uniqueContacts.map(contact => ({
          campaignId,
          name: contact.name,
          phone: contact.phone,
          extra: contact.extra || {},
        }))
      )
      .returning();

    // Update campaign total contacts
    await db
      .update(campaigns)
      .set({
        totalContacts: insertedContacts.length,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));

    return {
      success: true,
      total: insertedContacts.length,
      sample: insertedContacts.slice(0, 5),
    };
  }

  async getContacts(campaignId: string, tenant?: Partial<TenantContext>) {
    const campaign = await this.getCampaign(campaignId, tenant);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const contacts = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId));

    return contacts;
  }

  stopCampaign(campaignId: string) {
    this.stopFlags.set(campaignId, true);
    log(`🛑 Stop signal received for campaign ${campaignId}`);
  }

  pauseCampaign(campaignId: string) {
    this.pauseFlags.set(campaignId, true);

    const existing = this.liveRuns.get(campaignId);
    if (existing) {
      this.upsertRunProgress(campaignId, {
        campaignId,
        campaignName: existing.campaignName,
        organizationId: existing.organizationId,
        userId: existing.userId,
        total: existing.total,
        status: 'paused',
        processed: existing.processed,
        sent: existing.sent,
        failed: existing.failed,
        lastContactName: existing.lastContactName,
        lastContactPhone: existing.lastContactPhone,
        error: existing.error,
      });
    }

    log(`â¸ Pause signal received for campaign ${campaignId}`);
  }

  resumeCampaign(campaignId: string) {
    this.pauseFlags.set(campaignId, false);

    const existing = this.liveRuns.get(campaignId);
    if (existing) {
      this.upsertRunProgress(campaignId, {
        campaignId,
        campaignName: existing.campaignName,
        organizationId: existing.organizationId,
        userId: existing.userId,
        total: existing.total,
        status: 'running',
        processed: existing.processed,
        sent: existing.sent,
        failed: existing.failed,
        lastContactName: existing.lastContactName,
        lastContactPhone: existing.lastContactPhone,
        error: existing.error,
      });
    }

    log(`â–¶ Resume signal received for campaign ${campaignId}`);
  }

  async scheduleCampaign(
    campaignId: string,
    variationMessage: string,
    scheduledAt: Date,
    tenant?: Partial<TenantContext>,
    options?: SendOptions,
  ) {
    const normalizedTenant = this.normalizeTenant(tenant);
    const campaign = await this.getCampaign(campaignId, normalizedTenant);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const [schedule] = await db.insert(campaignSchedules).values({
      campaignId,
      organizationId: normalizedTenant.organizationId,
      userId: normalizedTenant.userId,
      variationMessage,
      scheduledAt,
      intervalSeconds: options?.intervalSeconds ?? 25,
      jitterSeconds: options?.jitterSeconds ?? 0,
      status: 'scheduled',
    }).returning();

    return schedule;
  }

  async listSchedules(tenant?: Partial<TenantContext>) {
    const normalizedTenant = this.normalizeTenant(tenant);
    return db.select().from(campaignSchedules)
      .where(and(
        eq(campaignSchedules.organizationId, normalizedTenant.organizationId),
        eq(campaignSchedules.userId, normalizedTenant.userId)
      ))
      .orderBy(desc(campaignSchedules.createdAt));
  }

  async cancelSchedule(scheduleId: string, tenant?: Partial<TenantContext>) {
    const normalizedTenant = this.normalizeTenant(tenant);
    const [schedule] = await db.select().from(campaignSchedules).where(and(
      eq(campaignSchedules.id, scheduleId),
      eq(campaignSchedules.organizationId, normalizedTenant.organizationId),
      eq(campaignSchedules.userId, normalizedTenant.userId)
    ));

    if (!schedule) {
      throw new Error('Schedule not found');
    }

    if (schedule.status === 'completed' || schedule.status === 'failed' || schedule.status === 'cancelled') {
      return schedule;
    }

    this.stopCampaign(schedule.campaignId);

    const [updated] = await db.update(campaignSchedules)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(campaignSchedules.id, scheduleId))
      .returning();

    return updated;
  }

  async pauseSchedule(scheduleId: string, tenant?: Partial<TenantContext>) {
    const normalizedTenant = this.normalizeTenant(tenant);
    const [schedule] = await db.select().from(campaignSchedules).where(and(
      eq(campaignSchedules.id, scheduleId),
      eq(campaignSchedules.organizationId, normalizedTenant.organizationId),
      eq(campaignSchedules.userId, normalizedTenant.userId)
    ));

    if (!schedule) {
      throw new Error('Schedule not found');
    }

    if (schedule.status === 'completed' || schedule.status === 'failed' || schedule.status === 'cancelled' || schedule.status === 'paused') {
      return schedule;
    }

    if (schedule.status === 'running') {
      this.pauseCampaign(schedule.campaignId);
    }

    const [updated] = await db.update(campaignSchedules)
      .set({
        status: 'paused',
        updatedAt: new Date(),
      })
      .where(eq(campaignSchedules.id, scheduleId))
      .returning();

    return updated;
  }

  async resumeSchedule(scheduleId: string, tenant?: Partial<TenantContext>) {
    const normalizedTenant = this.normalizeTenant(tenant);
    const [schedule] = await db.select().from(campaignSchedules).where(and(
      eq(campaignSchedules.id, scheduleId),
      eq(campaignSchedules.organizationId, normalizedTenant.organizationId),
      eq(campaignSchedules.userId, normalizedTenant.userId)
    ));

    if (!schedule) {
      throw new Error('Schedule not found');
    }

    if (schedule.status !== 'paused') {
      return schedule;
    }

    const shouldResumeRunning = Boolean(schedule.startedAt);
    if (shouldResumeRunning) {
      this.resumeCampaign(schedule.campaignId);
    }

    const [updated] = await db.update(campaignSchedules)
      .set({
        status: shouldResumeRunning ? 'running' : 'scheduled',
        updatedAt: new Date(),
      })
      .where(eq(campaignSchedules.id, scheduleId))
      .returning();

    return updated;
  }

  private async waitWhilePaused(
    campaignId: string,
    campaignName: string,
    tenant: TenantContext,
    total: number,
    progress?: Partial<CampaignRunProgress>
  ): Promise<boolean> {
    let markedPaused = false;

    while (this.pauseFlags.get(campaignId)) {
      if (!markedPaused) {
        this.upsertRunProgress(campaignId, {
          campaignId,
          campaignName,
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          total,
          status: 'paused',
          processed: progress?.processed,
          sent: progress?.sent,
          failed: progress?.failed,
          lastContactName: progress?.lastContactName,
          lastContactPhone: progress?.lastContactPhone,
          error: progress?.error,
        });
        markedPaused = true;
      }

      if (this.stopFlags.get(campaignId)) {
        return false;
      }

      await this.delay(1000);
    }

    if (markedPaused) {
      this.upsertRunProgress(campaignId, {
        campaignId,
        campaignName,
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        total,
        status: 'running',
        processed: progress?.processed,
        sent: progress?.sent,
        failed: progress?.failed,
        lastContactName: progress?.lastContactName,
        lastContactPhone: progress?.lastContactPhone,
        error: progress?.error,
      });
    }

    return true;
  }

  private async runDueSchedules(): Promise<void> {
    if (this.schedulerRunning) return;
    this.schedulerRunning = true;

    try {
      const now = new Date();
      const dueSchedules = await db.select().from(campaignSchedules).where(and(
        eq(campaignSchedules.status, 'scheduled'),
        lte(campaignSchedules.scheduledAt, now)
      ));

      for (const schedule of dueSchedules) {
        try {
          log(`[CampaignScheduler] Starting schedule ${schedule.id} for campaign ${schedule.campaignId} (org=${schedule.organizationId}, user=${schedule.userId}, scheduledAt=${schedule.scheduledAt instanceof Date ? schedule.scheduledAt.toISOString() : String(schedule.scheduledAt)})`);
          await db.update(campaignSchedules)
            .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
            .where(eq(campaignSchedules.id, schedule.id));

          const result = await this.sendBulkMessages(
            schedule.campaignId,
            schedule.variationMessage,
            undefined,
            {
              intervalSeconds: schedule.intervalSeconds ?? 25,
              jitterSeconds: schedule.jitterSeconds ?? 0,
            },
            {
              organizationId: schedule.organizationId,
              userId: schedule.userId,
            }
          );

          const [latestSchedule] = await db.select().from(campaignSchedules)
            .where(eq(campaignSchedules.id, schedule.id));

          if (!latestSchedule) {
            continue;
          }

          if (latestSchedule.status === 'cancelled' || latestSchedule.status === 'paused') {
            await db.update(campaignSchedules)
              .set({
                updatedAt: new Date(),
                resultSummary: result,
              })
              .where(eq(campaignSchedules.id, schedule.id));
            continue;
          }

          if (result.runStatus === 'stopped') {
            await db.update(campaignSchedules)
              .set({
                status: 'cancelled',
                completedAt: new Date(),
                updatedAt: new Date(),
                resultSummary: result,
              })
              .where(eq(campaignSchedules.id, schedule.id));
            continue;
          }

          log(`[CampaignScheduler] Completed schedule ${schedule.id} for campaign ${schedule.campaignId}: sent=${result.sent}, failed=${result.failed}, total=${result.total}`);
          await db.update(campaignSchedules)
            .set({
              status: 'completed',
              completedAt: new Date(),
              updatedAt: new Date(),
              resultSummary: result,
            })
            .where(eq(campaignSchedules.id, schedule.id));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          log(`[CampaignScheduler] Failed schedule ${schedule.id} for campaign ${schedule.campaignId} (org=${schedule.organizationId}, user=${schedule.userId}): ${errorMessage}`);
          if (error instanceof Error && error.stack) {
            log(`[CampaignScheduler] Stack for schedule ${schedule.id}: ${error.stack}`);
          }
          await db.update(campaignSchedules)
            .set({
              status: 'failed',
              completedAt: new Date(),
              updatedAt: new Date(),
              resultSummary: {
                success: false,
                error: errorMessage
              }
            })
            .where(eq(campaignSchedules.id, schedule.id));
        }
      }
    } finally {
      this.schedulerRunning = false;
    }
  }

  async sendBulkMessages(
    campaignId: string,
    variationMessage: string,
    contactsInput?: ContactRow[],
    options?: SendOptions,
    tenant?: Partial<TenantContext>
  ): Promise<BulkSendResult> {
    // Reset stop flag
    this.stopFlags.set(campaignId, false);
    this.pauseFlags.set(campaignId, false);

    // Get campaign
    const campaign = await this.getCampaign(campaignId, tenant);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    if (campaign.hasMissingAttachments) {
      throw new Error(`Attachment missing from storage: ${campaign.missingAttachmentNames.join(', ')}. Please re-upload before sending.`);
    }

    // Get contacts (from input or DB)
    let contacts: ContactRow[];
    if (contactsInput && contactsInput.length > 0) {
      contacts = contactsInput;
    } else {
      const dbContacts = await this.getContacts(campaignId, tenant);
      contacts = dbContacts.map(c => ({
        name: c.name,
        phone: c.phone,
        extra: (c.extra as Record<string, any>) || {},
      }));
    }

    if (contacts.length === 0) {
      throw new Error('No contacts found for this campaign');
    }

    const normalizedTenant = this.normalizeTenant(tenant);
    this.upsertRunProgress(campaignId, {
      campaignId,
      campaignName: campaign.name,
      organizationId: normalizedTenant.organizationId,
      userId: normalizedTenant.userId,
      status: 'running',
      total: contacts.length,
      processed: 0,
      sent: 0,
      failed: 0,
    });

    // Get user's connected WhatsApp session
    const userSessions = await sessionManager.listSessions(normalizedTenant.userId);
    const connectedSession = userSessions.find(s => s.status === 'connected');
    if (!connectedSession) {
      log(`[CampaignSend] No connected WhatsApp session for campaign ${campaignId} (org=${normalizedTenant.organizationId}, user=${normalizedTenant.userId}). Sessions: ${JSON.stringify(userSessions.map((session) => ({ sessionName: session.sessionName, status: session.status, phoneNumber: session.phoneNumber ?? null })))}`);
      throw new Error('No connected WhatsApp session. Please connect a session first.');
    }
    const waService = await sessionManager.getSession(normalizedTenant.userId, connectedSession.sessionName);

    log(`🚀 Starting bulk send for campaign ${campaignId} - ${contacts.length} contacts`);
    const baseMessage = variationMessage || campaign.originalMessage;
    log(`📝 Base message: ${baseMessage}`);
    log(`📎 Attachment path: ${campaign.attachmentPath || 'None'}`);
    log(`🔧 Fixed params: ${JSON.stringify(campaign.fixedParams)}`);

    // Pre-warm 3 variations to have ready immediately
    log(`🔥 Pre-warming first 3 variations...`);
    await variationService.prewarmVariations(
      campaignId,
      baseMessage,
      campaign.fixedParams || {},
      3
    );

    let sent = 0;
    let failed = 0;
    let stoppedByUser = false;
    const failedList: Array<{ phone: string; name: string; reason: string }> = [];

    // Send messages with on-demand variation generation
    for (let i = 0; i < contacts.length; i++) {
      // Check for stop signal
      if (this.stopFlags.get(campaignId)) {
        log(`🛑 Campaign ${campaignId} stopped by user request.`);
        stoppedByUser = true;
        break;
      }

      const canContinue = await this.waitWhilePaused(campaignId, campaign.name, normalizedTenant, contacts.length, {
        processed: sent + failed,
        sent,
        failed,
      });
      if (!canContinue) {
        log(`ðŸ›‘ Campaign ${campaignId} stopped while paused.`);
        stoppedByUser = true;
        break;
      }

      const contact = contacts[i];
      const contactNum = i + 1;
      this.upsertRunProgress(campaignId, {
        campaignId,
        campaignName: campaign.name,
        organizationId: normalizedTenant.organizationId,
        userId: normalizedTenant.userId,
        total: contacts.length,
        lastContactName: contact.name,
        lastContactPhone: contact.phone,
      });

      try {
        // Check if number is blocked
        const isBlocked = await storage.isNumberBlocked(contact.phone);
        if (isBlocked) {
          log(`  ⏭️  Skipping blocked number: ${contact.phone}`);
          failed++;
          failedList.push({
            phone: contact.phone,
            name: contact.name,
            reason: 'Number is blocked (user opted out)',
          });
          this.upsertRunProgress(campaignId, {
            campaignId,
            campaignName: campaign.name,
            organizationId: normalizedTenant.organizationId,
            userId: normalizedTenant.userId,
            total: contacts.length,
            processed: sent + failed,
            sent,
            failed,
            lastContactName: contact.name,
            lastContactPhone: contact.phone,
          });
          continue;
        }

        log(`\n[${contactNum}/${contacts.length}] Processing: ${contact.name} (${contact.phone})`);

        // Generate unique variation for this contact
        log(`  ↪ Generating unique variation #${contactNum}...`);
        const variationResult = await variationService.generateVariation({
          campaignId,
          message: baseMessage,
          fixedParams: campaign.fixedParams || {},
          contactPhone: contact.phone
        });

        if (!variationResult.success || !variationResult.tweakedMessage) {
          throw new Error(`Variation generation failed: ${variationResult.error || 'Empty message'}`);
        }

        log(`  ✓ Variation #${variationResult.variationNumber} generated (${variationResult.tweakedMessage.length} chars)`);

        // Personalize message by replacing placeholders
        let personalizedMessage = variationResult.tweakedMessage
          .replace(/\{\{name\}\}/g, contact.name)
          .replace(/\{\{phone\}\}/g, contact.phone);

        // Replace additional placeholders from extra fields
        if (contact.extra) {
          Object.keys(contact.extra).forEach(key => {
            const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
            personalizedMessage = personalizedMessage.replace(placeholder, String(contact.extra![key]));
          });
        }

        // Also apply fixed params as placeholders
        if (campaign.fixedParams && typeof campaign.fixedParams === 'object') {
          Object.keys(campaign.fixedParams).forEach(key => {
            const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
            const value = (campaign.fixedParams as Record<string, any>)[key];
            personalizedMessage = personalizedMessage.replace(placeholder, String(value));
          });
        }

        log(`  ↪ Sending personalized message...`);

        // Check if stop button should be included
        const includeStop = campaign.includeStopButton === 'true';

        // Prepare message with buttons if needed
        let fullMessage = personalizedMessage;

        // Append buttons to message (similar to WhatsAppService logic)
        if (campaign.buttons && Array.isArray(campaign.buttons) && campaign.buttons.length > 0) {
          fullMessage += '\n\n';
          for (const btn of campaign.buttons) {
            if (btn.text) { // Ensure button has text
              if (btn.url) {
                fullMessage += `🔗 ${btn.text}: ${btn.url}\n`;
              } else if (btn.phoneNumber) {
                fullMessage += `📞 ${btn.text}: ${btn.phoneNumber}\n`;
              } else {
                fullMessage += `✅ ${btn.text}\n`;
              }
            }
          }
        }

        if (includeStop) {
          fullMessage += '\n━━━━━━━━━━━━━━━━━━━━\n';
          fullMessage += '🚫 *To stop receiving messages*\n';
          fullMessage += 'Reply with: *STOP*\n';
        }

        // Send message (with attachment if present)
        const selectedAttachment = this.pickAttachmentForSend(campaign);
        const attachmentToSend = selectedAttachment
          ? this.resolveAttachmentPath(selectedAttachment.path)
          : null;
        if (selectedAttachment && !attachmentToSend) {
          throw new Error(`Attachment file not found: ${path.basename(selectedAttachment.path)}`);
        }
        if (attachmentToSend) {
          log(`  📎 Sending with attachment: ${campaign.attachmentPath}`);
          await waService.sendMediaMessage(
            contact.phone,
            attachmentToSend,
            fullMessage.trim(),
            selectedAttachment?.fileName
          );
        } else {
          // Send text message (already includes buttons formatted as text)
          await waService.sendTextMessage(contact.phone, fullMessage.trim());
        }

        // Update recipient status
        await db
          .update(campaignRecipients)
          .set({
            status: 'sent',
            sentAt: new Date(),
          })
          .where(
            and(
              eq(campaignRecipients.campaignId, campaignId),
              eq(campaignRecipients.phone, contact.phone)
            )
          );

        sent++;
        this.upsertRunProgress(campaignId, {
          campaignId,
          campaignName: campaign.name,
          organizationId: normalizedTenant.organizationId,
          userId: normalizedTenant.userId,
          total: contacts.length,
          processed: sent + failed,
          sent,
          failed,
          lastContactName: contact.name,
          lastContactPhone: contact.phone,
        });
        log(`  ✅ Message sent successfully to ${contact.name}`);

        // Add random delay between messages (20-40 seconds)
        if (i < contacts.length - 1) {
          const delaySeconds = this.randomDelaySeconds(options?.intervalSeconds ?? 25, options?.jitterSeconds ?? 0);
          log(`  ⏳ Waiting ${delaySeconds} seconds before next message...`);

          // Check for stop signal during delay
          for (let d = 0; d < delaySeconds; d++) {
            if (this.stopFlags.get(campaignId)) break;
            const stillRunning = await this.waitWhilePaused(campaignId, campaign.name, normalizedTenant, contacts.length, {
              processed: sent + failed,
              sent,
              failed,
              lastContactName: contact.name,
              lastContactPhone: contact.phone,
            });
            if (!stillRunning) {
              stoppedByUser = true;
              break;
            }
            await this.delay(1000);
          }

          if (stoppedByUser) {
            break;
          }
        }

      } catch (error: any) {
        failed++;
        const errorReason = error.message || 'Unknown error';

        failedList.push({
          phone: contact.phone,
          name: contact.name,
          reason: errorReason,
        });
        this.upsertRunProgress(campaignId, {
          campaignId,
          campaignName: campaign.name,
          organizationId: normalizedTenant.organizationId,
          userId: normalizedTenant.userId,
          total: contacts.length,
          processed: sent + failed,
          sent,
          failed,
          lastContactName: contact.name,
          lastContactPhone: contact.phone,
          error: errorReason,
        });

        // Update recipient status
        await db
          .update(campaignRecipients)
          .set({
            status: 'failed',
            errorReason,
          })
          .where(
            and(
              eq(campaignRecipients.campaignId, campaignId),
              eq(campaignRecipients.phone, contact.phone)
            )
          );

        log(`  ❌ Failed to send to ${contact.name} (${contact.phone}): ${errorReason}`);

        // Continue with next contact after a shorter delay
        if (i < contacts.length - 1) {
          log(`  ⏳ Waiting 10 seconds before next attempt...`);
          await this.delay(10000);
        }
      }
    }

    log(`\n✅ Bulk send complete: ${sent}/${contacts.length} sent, ${failed} failed`);

    this.upsertRunProgress(campaignId, {
      campaignId,
      campaignName: campaign.name,
      organizationId: normalizedTenant.organizationId,
      userId: normalizedTenant.userId,
      total: contacts.length,
      status: stoppedByUser ? 'stopped' : 'completed',
      processed: sent + failed,
      sent,
      failed,
    });

    return {
      success: true,
      campaign_id: campaignId,
      total: contacts.length,
      sent,
      failed,
      runStatus: stoppedByUser ? 'stopped' : 'completed',
      failed_list: failedList,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const campaignService = new CampaignService();
