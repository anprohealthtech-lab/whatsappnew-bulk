import { WhatsAppService } from './WhatsAppService';
import { db } from '../db';
import { whatsappSessions } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { log } from '../utils';
import type { WhatsAppSession } from '@shared/schema';

/**
 * Manages per-user WhatsApp sessions.
 * Each user gets their own Baileys instance backed by a unique session directory.
 */
export class WhatsAppSessionManager {
  private sessions = new Map<string, WhatsAppService>();

  /** Build a consistent key for lookup */
  private key(userId: string, sessionName = 'default'): string {
    return `${userId}::${sessionName}`;
  }

  /**
   * Get or create a WhatsApp service instance for a user.
   * On first access, creates a new Baileys session with its own auth directory.
   */
  async getSession(userId: string, sessionName = 'default'): Promise<WhatsAppService> {
    const k = this.key(userId, sessionName);

    if (this.sessions.has(k)) {
      return this.sessions.get(k)!;
    }

    // Create new WhatsApp service with unique session dir
    const sessionDir = `server/sessions/user_${userId}/${sessionName}`;
    const service = new WhatsAppService(sessionDir);

    // Wire up status persistence
    service.on('whatsapp-authenticated', async () => {
      await this.updateSessionStatus(userId, sessionName, 'connected');
    });
    service.on('whatsapp-auth-failure', async () => {
      await this.updateSessionStatus(userId, sessionName, 'disconnected');
    });
    service.on('qr-code', async () => {
      await this.updateSessionStatus(userId, sessionName, 'qr_pending');
    });

    this.sessions.set(k, service);

    // Ensure DB record exists
    await this.ensureSessionRecord(userId, sessionName);

    return service;
  }

  /** Get a session only if already loaded (no DB creation) */
  getLoadedSession(userId: string, sessionName = 'default'): WhatsAppService | undefined {
    return this.sessions.get(this.key(userId, sessionName));
  }

  /** List all sessions for a user from DB */
  async listSessions(userId: string): Promise<WhatsAppSession[]> {
    return db.select().from(whatsappSessions)
      .where(eq(whatsappSessions.userId, userId));
  }

  /** Remove and clean up a session */
  async removeSession(userId: string, sessionName = 'default'): Promise<void> {
    const k = this.key(userId, sessionName);
    const service = this.sessions.get(k);
    if (service) {
      await service.cleanup();
      this.sessions.delete(k);
    }
  }

  /**
   * Restore all sessions that were previously connected.
   * Called on server boot to reconnect persistent sessions.
   */
  async restoreConnectedSessions(): Promise<void> {
    try {
      const connectedSessions = await db.select().from(whatsappSessions)
        .where(eq(whatsappSessions.status, 'connected'));

      log(`🔄 Restoring ${connectedSessions.length} WhatsApp session(s)...`);

      for (const sess of connectedSessions) {
        try {
          const service = await this.getSession(sess.userId, sess.sessionName);
          await service.initialize();
          log(`✅ Restored session for user ${sess.userId} (${sess.sessionName})`);
        } catch (err) {
          log(`⚠️ Failed to restore session for user ${sess.userId}: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
      }
    } catch (err) {
      log(`⚠️ Session restore skipped: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }

  /** Clean up all active sessions (graceful shutdown) */
  async shutdownAll(): Promise<void> {
    log(`🔌 Shutting down ${this.sessions.size} WhatsApp session(s)...`);
    const promises: Promise<void>[] = [];
    this.sessions.forEach((service) => {
      promises.push(service.cleanup());
    });
    await Promise.allSettled(promises);
    this.sessions.clear();
  }

  /** Number of currently loaded sessions */
  get activeCount(): number {
    return this.sessions.size;
  }

  /** Ensure whatsapp_sessions row exists in DB */
  private async ensureSessionRecord(userId: string, sessionName: string): Promise<void> {
    try {
      const existing = await db.select().from(whatsappSessions)
        .where(and(
          eq(whatsappSessions.userId, userId),
          eq(whatsappSessions.sessionName, sessionName),
        )).limit(1);

      if (existing.length === 0) {
        await db.insert(whatsappSessions).values({
          userId,
          sessionName,
          status: 'disconnected',
        });
      }
    } catch {
      // Table may not exist yet during migration — non-fatal
    }
  }

  /** Update session status in DB */
  private async updateSessionStatus(userId: string, sessionName: string, status: string): Promise<void> {
    try {
      await db.update(whatsappSessions).set({
        status,
        lastConnectedAt: status === 'connected' ? new Date() : undefined,
        updatedAt: new Date(),
      }).where(and(
        eq(whatsappSessions.userId, userId),
        eq(whatsappSessions.sessionName, sessionName),
      ));
    } catch {
      // Non-fatal — log silently
    }
  }
}

export const sessionManager = new WhatsAppSessionManager();
