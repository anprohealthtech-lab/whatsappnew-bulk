import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { handleConnector } from './suiteConnectorCore';

export function registerSuiteConnector(app: Express): void {
  app.post('/api/suite/connector', async (req, res) => {
    try {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (typeof req.headers.authorization === 'string') headers.set('Authorization', req.headers.authorization);
      if (req.headers.origin !== undefined) headers.set('Origin', String(req.headers.origin));
      const response = await handleConnector(new Request('https://suite.internal/connector', { method: 'POST', headers, body: JSON.stringify(req.body ?? null) }), {
        component: 'whatsapp', token: process.env.SUITE_CONNECTOR_TOKEN,
        instanceId: process.env.SUITE_INSTANCE_ID, environment: process.env.SUITE_ENVIRONMENT,
      }, {
        async health() { await db.execute(sql`SELECT id, organization_id FROM users LIMIT 1`); },
        async identity(id) {
          const rows = await db.execute(sql`SELECT id, organization_id FROM users WHERE id::text = ${id} LIMIT 1`);
          const row = rows[0];
          return row ? { local_user_id: String(row.id), local_auth_id: null, local_tenant_id: row.organization_id == null ? null : String(row.organization_id) } : null;
        },
      });
      res.status(response.status).set('Cache-Control', 'no-store').type('json').send(await response.text());
    } catch { res.status(503).set('Cache-Control', 'no-store').json({ error: 'Connector unavailable.' }); }
  });
}
