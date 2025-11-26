import { db } from '../db';
import { campaigns, campaignRecipients, messageVariations } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
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

export class CampaignService {

  async createCampaign(
    name: string,
    originalMessage: string,
    fixedParams?: Record<string, any>,
    buttons?: Array<{ text: string; url?: string; phoneNumber?: string }>,
    includeStopButton?: boolean
  ) {
    const [campaign] = await db.insert(campaigns).values({
      name,
      originalMessage,
      fixedParams: fixedParams || {},
      buttons: buttons || [],
      includeStopButton: includeStopButton ? 'true' : 'false',
    }).returning();

    return campaign;
  }

  async getCampaign(campaignId: string) {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));

    return campaign;
  }

  async updateCampaignVariation(campaignId: string, variation: string) {
    const [updated] = await db
      .update(campaigns)
      .set({
        selectedVariation: variation,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId))
      .returning();

    return updated;
  }

  async updateCampaignAttachment(campaignId: string, filePath: string, fileName: string) {
    const [updated] = await db
      .update(campaigns)
      .set({
        attachmentPath: filePath,
        attachmentName: fileName,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId))
      .returning();

    return updated;
  }

  async saveMessageVariation(campaignId: string, variation: string) {
    const [saved] = await db
      .insert(messageVariations)
      .values({
        campaignId,
        message: variation, // Updated: variation column renamed to message
      })
      .returning();

    return saved;
  }

  async getMessageVariations(campaignId: string) {
    const variations = await db
      .select()
      .from(messageVariations)
      .where(eq(messageVariations.campaignId, campaignId))
      .orderBy(messageVariations.createdAt);

    return variations;
  }

  async uploadContacts(campaignId: string, contacts: ContactRow[]) {
    // Validate campaign exists
    const campaign = await this.getCampaign(campaignId);
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

  async getContacts(campaignId: string) {
    const contacts = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId));

    return contacts;
  }

  private stopFlags = new Map<string, boolean>();

  stopCampaign(campaignId: string) {
    this.stopFlags.set(campaignId, true);
    log(`🛑 Stop signal received for campaign ${campaignId}`);
  }

  async sendBulkMessages(
    campaignId: string,
    variationMessage: string,
    contactsInput?: ContactRow[]
  ): Promise<BulkSendResult> {
    // Reset stop flag
    this.stopFlags.set(campaignId, false);

    // Get campaign
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    // Get contacts (from input or DB)
    let contacts: ContactRow[];
    if (contactsInput && contactsInput.length > 0) {
      contacts = contactsInput;
    } else {
      const dbContacts = await this.getContacts(campaignId);
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
    log(`📝 Original message: ${campaign.originalMessage}`);
    log(`📎 Attachment path: ${campaign.attachmentPath || 'None'}`);
    log(`🔧 Fixed params: ${JSON.stringify(campaign.fixedParams)}`);

    // Pre-warm 3 variations to have ready immediately
    log(`🔥 Pre-warming first 3 variations...`);
    await variationService.prewarmVariations(
      campaignId,
      campaign.originalMessage,
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
          message: campaign.originalMessage,
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

        // Add random delay between messages (60-90 seconds as specified)
        if (i < contacts.length - 1) {
          const delaySeconds = 60 + Math.floor(Math.random() * 31); // 60-90 seconds
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
