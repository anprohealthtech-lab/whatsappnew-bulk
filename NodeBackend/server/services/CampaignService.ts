import { db } from '../db';
import { campaigns, campaignRecipients, messageVariations, campaignSchedules } from '@shared/schema';
import { eq, and, desc, lte } from 'drizzle-orm';
import { whatsAppService } from './WhatsAppService';
import { messageService } from './MessageService';
import { variationService } from './VariationService';
import { storage } from '../storage';
import { log } from '../utils';

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
  failed_list: Array<{ phone: string; name: string; reason: string }>;
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
  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerRunning = false;

  private normalizeTenant(tenant?: Partial<TenantContext>): TenantContext {
    return {
      organizationId: tenant?.organizationId || 'default_org',
      userId: tenant?.userId || 'default_user',
    };
  }

  private randomDelaySeconds(baseInterval: number, jitter: number): number {
    if (jitter <= 0) return baseInterval;
    const variance = Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;
    return Math.max(1, baseInterval + variance);
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
    return db
      .select()
      .from(campaigns)
      .where(and(
        eq(campaigns.organizationId, normalizedTenant.organizationId),
        eq(campaigns.userId, normalizedTenant.userId),
        eq(campaigns.campaignType, campaignType)
      ))
      .orderBy(desc(campaigns.createdAt));
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

    return campaign;
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

    return updated;
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

          await db.update(campaignSchedules)
            .set({
              status: 'completed',
              completedAt: new Date(),
              updatedAt: new Date(),
              resultSummary: result,
            })
            .where(eq(campaignSchedules.id, schedule.id));
        } catch (error) {
          await db.update(campaignSchedules)
            .set({
              status: 'failed',
              completedAt: new Date(),
              updatedAt: new Date(),
              resultSummary: {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
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

    // Get campaign
    const campaign = await this.getCampaign(campaignId, tenant);
    if (!campaign) {
      throw new Error('Campaign not found');
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
    const failedList: Array<{ phone: string; name: string; reason: string }> = [];

    // Send messages with on-demand variation generation
    for (let i = 0; i < contacts.length; i++) {
      // Check for stop signal
      if (this.stopFlags.get(campaignId)) {
        log(`🛑 Campaign ${campaignId} stopped by user request.`);
        break;
      }

      const contact = contacts[i];
      const contactNum = i + 1;

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
        if (campaign.attachmentPath) {
          log(`  📎 Sending with attachment: ${campaign.attachmentPath}`);
          await whatsAppService.sendMediaMessage(
            contact.phone,
            campaign.attachmentPath,
            fullMessage.trim()
          );
        } else {
          // Send text message (already includes buttons formatted as text)
          await whatsAppService.sendTextMessage(contact.phone, fullMessage.trim());
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
        log(`  ✅ Message sent successfully to ${contact.name}`);

        // Add random delay between messages (20-40 seconds)
        if (i < contacts.length - 1) {
          const delaySeconds = this.randomDelaySeconds(options?.intervalSeconds ?? 25, options?.jitterSeconds ?? 0);
          log(`  ⏳ Waiting ${delaySeconds} seconds before next message...`);

          // Check for stop signal during delay
          for (let d = 0; d < delaySeconds; d++) {
            if (this.stopFlags.get(campaignId)) break;
            await this.delay(1000);
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

    return {
      success: true,
      campaign_id: campaignId,
      total: contacts.length,
      sent,
      failed,
      failed_list: failedList,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const campaignService = new CampaignService();
