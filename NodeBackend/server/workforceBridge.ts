import type { Express, Request } from 'express';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { parseWorkforceScope, workforceRoute, WorkforceError, type WorkforceScope } from './workforceBridgeCore';

// A symbol cannot be injected through a JSON request/header.
const scopeKey = Symbol('verifiedWorkforceScope');
type ScopedRequest = Request & { [scopeKey]?: WorkforceScope };
export const getWorkforceScope = (req: Request) => (req as ScopedRequest)[scopeKey];

async function syncAdmins(scope: WorkforceScope) {
  // One transaction, deterministic lock order and immutable tenant ownership.
  return db.transaction(async tx => {
    const result: { id: string; username: string; role: string }[] = [];
    for (const admin of [...scope.admins].sort((a, b) => a.id.localeCompare(b.id))) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workforce-user:${admin.id}`},0))`);
      const found = await tx.execute(sql`SELECT id,username,role,organization_id FROM users WHERE id=${admin.id} FOR UPDATE`);
      const existing = found[0];
      if (existing) {
        if (existing.organization_id !== scope.organizationId) throw new WorkforceError('Existing user belongs to another organisation. No users were changed.', 409);
        // Preserve passwords, roles, usernames, emails and all session ownership.
        result.push({ id: String(existing.id), username: String(existing.username), role: String(existing.role) });
        continue;
      }
      const username = `workforce_${scope.sourceId}_${admin.id}`;
      const password = await bcrypt.hash(randomUUID() + randomUUID(), 12);
      // External identities are not full WhatsApp administrators. Keep email null
      // rather than claiming an existing login's unique email or inventing a password.
      await tx.execute(sql`INSERT INTO users(id,username,password,email,organization_id,role,created_at,updated_at)
        VALUES(${admin.id},${username},${password},NULL,${scope.organizationId},'user',now(),now())`);
      result.push({ id: admin.id, username, role: 'user' });
    }
    return result;
  });
}
export function registerWorkforceBridge(app: Express): void {
  // Register BEFORE the existing external routes. Only fixed, scoped session
  // operations are forwarded; callers cannot supply an arbitrary URL or method.
  app.post('/api/integrations/workforce', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin !== undefined) { res.status(403).json({ error: 'Server-to-server only.' }); return; }
    const expected = process.env.WORKFORCE_INTEGRATION_TOKEN;
    const source = process.env.WORKFORCE_SOURCE_ID;
    if (!expected || expected.length < 32 || !source) { res.status(503).json({ error: 'Workforce bridge is not configured.' }); return; }
    const provided = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!provided || provided.length > 512 || !timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(expected).digest())) {
      res.status(401).json({ error: 'Invalid integration credential.' }); return;
    }
    try {
      const scope = parseWorkforceScope(req.body, source);
      (req as ScopedRequest)[scopeKey] = scope;
      if (scope.action === 'sync_admins') {
        const users = await syncAdmins(scope);
        res.json({ success: true, data: { organizationId: scope.organizationId, received: scope.admins.length, synced: users.length, users } });
        return;
      }
      const route = workforceRoute(scope);
      req.method = route.method; req.url = route.url; req.body = route.body;
      req.query = Object.fromEntries(new URL(route.url, 'https://workforce.internal').searchParams);
      next();
    } catch (error) {
      res.status(error instanceof WorkforceError ? error.status : 503).json({ error: error instanceof WorkforceError ? error.message : 'Workforce operation failed.' });
    }
  });
}
