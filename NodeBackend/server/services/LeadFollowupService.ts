/**
 * LeadFollowupService — drains bot-scheduled follow-up messages.
 *
 * ChatbotService writes rows into `lead_followups` when the bot emits a
 * <<FOLLOWUP:...>> directive. This service runs a periodic tick that picks up
 * due rows, resolves the owning user's connected WhatsApp session, and sends the
 * message. Paused leads are skipped; rows that stay unsendable for too long are
 * marked failed so they don't retry forever.
 */

import { db } from '../db';
import { leadFollowups } from '@shared/schema';
import { and, eq, lte } from 'drizzle-orm';
import { sessionManager } from './WhatsAppSessionManager';
import { storage } from '../storage';
import { log } from '../utils';

// Give up on a follow-up that has been due (but unsendable) for longer than this.
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export class LeadFollowupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  startScheduler(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runDue().catch((error) => {
        log(`❌ Lead follow-up tick failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      });
    }, 30000);
    log('⏰ Lead follow-up scheduler started (30s tick)');
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runDue(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const now = new Date();
      const due = await db.select().from(leadFollowups).where(and(
        eq(leadFollowups.status, 'scheduled'),
        lte(leadFollowups.scheduledAt, now),
      ));

      for (const followup of due) {
        const tenant = { organizationId: followup.organizationId, userId: followup.userId };
        try {
          // Skip (and cancel) if the lead's chatbot was paused/opted out.
          const contact = await storage.getContactByTenant(tenant, followup.phoneNumber);
          if (contact?.chatbotActive === 'false') {
            await this.mark(followup.id, 'cancelled', 'chatbot paused for lead');
            continue;
          }

          const sessions = await sessionManager.listSessions(followup.userId);
          const connected = sessions.find((s) => s.status === 'connected');
          if (!connected) {
            const overdueMs = now.getTime() - new Date(followup.scheduledAt).getTime();
            if (overdueMs > STALE_AFTER_MS) {
              await this.mark(followup.id, 'failed', 'no connected WhatsApp session before expiry');
            }
            // else leave scheduled — retry on a later tick when a session connects
            continue;
          }

          const wa = await sessionManager.getSession(followup.userId, connected.sessionName);
          await wa.sendTextMessage(followup.phoneNumber, followup.message);

          await this.mark(followup.id, 'sent');

          await storage.createMessage({
            organizationId: followup.organizationId,
            userId: followup.userId,
            phoneNumber: followup.phoneNumber,
            content: followup.message,
            type: 'text',
            status: 'sent',
            metadata: { chatbot_followup: true, followup_id: followup.id },
          });

          log(`📤 Sent bot follow-up ${followup.id} to ${followup.phoneNumber}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Unknown error';
          log(`⚠️ Failed to send follow-up ${followup.id}: ${reason}`);
          await this.mark(followup.id, 'failed', reason);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async mark(id: string, status: 'sent' | 'failed' | 'cancelled', errorReason?: string): Promise<void> {
    await db.update(leadFollowups)
      .set({
        status,
        sentAt: status === 'sent' ? new Date() : undefined,
        errorReason: errorReason ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(leadFollowups.id, id));
  }
}

export const leadFollowupService = new LeadFollowupService();
