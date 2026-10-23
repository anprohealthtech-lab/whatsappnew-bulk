/**
 * Routes for the Meta WhatsApp Cloud API channel.
 *
 *  GET  /api/webhooks/meta              Meta's one-time webhook verification
 *  POST /api/webhooks/meta              Inbound messages + delivery statuses (signed)
 *  GET  /api/admin/cloud-sessions       List Cloud API sessions (super admin)
 *  POST /api/admin/cloud-sessions       Create/update a Cloud API session for any user (super admin)
 *  GET  /api/cloud/signup-config        App id + Embedded Signup config id for the dashboard button (auth)
 *  POST /api/cloud/onboard              Finish Embedded Signup: exchange code, subscribe, register, create session (auth)
 *  GET  /api/cloud/session              The tenant's own Cloud API session, if any (auth)
 *  POST /api/cloud/session/disconnect   Unload the tenant's Cloud API session (auth)
 *  GET  /api/cloud/templates            List the WABA's templates (auth)
 *  POST /api/cloud/send-template        Send an approved template (auth)
 *  GET  /api/cloud/window/:phone        Is the 24 h free-form window open for this number? (auth)
 *
 * Env: META_APP_ID, META_APP_SECRET (signature check + code exchange),
 *      META_WEBHOOK_VERIFY_TOKEN, META_ES_CONFIG_ID (Embedded Signup configuration),
 *      META_WA_ACCESS_TOKEN (fallback token when a session row has none).
 */
import type { Express, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from './db';
import { whatsappSessions, users } from '@shared/schema';
import { log } from './utils';
import { sessionManager } from './services/WhatsAppSessionManager';
import { CloudApiSession, GraphApiError } from './services/CloudApiSession';
import { requireAuth, requireSuperAdmin, getTenant } from './authMiddleware';
import { selectSignupPhone } from '@shared/metaSignup';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DEFAULT_CLOUD_SESSION_NAME = 'cloud';

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

/** Plain Graph call with a bearer token; throws GraphApiError on failure. */
async function graph(method: 'GET' | 'POST', pathname: string, token: string, query?: Record<string, string>, body?: any): Promise<any> {
  const url = new URL(`${GRAPH_BASE}${pathname}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok || json?.error) {
    const e = json?.error || {};
    const detail = e.error_data?.details ? ` - ${e.error_data.details}` : '';
    throw new GraphApiError(`${e.message || `HTTP ${response.status}`}${detail}`, e.code, e.error_subcode, response.status);
  }
  return json;
}

/**
 * Two-step-verification PIN used when registering a number for the Cloud API.
 * Derived from the app secret so it can be regenerated later without storing it.
 */
function registrationPin(phoneNumberId: string): string {
  const secret = process.env.META_APP_SECRET || 'no-secret';
  const digest = createHmac('sha256', secret).update(`register:${phoneNumberId}`).digest('hex');
  return String(parseInt(digest.slice(0, 8), 16) % 1000000).padStart(6, '0');
}

interface UpsertCloudSessionInput {
  userId: string;
  sessionName: string;
  phoneNumberId: string;
  wabaId?: string | null;
  accessToken?: string | null;
  phoneNumber?: string | null;
}

/**
 * Create or update a cloud_api row for a user, (re)load it and verify the
 * token against Meta. Shared by the admin route and Embedded Signup.
 */
async function upsertCloudSession(input: UpsertCloudSessionInput): Promise<CloudApiSession> {
  const { userId, sessionName, phoneNumberId } = input;

  const [user] = await db.select({ organizationId: users.organizationId })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error(`User ${userId} not found`);

  const existing = await db.select().from(whatsappSessions)
    .where(and(eq(whatsappSessions.userId, userId), eq(whatsappSessions.sessionName, sessionName)))
    .limit(1);

  if (existing.length && existing[0].provider !== 'cloud_api' && existing[0].status === 'connected') {
    throw new Error(`Session "${sessionName}" is a connected ${existing[0].provider} session; choose another sessionName`);
  }

  // A phone number id can belong to exactly one session.
  const owner = await sessionManager.findCloudSessionRow(phoneNumberId);
  if (owner && (owner.userId !== userId || owner.sessionName !== sessionName)) {
    throw new Error(`Phone number id ${phoneNumberId} is already linked to another session`);
  }

  const token = input.accessToken || existing[0]?.cloudAccessToken || process.env.META_WA_ACCESS_TOKEN;
  if (!token) throw new Error('accessToken is required (or set META_WA_ACCESS_TOKEN)');

  const values = {
    organizationId: user.organizationId,
    provider: 'cloud_api',
    cloudPhoneNumberId: phoneNumberId,
    cloudWabaId: input.wabaId ? String(input.wabaId) : existing[0]?.cloudWabaId || null,
    cloudAccessToken: input.accessToken ? String(input.accessToken) : existing[0]?.cloudAccessToken || null,
    phoneNumber: input.phoneNumber ? CloudApiSession.digits(String(input.phoneNumber)) : existing[0]?.phoneNumber || null,
    status: 'connected',
    updatedAt: new Date(),
  };

  if (existing.length) {
    await db.update(whatsappSessions).set(values).where(eq(whatsappSessions.id, existing[0].id));
  } else {
    await db.insert(whatsappSessions).values({ userId, sessionName, ...values });
  }

  await sessionManager.unloadSession(userId, sessionName);
  const service = await sessionManager.getSession(userId, sessionName);
  if (!(service instanceof CloudApiSession)) {
    throw new Error('Session did not load as a Cloud API session');
  }
  try {
    await service.initialize();
  } catch (error) {
    // Token or number is bad: do not leave a "connected" row behind.
    await db.update(whatsappSessions).set({ status: 'disconnected', updatedAt: new Date() })
      .where(and(eq(whatsappSessions.userId, userId), eq(whatsappSessions.sessionName, sessionName)));
    await sessionManager.unloadSession(userId, sessionName);
    throw error;
  }
  return service;
}

function publicSessionRow(r: typeof whatsappSessions.$inferSelect) {
  const loaded = sessionManager.getLoadedSession(r.userId, r.sessionName);
  const status = loaded?.getStatus();
  return {
    id: r.id,
    userId: r.userId,
    sessionName: r.sessionName,
    provider: r.provider,
    phoneNumber: r.phoneNumber,
    cloudPhoneNumberId: r.cloudPhoneNumberId,
    cloudWabaId: r.cloudWabaId,
    hasToken: !!(r.cloudAccessToken || process.env.META_WA_ACCESS_TOKEN),
    status: r.status,
    lastConnectedAt: r.lastConnectedAt,
    loaded: !!loaded,
    connected: status?.isConnected ?? false,
    verifiedName: status?.sessionInfo?.name ?? null,
    qualityRating: status?.sessionInfo?.qualityRating ?? null,
  };
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
      res.json({ success: true, sessions: rows.map(publicSessionRow) });
    } catch (error) {
      res.status(500).json({ success: false, error: errorMessage(error) });
    }
  });

  app.post('/api/admin/cloud-sessions', requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const { userId, sessionName = DEFAULT_CLOUD_SESSION_NAME, phoneNumberId, wabaId, accessToken, phoneNumber } = req.body || {};
      if (!userId || !phoneNumberId) {
        return res.status(400).json({ success: false, error: 'userId and phoneNumberId are required' });
      }
      const service = await upsertCloudSession({
        userId: String(userId),
        sessionName: String(sessionName),
        phoneNumberId: String(phoneNumberId),
        wabaId,
        accessToken,
        phoneNumber,
      });
      res.json({ success: true, status: service.getStatus() });
    } catch (error) {
      log(`[CloudAPI] cloud-sessions create failed: ${errorMessage(error)}`);
      res.status(500).json({ success: false, error: errorMessage(error) });
    }
  });

  // ---- Tenant: Embedded Signup onboarding ---------------------------------

  app.get('/api/cloud/signup-config', requireAuth, (_req: Request, res: Response) => {
    const appId = process.env.META_APP_ID || '';
    const configId = process.env.META_ES_CONFIG_ID || '';
    res.json({
      success: true,
      enabled: !!(appId && configId && process.env.META_APP_SECRET),
      appId,
      configId,
      graphVersion: GRAPH_VERSION,
    });
  });

  /**
   * Body: { code, phoneNumberId, wabaId, sessionName? }
   *  - code: from FB.login() callback (response.authResponse.code)
   *  - phoneNumberId / wabaId: from the WA_EMBEDDED_SIGNUP "FINISH" message event
   */
  app.post('/api/cloud/onboard', requireAuth, async (req: Request, res: Response) => {
    const tenant = getTenant(req);
    const { code, wabaId, sessionName = DEFAULT_CLOUD_SESSION_NAME } = req.body || {};
    let phoneNumberId = req.body?.phoneNumberId ? String(req.body.phoneNumberId) : undefined;
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      return res.status(503).json({ success: false, error: 'META_APP_ID / META_APP_SECRET not configured on the server' });
    }
    if (!code || !wabaId) {
      return res.status(400).json({
        success: false,
        error: 'code and wabaId are required. Meta must return the selected WhatsApp account from Embedded Signup.',
      });
    }

    const steps: Record<string, string> = {};
    try {
      // 1. Exchange the one-time code for a business token (does not expire).
      const tokenUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
      tokenUrl.searchParams.set('client_id', appId);
      tokenUrl.searchParams.set('client_secret', appSecret);
      tokenUrl.searchParams.set('code', String(code));
      const tokenResp = await fetch(tokenUrl);
      const tokenJson: any = await tokenResp.json().catch(() => ({}));
      const accessToken: string | undefined = tokenJson?.access_token;
      if (!tokenResp.ok || !accessToken) {
        const msg = tokenJson?.error?.message || `HTTP ${tokenResp.status}`;
        return res.status(400).json({ success: false, error: `Code exchange failed: ${msg}` });
      }
      steps.tokenExchange = 'ok';

      // 2. Confirm the token actually covers the account and number the popup reported.
      const waba = await graph('GET', `/${wabaId}`, accessToken, { fields: 'id,name,account_review_status,business_verification_status' });
      const phones = await graph('GET', `/${wabaId}/phone_numbers`, accessToken, { fields: 'id', limit: '100' });
      phoneNumberId = selectSignupPhone(phones, phoneNumberId);
      const phone = await graph('GET', `/${phoneNumberId}`, accessToken, { fields: 'display_phone_number,verified_name,platform_type,status,code_verification_status' });
      steps.verify = `ok (${waba.name}, +${CloudApiSession.digits(phone.display_phone_number)})`;

      // 3. Subscribe our app to the client's account so webhooks arrive.
      try {
        await graph('POST', `/${wabaId}/subscribed_apps`, accessToken);
        steps.subscribe = 'ok';
      } catch (error) {
        steps.subscribe = `failed: ${errorMessage(error)}`;
        log(`[CloudAPI] subscribed_apps failed for WABA ${wabaId}: ${errorMessage(error)}`);
        throw error;
      }

      // 4. Register the number for Cloud API messaging (no-op if already registered).
      try {
        await graph('POST', `/${phoneNumberId}/register`, accessToken, undefined, {
          messaging_product: 'whatsapp',
          pin: registrationPin(String(phoneNumberId)),
        });
        steps.register = 'ok';
      } catch (error) {
        const msg = errorMessage(error);
        // Already registered numbers (e.g. coexistence) return an error we can ignore.
        if (/already|registered/i.test(msg)) {
          steps.register = 'already registered';
        } else {
          steps.register = `failed: ${msg}`;
          log(`[CloudAPI] register failed for ${phoneNumberId}: ${msg}`);
          throw error;
        }
      }

      const registeredPhone = await graph('GET', `/${phoneNumberId}`, accessToken, { fields: 'platform_type,status' });
      if (registeredPhone.platform_type !== 'CLOUD_API' || registeredPhone.status !== 'CONNECTED') {
        throw new Error(`Meta has not completed Cloud API registration (platform ${registeredPhone.platform_type || 'unknown'}, status ${registeredPhone.status || 'unknown'}). The app session was not linked. Complete the appropriate onboarding/migration flow and retry.`);
      }

      // 5. Store + load the session for this tenant.
      const service = await upsertCloudSession({
        userId: tenant.userId,
        sessionName: String(sessionName),
        phoneNumberId: String(phoneNumberId),
        wabaId: String(wabaId),
        accessToken,
        phoneNumber: phone.display_phone_number,
      });
      steps.session = 'ok';

      log(`[CloudAPI] Embedded Signup completed for user ${tenant.userId}: WABA ${wabaId} (${waba.name}), phone ${phoneNumberId}`);
      res.json({
        success: true,
        steps,
        account: { id: waba.id, name: waba.name, reviewStatus: waba.account_review_status, businessVerification: waba.business_verification_status },
        phone: { id: phoneNumberId, number: phone.display_phone_number, verifiedName: phone.verified_name, platform: registeredPhone.platform_type },
        status: service.getStatus(),
      });
    } catch (error) {
      log(`[CloudAPI] onboard failed for user ${tenant.userId}: ${errorMessage(error)} steps=${JSON.stringify(steps)}`);
      res.status(500).json({ success: false, error: errorMessage(error), steps });
    }
  });

  app.get('/api/cloud/session', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenant = getTenant(req);
      const rows = await db.select().from(whatsappSessions)
        .where(and(eq(whatsappSessions.userId, tenant.userId), eq(whatsappSessions.provider, 'cloud_api')))
        .limit(1);
      res.json({ success: true, session: rows.length ? publicSessionRow(rows[0]) : null });
    } catch (error) {
      res.status(500).json({ success: false, error: errorMessage(error) });
    }
  });

  app.post('/api/cloud/session/disconnect', requireAuth, async (req: Request, res: Response) => {
    try {
      const tenant = getTenant(req);
      const rows = await db.select().from(whatsappSessions)
        .where(and(eq(whatsappSessions.userId, tenant.userId), eq(whatsappSessions.provider, 'cloud_api')))
        .limit(1);
      if (!rows.length) return res.status(404).json({ success: false, error: 'No Cloud API session for this user' });
      await sessionManager.unloadSession(rows[0].userId, rows[0].sessionName);
      await db.update(whatsappSessions).set({ status: 'disconnected', updatedAt: new Date() })
        .where(eq(whatsappSessions.id, rows[0].id));
      res.json({ success: true });
    } catch (error) {
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
