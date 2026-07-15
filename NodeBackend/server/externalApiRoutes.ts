/**
 * External machine-to-machine WhatsApp API (x-api-key).
 *
 * Lets an external app act on behalf of an ALREADY-REGISTERED user:
 * connect via QR, poll QR/status, disconnect, send text/media, bulk send.
 *
 * The paths match the provider contract that ExternalWhatsAppProxy consumes,
 * so another instance of this codebase (with EXTERNAL_WA_API_URL pointing here)
 * works as a client without changes. To serve as provider, this instance must
 * run with EXTERNAL_WA_API_URL unset — otherwise sessionManager proxies upstream.
 *
 * Auth: `x-api-key` header (or `Authorization: Bearer`) matching EXTERNAL_WA_API_KEY.
 * The target user is selected via the `userId` route param or body field and must
 * exist in the users table (404 otherwise) — users are never auto-created here.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { log } from './utils';
import { sessionManager, type WAServiceInstance } from './services/WhatsAppSessionManager';
import { externalBulkSendService, normalizeExternalPhone, type BulkJobMedia } from './services/ExternalBulkSendService';

const EXTERNAL_API_KEY = process.env.EXTERNAL_WA_API_KEY || 'whatsapp-lims-api-key-2024';
const MAX_SESSIONS_PER_USER = 3;
const BULK_MAX_RECIPIENTS = parseInt(process.env.EXTERNAL_BULK_MAX_RECIPIENTS || '200');
const MEDIA_MAX_BYTES = parseInt(process.env.EXTERNAL_MEDIA_MAX_BYTES || String(25 * 1024 * 1024));
const QR_STALE_MS = 60_000; // Baileys qrTimeout — older codes are no longer scannable
const SYNCABLE_ADMIN_ROLES = new Set(['admin', 'superadmin', 'super_admin', 'owner']);

const externalUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_MAX_BYTES },
});

function httpError(status: number, message: string): Error {
  const error = new Error(message);
  (error as any).status = status;
  return error;
}

function sendError(res: Response, error: unknown): void {
  const status = (error as any)?.status || 500;
  const message = error instanceof Error ? error.message : 'Unknown error';
  res.status(status).json({ success: false, error: message });
}

function verifyExternalApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (apiKey !== EXTERNAL_API_KEY) {
    res.status(401).json({ success: false, error: 'Invalid API key' });
    return;
  }
  next();
}

function normalizeExternalRole(role: unknown): 'admin' | 'super_admin' {
  const value = String(role || '').trim().toLowerCase();
  return value === 'super_admin' ? 'super_admin' : 'admin';
}

function toExternalUsername(user: any): string {
  const id = String(user?.id || '').trim();
  const email = String(user?.email || '').trim().toLowerCase();
  const base = email || String(user?.username || user?.name || id).trim().toLowerCase();
  const slug = base.replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return `external_${slug || id}`;
}

async function syncExternalAdminUsers(
  organizationId: string,
  admins: any[],
): Promise<Array<{ id: string; username: string; role: string }>> {
  const passwordHash = await bcrypt.hash(`external-sync-disabled-${Date.now()}-${randomUUID()}`, 12);
  const synced: Array<{ id: string; username: string; role: string }> = [];

  for (const admin of admins) {
    const id = String(admin?.id || '').trim();
    const roleInput = String(admin?.role || '').trim().toLowerCase();
    if (!id || !SYNCABLE_ADMIN_ROLES.has(roleInput)) {
      continue;
    }

    const username = toExternalUsername(admin);
    const email = String(admin?.email || '').trim() || null;
    const role = normalizeExternalRole(roleInput);

    await db.execute(sql`
      INSERT INTO users (id, username, password, email, organization_id, role, created_at, updated_at)
      VALUES (${id}, ${username}, ${passwordHash}, ${email}, ${organizationId}, ${role}, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        email = EXCLUDED.email,
        organization_id = EXCLUDED.organization_id,
        role = EXCLUDED.role,
        updated_at = now()
    `);

    synced.push({ id, username, role });
  }

  return synced;
}

/**
 * Resolve the target user from :userId param or body.userId/body.id and set
 * req.auth (same shape as JWT auth) so tenant helpers behave identically.
 * 404s when the user is not registered — this API never creates users.
 */
async function resolveExternalUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = String(req.params.userId || req.body?.userId || req.body?.id || '').trim();
    if (!userId) {
      res.status(400).json({ success: false, error: 'userId is required' });
      return;
    }
    // Keep this lookup raw and narrow so older provider databases that do not
    // have every column from shared/schema.ts can still perform the handshake.
    const result = await db.execute(sql`
      SELECT id, username, organization_id, role
      FROM users
      WHERE id = ${userId}
      LIMIT 1
    `) as any;
    const rows = Array.isArray(result) ? result : result?.rows || [];
    const user = rows[0];
    if (!user) {
      res.status(404).json({ success: false, error: `User ${userId} not registered` });
      return;
    }
    req.auth = {
      userId: user.id,
      username: user.username,
      organizationId: user.organization_id || user.organizationId || 'default_org',
      role: user.role || 'user',
    };
    next();
  } catch (error) {
    sendError(res, error);
  }
}

async function toQrDataUrl(rawQR: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(rawQR, { width: 512, margin: 2 });
  } catch {
    return null;
  }
}

type QrInfo = ReturnType<WAServiceInstance['getCurrentQR']>;

async function buildQrPayload(qrData: QrInfo) {
  const rawQR = qrData?.rawQR || null;
  return {
    // `qrCode` carries the raw pairing string (what ExternalWhatsAppProxy expects)
    qrCode: rawQR,
    qrCodeUrl: qrData?.qrCode || qrData?.qr || null,
    qrDataUrl: rawQR ? await toQrDataUrl(rawQR) : null,
    qrTimestamp: qrData?.timestamp || null,
  };
}

/** Wait for the first QR after initialize(); resolves null on timeout. */
function waitForQr(session: WAServiceInstance, timeoutMs = 12_000): Promise<QrInfo> {
  const existing = session.getCurrentQR();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(session.getCurrentQR());
    };
    const timer = setTimeout(finish, timeoutMs);
    (session as any).once?.('qr-code', finish);
    (session as any).once?.('whatsapp-authenticated', finish);
  });
}

function getLoadedSessionForUser(userId: string, sessionName?: string): WAServiceInstance | undefined {
  if (sessionName) {
    return sessionManager.getLoadedSession(userId, sessionName);
  }
  const loaded = sessionManager.getAllLoadedSessions().filter((entry) => entry.userId === userId);
  const connected = loaded.find((entry) => entry.service.getStatus().isConnected);
  return (connected || loaded[0])?.service;
}

async function getConnectedSessionForUser(userId: string, sessionName?: string): Promise<WAServiceInstance> {
  const session = sessionName
    ? sessionManager.getLoadedSession(userId, sessionName)
    : await sessionManager.getFirstConnectedSession(userId);
  if (!session || !session.getStatus().isConnected) {
    throw httpError(503, `No connected WhatsApp session for user ${userId}. Connect via /api/users/${userId}/whatsapp/connect first.`);
  }
  return session;
}

function normalizePhoneOr400(phoneNumber: unknown): string {
  try {
    return normalizeExternalPhone(String(phoneNumber || ''));
  } catch (error) {
    throw httpError(400, error instanceof Error ? error.message : 'Invalid phone number');
  }
}

function writeTempFile(buffer: Buffer, displayName: string): { filePath: string; cleanup: () => void } {
  const ext = path.extname(displayName) || '';
  const filePath = path.join(os.tmpdir(), `ext-wa-${randomUUID()}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return {
    filePath,
    cleanup: () => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // already gone
      }
    },
  };
}

async function downloadToTempFile(fileUrl: string, fileName?: string): Promise<BulkJobMedia> {
  let parsed: URL;
  try {
    parsed = new URL(String(fileUrl || ''));
  } catch {
    throw httpError(400, 'Invalid fileUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw httpError(400, 'fileUrl must use http or https');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(parsed.toString(), { signal: controller.signal });
    if (!response.ok) {
      throw httpError(400, `Failed to download fileUrl (HTTP ${response.status})`);
    }
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    if (contentLength > MEDIA_MAX_BYTES) {
      throw httpError(400, `File exceeds maximum size of ${MEDIA_MAX_BYTES} bytes`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MEDIA_MAX_BYTES) {
      throw httpError(400, `File exceeds maximum size of ${MEDIA_MAX_BYTES} bytes`);
    }
    const displayName = String(fileName || '').trim() || path.basename(parsed.pathname) || 'file';
    const temp = writeTempFile(buffer, displayName);
    return { filePath: temp.filePath, fileName: displayName, cleanup: temp.cleanup };
  } catch (error) {
    if ((error as any)?.name === 'AbortError') {
      throw httpError(400, 'Timed out downloading fileUrl');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function registerExternalApiRoutes(app: Express): void {
  // ============================================================
  // EXTERNAL MACHINE-TO-MACHINE API (x-api-key)
  // ============================================================

  // Validate that a user is registered. Never creates users — the external
  // consumer treats sync failure as non-fatal, so 404 here enforces
  // "registered users only" while staying proxy-compatible.
  app.post('/api/external/users/sync', verifyExternalApiKey, resolveExternalUser, (req, res) => {
    res.json({ success: true, data: { userId: req.auth!.userId, existed: true } });
  });

  // Upsert task-manager organization admins into the WhatsApp backend. This is
  // intentionally separate from /users/sync: that endpoint validates one user,
  // while this endpoint is the trusted batch bridge used by the external app.
  app.post('/api/external/users/sync-admins', verifyExternalApiKey, async (req, res) => {
    try {
      const organizationId = String(req.body?.organizationId || '').trim();
      const admins = Array.isArray(req.body?.admins) ? req.body.admins : [];
      if (!organizationId) {
        throw httpError(400, 'organizationId is required');
      }
      if (admins.length === 0) {
        throw httpError(400, 'admins must be a non-empty array');
      }

      const synced = await syncExternalAdminUsers(organizationId, admins);
      res.json({
        success: true,
        data: {
          organizationId,
          received: admins.length,
          synced: synced.length,
          users: synced,
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Init (or re-init) the user's session and return the first QR.
  app.post('/api/users/:userId/whatsapp/connect', verifyExternalApiKey, resolveExternalUser, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const sessionName = String(req.body?.sessionName || 'default');

      const existingSessions = await sessionManager.listSessions(userId);
      const isExisting = existingSessions.some((s) => s.sessionName === sessionName);
      if (!isExisting && existingSessions.length >= MAX_SESSIONS_PER_USER) {
        throw httpError(400, `Maximum ${MAX_SESSIONS_PER_USER} sessions allowed per user. Disconnect an existing session first.`);
      }

      const session = await sessionManager.getSession(userId, sessionName);
      const status = session.getStatus();
      if (status.isConnected) {
        return res.json({
          success: true,
          data: {
            status: 'connected',
            sessionName,
            phoneNumber: (status.sessionInfo as any)?.id?.split(':')[0] || null,
          },
        });
      }

      await session.initialize();
      const qrData = await waitForQr(session);
      const connectedNow = session.getStatus().isConnected;
      res.json({
        success: true,
        data: {
          status: connectedNow ? 'connected' : qrData ? 'qr_pending' : 'initializing',
          sessionName,
          ...(await buildQrPayload(qrData)),
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Status of all the user's sessions (DB records merged with live state).
  app.get('/api/users/:userId/whatsapp/status', verifyExternalApiKey, resolveExternalUser, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const dbSessions = await sessionManager.listSessions(userId);
      const sessions = dbSessions.map((record) => {
        const live = sessionManager.getLoadedSession(userId, record.sessionName);
        const liveStatus = live?.getStatus();
        return {
          sessionId: record.id,
          sessionName: record.sessionName,
          status: liveStatus?.isConnected ? 'connected' : record.status,
          phoneNumber: record.phoneNumber,
          isConnected: Boolean(liveStatus?.isConnected),
          isAuthenticated: Boolean(liveStatus?.isAuthenticated),
          lastConnectedAt: record.lastConnectedAt,
        };
      });
      // Connected sessions first — consumers read sessions[0]
      sessions.sort((a, b) => Number(b.isConnected) - Number(a.isConnected));
      res.json({ success: true, data: { sessions } });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Get a fresh QR: 409 if already connected; re-inits when the QR is stale/missing.
  app.post('/api/users/:userId/whatsapp/refresh-qr', verifyExternalApiKey, resolveExternalUser, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const sessionName = String(req.body?.sessionName || 'default');
      const session = await sessionManager.getSession(userId, sessionName);

      if (session.getStatus().isConnected) {
        throw httpError(409, 'Session is already connected');
      }

      let qrData = session.getCurrentQR();
      const isStale = !qrData || Date.now() - qrData.timestamp > QR_STALE_MS;
      if (isStale) {
        await session.initialize();
        qrData = await waitForQr(session);
      }
      res.json({
        success: true,
        data: {
          status: session.getStatus().isConnected ? 'connected' : qrData ? 'qr_pending' : 'initializing',
          sessionName,
          ...(await buildQrPayload(qrData)),
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Pollable QR read — never re-initializes the session.
  app.get('/api/users/:userId/whatsapp/qr', verifyExternalApiKey, resolveExternalUser, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const sessionName = (req.query.sessionName as string) || 'default';
      const session = sessionManager.getLoadedSession(userId, sessionName);
      const status = session?.getStatus();
      const qrData = session?.getCurrentQR() || null;
      res.json({
        success: true,
        data: {
          status: status?.isConnected ? 'connected' : qrData ? 'qr_pending' : session ? 'initializing' : 'not_initialized',
          sessionName,
          ...(await buildQrPayload(qrData)),
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Liveness check — reads loaded session state only, no side effects.
  app.post('/api/external/sessions/pulse', verifyExternalApiKey, resolveExternalUser, (req, res) => {
    const sessionName = req.body?.sessionName ? String(req.body.sessionName) : undefined;
    const session = getLoadedSessionForUser(req.auth!.userId, sessionName);
    const status = session?.getStatus();
    res.json({
      success: true,
      data: {
        alive: Boolean(status?.isConnected),
        isAuthenticated: Boolean(status?.isAuthenticated),
      },
    });
  });

  // Logout and clear persisted auth for the session.
  app.post('/api/external/sessions/disconnect', verifyExternalApiKey, resolveExternalUser, async (req, res) => {
    try {
      const sessionName = String(req.body?.sessionName || 'default');
      await sessionManager.removeSession(req.auth!.userId, sessionName);
      res.json({ success: true, data: { status: 'disconnected', sessionName } });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Send a text message from the user's connected session.
  app.post('/api/external/messages/send-user', verifyExternalApiKey, resolveExternalUser, async (req, res) => {
    try {
      const { phoneNumber, message, sessionName } = req.body || {};
      if (!phoneNumber || !message) {
        throw httpError(400, 'phoneNumber and message are required');
      }
      const phone = normalizePhoneOr400(phoneNumber);
      const session = await getConnectedSessionForUser(req.auth!.userId, sessionName);
      const result = await session.sendTextMessage(phone, String(message));
      log(`[ExtAPI] Text sent for user ${req.auth!.userId} to ${result?.to || phone}`);
      res.json({ success: true, data: { messageId: result?.id || null, to: result?.to || phone } });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Send media/document fetched from a URL.
  app.post('/api/external/reports/send-url', verifyExternalApiKey, resolveExternalUser, async (req, res) => {
    try {
      const { phoneNumber, fileUrl, fileName, caption, sessionName } = req.body || {};
      if (!phoneNumber || !fileUrl) {
        throw httpError(400, 'phoneNumber and fileUrl are required');
      }
      const phone = normalizePhoneOr400(phoneNumber);
      const session = await getConnectedSessionForUser(req.auth!.userId, sessionName);
      const media = await downloadToTempFile(String(fileUrl), fileName ? String(fileName) : undefined);
      try {
        const result = await session.sendMediaMessage(phone, media.filePath, caption ? String(caption) : undefined, media.fileName);
        log(`[ExtAPI] Media (${media.fileName}) sent for user ${req.auth!.userId} to ${result?.to || phone}`);
        res.json({ success: true, data: { messageId: result?.id || null, to: result?.to || phone, fileName: media.fileName } });
      } finally {
        media.cleanup();
      }
    } catch (error) {
      sendError(res, error);
    }
  });

  // Send media/document uploaded as multipart form data (field name: "file").
  app.post('/api/external/messages/send-media', verifyExternalApiKey, externalUpload.single('file'), resolveExternalUser, async (req, res) => {
    try {
      const uploadedFile = (req as any).file as { originalname?: string; buffer: Buffer } | undefined;
      if (!uploadedFile) {
        throw httpError(400, 'No file provided (multipart field "file")');
      }
      const { phoneNumber, caption, sessionName } = req.body || {};
      if (!phoneNumber) {
        throw httpError(400, 'phoneNumber is required');
      }
      const phone = normalizePhoneOr400(phoneNumber);
      const session = await getConnectedSessionForUser(req.auth!.userId, sessionName);
      const displayName = uploadedFile.originalname || 'file';
      const temp = writeTempFile(uploadedFile.buffer, displayName);
      try {
        const result = await session.sendMediaMessage(phone, temp.filePath, caption ? String(caption) : undefined, displayName);
        log(`[ExtAPI] Uploaded media (${displayName}) sent for user ${req.auth!.userId} to ${result?.to || phone}`);
        res.json({ success: true, data: { messageId: result?.id || null, to: result?.to || phone, fileName: displayName } });
      } finally {
        temp.cleanup();
      }
    } catch (error) {
      sendError(res, error);
    }
  });

  // Bulk paced send — responds 202 immediately, processes in the background.
  app.post('/api/external/messages/send-bulk', verifyExternalApiKey, resolveExternalUser, async (req, res) => {
    try {
      const { recipients, message, mediaUrl, fileName, caption, sessionName, intervalSeconds, jitterSeconds } = req.body || {};
      const userId = req.auth!.userId;

      if (!Array.isArray(recipients) || recipients.length === 0) {
        throw httpError(400, 'recipients must be a non-empty array of phone numbers');
      }
      if (recipients.length > BULK_MAX_RECIPIENTS) {
        throw httpError(400, `Maximum ${BULK_MAX_RECIPIENTS} recipients per bulk request`);
      }
      if (!message && !mediaUrl) {
        throw httpError(400, 'message (or mediaUrl) is required');
      }

      const running = externalBulkSendService.getRunningJobForUser(userId);
      if (running) {
        throw httpError(409, `A bulk job is already running for this user (jobId: ${running.jobId})`);
      }

      const interval = Math.min(300, Math.max(5, parseInt(String(intervalSeconds ?? 25)) || 25));
      const jitter = Math.max(0, parseInt(String(jitterSeconds ?? 5)) || 0);

      const session = await getConnectedSessionForUser(userId, sessionName);
      const media = mediaUrl
        ? { ...(await downloadToTempFile(String(mediaUrl), fileName ? String(fileName) : undefined)), caption: caption ? String(caption) : undefined }
        : undefined;

      const job = externalBulkSendService.startJob({
        userId,
        sessionName: String(sessionName || 'default'),
        session,
        recipients: recipients.map((value: unknown) => String(value)),
        message: String(message || ''),
        media,
        intervalSeconds: interval,
        jitterSeconds: jitter,
      });

      res.status(202).json({
        success: true,
        data: {
          jobId: job.jobId,
          total: job.total,
          status: job.status,
          estimatedSeconds: externalBulkSendService.estimateDurationSeconds(job.total, interval),
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Poll a bulk job.
  app.get('/api/external/messages/bulk-status/:jobId', verifyExternalApiKey, (req, res) => {
    const job = externalBulkSendService.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found (jobs are not persisted across restarts)' });
    }
    res.json({
      success: true,
      data: {
        jobId: job.jobId,
        status: job.status,
        total: job.total,
        processed: job.processed,
        sent: job.sent,
        failed: job.failed,
        errors: job.errors,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      },
    });
  });

  // Stop a running bulk job (loop exits within ~1s).
  app.post('/api/external/messages/bulk-stop/:jobId', verifyExternalApiKey, (req, res) => {
    const job = externalBulkSendService.stopJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found (jobs are not persisted across restarts)' });
    }
    res.json({ success: true, data: { jobId: job.jobId, status: job.status === 'running' ? 'stopping' : job.status } });
  });

  log('🔌 External machine-to-machine API routes registered (/api/external/*, /api/users/:userId/whatsapp/*)');
}
