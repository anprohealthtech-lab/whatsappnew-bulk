/**
 * ExternalBulkSendService
 *
 * In-memory async bulk-send job runner for the external machine-to-machine API.
 * Jobs respond immediately (202) and process in the background with randomized
 * pacing between messages (same approach as CampaignService) to reduce ban risk.
 *
 * Jobs are NOT persisted — a process restart loses running/completed jobs, and
 * bulk-status returns 404 for unknown job ids.
 */

import { randomUUID } from 'crypto';
import { log } from '../utils';
import type { WAServiceInstance } from './WhatsAppSessionManager';

const COMPLETED_JOB_TTL_MS = 60 * 60 * 1000; // keep finished jobs queryable for 1h
const MAX_STORED_ERRORS = 50;

export function normalizeExternalPhone(phoneNumber: string): string {
  const input = String(phoneNumber || '').trim();
  if (input.includes('@')) return input; // already a WhatsApp jid
  let cleaned = input.replace(/[^0-9]/g, '');
  if (cleaned.length === 10 && !cleaned.startsWith('91')) {
    cleaned = '91' + cleaned;
  }
  if (cleaned.length < 10 || cleaned.length > 15) {
    throw new Error(`Invalid phone number: ${phoneNumber}`);
  }
  return cleaned;
}

export interface BulkJobMedia {
  filePath: string;
  fileName?: string;
  caption?: string;
  cleanup: () => void;
}

export interface StartBulkJobOptions {
  userId: string;
  sessionName: string;
  session: WAServiceInstance;
  recipients: string[];
  message: string;
  media?: BulkJobMedia;
  intervalSeconds: number;
  jitterSeconds: number;
}

export interface BulkJobSnapshot {
  jobId: string;
  userId: string;
  sessionName: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  total: number;
  processed: number;
  sent: number;
  failed: number;
  errors: Array<{ phoneNumber: string; error: string }>;
  createdAt: Date;
  completedAt: Date | null;
}

class ExternalBulkSendService {
  private jobs = new Map<string, BulkJobSnapshot>();
  private stopRequested = new Set<string>();

  getRunningJobForUser(userId: string): BulkJobSnapshot | null {
    for (const job of Array.from(this.jobs.values())) {
      if (job.userId === userId && job.status === 'running') return job;
    }
    return null;
  }

  getJob(jobId: string): BulkJobSnapshot | null {
    return this.jobs.get(jobId) || null;
  }

  stopJob(jobId: string): BulkJobSnapshot | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === 'running') {
      this.stopRequested.add(jobId);
    }
    return job;
  }

  startJob(opts: StartBulkJobOptions): BulkJobSnapshot {
    const job: BulkJobSnapshot = {
      jobId: randomUUID(),
      userId: opts.userId,
      sessionName: opts.sessionName,
      status: 'running',
      total: opts.recipients.length,
      processed: 0,
      sent: 0,
      failed: 0,
      errors: [],
      createdAt: new Date(),
      completedAt: null,
    };
    this.jobs.set(job.jobId, job);
    void this.runJob(job, opts);
    return job;
  }

  estimateDurationSeconds(recipientCount: number, intervalSeconds: number): number {
    return Math.max(0, recipientCount - 1) * intervalSeconds;
  }

  private randomDelaySeconds(baseInterval: number, jitter: number): number {
    if (jitter <= 0) return baseInterval;
    const minDelay = Math.max(3, Math.ceil(baseInterval * 0.15));
    const effectiveJitter = Math.min(jitter, baseInterval - minDelay);
    if (effectiveJitter <= 0) return baseInterval;
    const variance = Math.floor(Math.random() * (effectiveJitter * 2 + 1)) - effectiveJitter;
    return Math.max(minDelay, baseInterval + variance);
  }

  /** Sleep in 1s ticks, checking the stop flag. Returns false if a stop was requested. */
  private async sleepWithStopCheck(jobId: string, seconds: number): Promise<boolean> {
    for (let i = 0; i < seconds; i++) {
      if (this.stopRequested.has(jobId)) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return !this.stopRequested.has(jobId);
  }

  private async runJob(job: BulkJobSnapshot, opts: StartBulkJobOptions): Promise<void> {
    log(`[ExtBulk] Job ${job.jobId} started for user ${opts.userId}: ${job.total} recipients, interval ${opts.intervalSeconds}s ± ${opts.jitterSeconds}s`);
    try {
      for (let i = 0; i < opts.recipients.length; i++) {
        if (this.stopRequested.has(job.jobId)) {
          job.status = 'stopped';
          break;
        }

        const recipient = opts.recipients[i];
        try {
          const phone = normalizeExternalPhone(recipient);
          if (opts.media) {
            await opts.session.sendMediaMessage(
              phone,
              opts.media.filePath,
              opts.media.caption || opts.message,
              opts.media.fileName,
            );
          } else {
            await opts.session.sendTextMessage(phone, opts.message);
          }
          job.sent++;
        } catch (error) {
          job.failed++;
          if (job.errors.length < MAX_STORED_ERRORS) {
            job.errors.push({
              phoneNumber: recipient,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }
        job.processed++;

        if (i < opts.recipients.length - 1) {
          const delay = this.randomDelaySeconds(opts.intervalSeconds, opts.jitterSeconds);
          if (!await this.sleepWithStopCheck(job.jobId, delay)) {
            job.status = 'stopped';
            break;
          }
        }
      }

      if (job.status === 'running') {
        job.status = 'completed';
      }
    } catch (error) {
      job.status = 'failed';
      log(`[ExtBulk] Job ${job.jobId} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      job.completedAt = new Date();
      this.stopRequested.delete(job.jobId);
      try {
        opts.media?.cleanup();
      } catch {
        // best-effort temp file cleanup
      }
      log(`[ExtBulk] Job ${job.jobId} ${job.status}: ${job.sent} sent, ${job.failed} failed of ${job.total}`);
      const timer = setTimeout(() => this.jobs.delete(job.jobId), COMPLETED_JOB_TTL_MS);
      timer.unref?.();
    }
  }
}

export const externalBulkSendService = new ExternalBulkSendService();
