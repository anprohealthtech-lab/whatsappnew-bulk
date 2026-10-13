/**
 * Routes for the Meta WhatsApp Cloud API channel.
 *
 *  GET  /api/webhooks/meta            Meta's one-time webhook verification
 *  POST /api/webhooks/meta            Inbound messages + delivery statuses (signed)
 *  GET  /api/admin/cloud-sessions     List Cloud API sessions (super admin)
 *  POST /api/admin/cloud-sessions     Create/update a Cloud API session for a user (super admin)
 *  GET  /api/cloud/templates          List the WABA's templates (auth)
 *  POST /api/cloud/send-template      Send an approved template (auth)
 *  GET  /api/cloud/window/:phone      Is the 24 h free-form window open for this number? (auth)
 *
 * Env: META_APP_SECRET (signature check), META_WEBHOOK_VERIFY_TOKEN,
 *      META_WA_ACCESS_TOKEN (fallback token when a session row has none).
 *
 * Subscribing the Meta app to a WhatsApp Business Account's webhooks is a
 * one-time step done outside this server (App Dashboard, or
 * POST /{waba_id}/subscribed_apps with the business token).
 */
import type { Express, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from './db';
import { whatsappSessions, users } from '@shared/schema';
import { log } from './utils';
import { sessionManager } from './services/WhatsAppSessionManager';
import { CloudApiSession } from './services/CloudApiSession';
import { requireAuth, requireSuperAdmin, getTenant } from './authMiddleware';

function verifySignature(req: Request): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;
  const header = String(req.headers['x-hub-signature-256'] || '');
  if (!header.startsWith('sha256=')) return false;
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
}

async function loadCloudSession(phoneNumberId: string): Promise<CloudApiSession | null> {
  const row = await sessionManager.findCloudSessionRow(phoneNumberId);
  if (!row) return null;
  const service = await sessionManager.getSession(row.userId, row.sessionName);
  if (!(service instanceof CloudApiSession)) {
    log(`[CloudAPI] Session ${row.userId}/${row.sessionName} is loaded as ${service.constructor.name}, not CloudApiSession`);
    return null;
  }
  if (!service.getStatus().isConnected) {
    try { await service.initialize(); } catch { /* logged inside initialize() */ }
  }
  return service;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function registerCloudApiRoutes(app: Express) {
  // ---- Meta webhook -------------------------------------------------------

  app.get('/api/webhooks/meta', (req: Request, res: Response) => {
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (!verifyToken) {
      return res.status(503).send('META_WEBHOOK_VERIFY_TOKEN not configured');
    }
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
      log('[CloudAPI] Webhook verified by Meta');
      return res.status(200).send(String(req.query['hub.challenge'] || ''));
    }
    return res.status(403).send('Verification failed');
  });

  app.post('/api/webhooks/meta', async (req: Request, res: Response) => {
    if (!process.env.META_APP_SECRET) {
      log('[CloudAPI] Rejecting webhook: META_APP_SECRET is not set');
      return res.status(503).json({ error: 'META_APP_SECRET not configured' });
    }
    if (!verifySignature(req)) {
      log('[CloudAPI] Rejecting webhook: bad X-Hub-Signature-256');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Acknowledge first; Meta retries (and eventually disables) slow webhooks.
    res.status(200).json({ received: true });

    const body = req.body || {};
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        try {
          if (change.field === 'messages') {
            const value = change.value || {};
            const phoneNumberId = value?.metadata?.phone_number_id;
            if (!phoneNumberId) continue;
            const session = await loadCloudSession(String(phoneNumberId));
            if (!session) {
              log(`[CloudAPI] No cloud_api session configured for phone_number_id ${phoneNumberId}; dropping ${(value.messages || []).length} message(s)`);
              continue;
            }
            await session.handleWebhookValue(value);
          } else {
            // account_update, message_template_status_update, phone_number_quality_update, ...
            log(`[CloudAPI] Webhook field ${change.field} (waba ${entry.id}): ${JSON.stringify(change.value).slice(0, 500)}`);
          }
        } catch (error) {
          log(`[CloudAPI] Webhook handling error: ${errorMessage(error)}`);
        }
      }
    }
  });

  // ---- Admin: manage cloud sessions ---------------------------------------

  app.get('/api/admin/cloud-sessions', requireSuperAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await db.select().from(whatsappSessions).where(eq(whatsappSessions.provider, 'cloud_api'));
      res.json({
        success: true,
        sessions: rows.map((r) => {
          const loaded = sessionManager.getLoadedSession(r.userId, r.sessionName);
          return {
            ...r,
            cloudAccessToken: r.cloudAccessToken ? `...${r.cloudAccessToken.slice(-6)}` : null,
            loaded: !!loaded,
            connected: loaded?.getStatus().isConnected ?? false,
          };
        }),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: errorMessage(error) });
    }
  });

  app.post('/api/admin/cloud-sessions', requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const {
        userId,
        sessionName = 'cloud',
        phoneNumberId,
        wabaId,
        accessToken,
        phoneNumber,
      } = req.body || {};

      if (!userId || !phoneNumberId) {
        return res.status(400).json({ success: false, error: 'userId and phoneNumberId are required' });
      }

      const [user] = await db.select({ organizationId: users.organizationId })
        .from(users).where(eq(users.id, String(userId))).limit(1);
      if (!user) {
        return res.status(404).json({ success: false, error: `User ${userId} not found` });
      }

      const existing = await db.select().from(whatsappSessions)
        .where(and(eq(whatsappSessions.userId, String(userId)), eq(whatsappSessions.sessionName, String(sessionName))))
        .limit(1);

      if (existing.length && existing[0].provider !== 'cloud_api' && existing[0].status === 'connected') {
        return res.status(409).json({
          success: false,
          error: `Session "${sessionName}" is a connected ${existing[0].provider} session; choose another sessionName`,
        });
      }

      const token = accessToken || existing[0]?.cloudAccessToken || process.env.META_WA_ACCESS_TOKEN;
      if (!token) {
        return res.status(400).json({ success: false, error: 'accessToken is required (or set META_WA_ACCESS_TOKEN)' });
      }

      const values = {
        organizationId: user.organizationId,
        provider: 'cloud_api',
        cloudPhoneNumberId: String(phoneNumberId),
        cloudWabaId: wabaId ? String(wabaId) : existing[0]?.cloudWabaId || null,
        cloudAccessToken: accessToken ? String(accessToken) : existing[0]?.cloudAccessToken || null,
        phoneNumber: phoneNumber ? CloudApiSession.digits(String(phoneNumber)) : existing[0]?.phoneNumber || null,
        status: 'connected',
        updatedAt: new Date(),
      };

      if (existing.length) {
        await db.update(whatsappSessions).set(values).where(eq(whatsappSessions.id, existing[0].id));
      } else {
        await db.insert(whatsappSessions).values({ userId: String(userId), sessionName: String(sessionName), ...values });
      }

      // (Re)load the session with the new config and verify the token against Meta.
      await sessionManager.unloadSession(String(userId), String(sessionName));
      const service = await sessionManager.getSession(String(userId), String(sessionName));
      if (!(service instanceof CloudApiSession)) {
        return res.status(500).json({ success: false, error: 'Session did not load as a Cloud API session' });
      }
      await service.initialize();

      res.json({ success: true, status: service.getStatus() });
    } catch (error) {
      log(`[CloudAPI] cloud-sessions create failed: ${errorMessage(error)}`);
      res.status(500).json({ success: false, error: errorMessage(error) });
    }
  });

  // ---- Tenant: templates and service window --------------------------------

  const resolveTenantCloudSession = async (req: Request): Promise<CloudApiSession | null> => {
    const tenant = getTenant(req);
    const sessionName = (req.body?.sessionName || req.query?.sessionName) as string | undefined;
    if (sessionName) {
      const s = await sessionManager.getSession(tenant.userId, String(sessionName));
      return s instanceof CloudApiSession ? s : null;
    }
    const rows = await db.select().from(whatsappSessions)
      .where(and(eq(whatsappSessions.userId, tenant.userId), eq(whatsappSessions.provider, 'cloud_api')))
      .limit(1);
    if (!rows.length) return null;
    const s = await sessionManager.getSession(rows[0].userId, rows[0].sessionName);
    return s instanceof CloudApiSession ? s : null;
  };

  app.get('/api/cloud/templates', requireAuth, async (req: Request, res: Response) => {
    try {
      const session = await resolveTenantCloudSession(req);
      if (!session) return res.status(404).json({ success: false, error: 'No Cloud API session for this user' });
      res.json({ success: true, templates: await session.listTemplates() });
    } catch (error) {
      res.status(500).json({ success: false, error: errorMessage(error) });
    }
  });

  app.post('/api/cloud/send-template', requireAuth, async (req: Request, res: Response) => {
    try {
      const { phoneNumber, templateName, language = 'en', params = [], headerParams, buttonParams } = req.body || {};
      if (!phoneNumber || !templateName) {
        return res.status(400).json({ success: false, error: 'phoneNumber and templateName are required' });
      }
      const session = await resolveTenantCloudSession(req);
      if (!session) return res.status(404).json({ success: false, error: 'No Cloud API session for this user' });
      const result = await session.sendTemplateMessage(
        String(phoneNumber), String(templateName), String(language), params, { headerParams, buttonParams },
      );
      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ success: false, error: errorMessage(error) });
    }
  });

  app.get('/api/cloud/window/:phoneNumber', requireAuth, async (req: Request, res: Response) => {
    try {
      const session = await resolveTenantCloudSession(req);
      if (!session) return res.status(404).json({ success: false, error: 'No Cloud API session for this user' });
      res.json({ success: true, withinServiceWindow: session.isWithinServiceWindow(String(req.params.phoneNumber)) });
    } catch (error) {
      res.status(500).json({ success: false, error: errorMessage(error) });
    }
  });
}
