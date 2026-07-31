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
import { and, eq, gte, lte } from 'drizzle-orm';
import { sessionManager } from './WhatsAppSessionManager';
import { storage } from '../storage';
import { log } from '../utils';

// Give up on a follow-up that has been due (but unsendable) for longer than this.
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
// A send that never settles must not wedge the ticker — `running` would stay true
// forever and every later drip would silently stop going out.
const SEND_TIMEOUT_MS = 60 * 1000;
// Two rows carrying the same text to the same lead inside this window are a
// duplicate, not a deliberate repeat.
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// How often to re-report follow-ups held for a disconnected session.
const HELD_LOG_INTERVAL_MS = 10 * 60 * 1000;

export class LeadFollowupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  // Throttle the "waiting for a session" notice to one line per user per tick storm.
  private lastNoSessionLogAt = new Map<string, number>();

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

      let sent = 0, cancelled = 0, failed = 0, retrying = 0;
      // Rows we can't send yet, grouped by owner — a bare count of "due" says
      // nothing about WHY nothing is moving.
      const heldByUser = new Map<string, { count: number; sessions: string }>();
      // One session lookup per user per tick, not one per row.
      const sessionsByUser = new Map<string, Awaited<ReturnType<typeof sessionManager.listSessions>>>();

      for (const followup of due) {
        const tenant = { organizationId: followup.organizationId, userId: followup.userId };
        try {
          // Skip (and cancel) if the lead's chatbot was paused/opted out.
          const contact = await storage.getContactByTenant(tenant, followup.phoneNumber);
          if (contact?.chatbotActive === 'false') {
            log(`⏸️ Follow-up ${followup.id} to ${followup.phoneNumber} cancelled — chatbot paused for this lead`);
            await this.mark(followup.id, 'cancelled', 'chatbot paused for lead');
            cancelled++;
            continue;
          }

          // Never send the same text to the same lead twice. Two rows carrying
          // the same message (double ingest, overlapping pipelines, a drip that
          // duplicates a bot follow-up) otherwise both fire in the same tick and
          // the lead gets the message twice, one second apart.
          const [duplicate] = await db.select({ id: leadFollowups.id }).from(leadFollowups).where(and(
            eq(leadFollowups.organizationId, followup.organizationId),
            eq(leadFollowups.userId, followup.userId),
            eq(leadFollowups.phoneNumber, followup.phoneNumber),
            eq(leadFollowups.message, followup.message),
            eq(leadFollowups.status, 'sent'),
            gte(leadFollowups.sentAt, new Date(now.getTime() - DUPLICATE_WINDOW_MS)),
          )).limit(1);
          if (duplicate) {
            log(`🚫 Follow-up ${followup.id} to ${followup.phoneNumber} cancelled — same message already sent (${duplicate.id})`);
            await this.mark(followup.id, 'cancelled', `duplicate of already-sent follow-up ${duplicate.id}`);
            cancelled++;
            continue;
          }

          let sessions = sessionsByUser.get(followup.userId);
          if (!sessions) {
            sessions = await sessionManager.listSessions(followup.userId);
            sessionsByUser.set(followup.userId, sessions);
          }
          const connected = sessions.find((s) => s.status === 'connected');
          if (!connected) {
            const overdueMs = now.getTime() - new Date(followup.scheduledAt).getTime();
            if (overdueMs > STALE_AFTER_MS) {
              log(`❌ Follow-up ${followup.id} to ${followup.phoneNumber} expired — no connected WhatsApp session for 3 days`);
              await this.mark(followup.id, 'failed', 'no connected WhatsApp session before expiry');
              failed++;
              continue;
            }
            // Leave scheduled — retry on a later tick when a session connects.
            // This used to be entirely silent, which made a stalled drip look
            // identical to one that was never scheduled at all.
            const held = heldByUser.get(followup.userId);
            if (held) {
              held.count++;
            } else {
              heldByUser.set(followup.userId, {
                count: 1,
                sessions: JSON.stringify(sessions.map((s) => ({ sessionName: s.sessionName, status: s.status }))),
              });
            }
            continue;
          }

          const wa = await sessionManager.getSession(followup.userId, connected.sessionName);
          await this.withTimeout(
            wa.sendTextMessage(followup.phoneNumber, followup.message),
            `send to ${followup.phoneNumber} timed out after ${SEND_TIMEOUT_MS / 1000}s`,
          );

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
          sent++;
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Unknown error';
          const overdueMs = now.getTime() - new Date(followup.scheduledAt).getTime();
          // A socket that is down/reconnecting is transient — the DB can say
          // "connected" while Baileys is mid-restart. Retry on a later tick
          // instead of burning the message, until it goes stale.
          if (this.isTransient(reason) && overdueMs <= STALE_AFTER_MS) {
            log(`⏳ Retrying follow-up ${followup.id} to ${followup.phoneNumber} later: ${reason}`);
            retrying++;
            continue;
          }
          log(`⚠️ Failed to send follow-up ${followup.id} to ${followup.phoneNumber}: ${reason}`);
          await this.mark(followup.id, 'failed', reason);
          failed++;
        }
      }

      // Only report a tick that did something; a steady "N due" line every 30s
      // is noise that hides the one line that matters.
      if (sent || cancelled || failed || retrying) {
        log(`⏰ Lead follow-up tick: ${due.length} due → ${sent} sent, ${cancelled} cancelled, ${failed} failed, ${retrying} retrying, ${due.length - sent - cancelled - failed - retrying} held`);
      }
      heldByUser.forEach((held, userId) => {
        const lastLoggedAt = this.lastNoSessionLogAt.get(userId) || 0;
        if (Date.now() - lastLoggedAt > HELD_LOG_INTERVAL_MS) {
          this.lastNoSessionLogAt.set(userId, Date.now());
          log(`⏳ Holding ${held.count} lead follow-up(s) for user ${userId}: no connected WhatsApp session (sessions: ${held.sessions})`);
        }
      });
    } finally {
      this.running = false;
    }
  }

  private isTransient(reason: string): boolean {
    return /not connected|timed out|timeout|connection closed|socket|ECONNRESET|restart/i.test(reason);
  }

  private withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), SEND_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer!)) as Promise<T>;
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
