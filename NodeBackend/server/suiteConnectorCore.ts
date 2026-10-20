// Portable Web API handler: used by Supabase and Express connectors.
// Connection inspection is deliberately separate from suite.access.v1 provisioning.
export const CONNECTION_CONTRACT = 'suite.connection.v1';
export const COMPONENTS = ['opd', 'growth', 'workforce', 'whatsapp', 'legacy_whatsapp'] as const;
export type Component = typeof COMPONENTS[number];
export type ConnectorConfig = { component: Component; instanceId?: string; environment?: string; token?: string };
export type Identity = { local_user_id: string; local_tenant_id: string | null; local_auth_id: string | null };
export type ConnectorStore = {
  health: () => Promise<void>;
  // Exact local ID only. Never look up or merge identities by email.
  identity: (id: string) => Promise<Identity | null>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function sameSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([left, right].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  const aa = new Uint8Array(a); const bb = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < aa.length; i++) mismatch |= aa[i] ^ bb[i];
  return mismatch === 0;
}
export async function handleConnector(req: Request, config: ConnectorConfig, store: ConnectorStore): Promise<Response> {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
  if (req.headers.has('Origin')) return reply({ error: 'Server-to-server endpoint only.' }, 403);
  if (!config.token || config.token.length < 32 || !config.instanceId || !UUID.test(config.instanceId) ||
      !['production', 'staging'].includes(config.environment || '')) return reply({ error: 'Connector is not configured.' }, 503);
  const bearer = req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!bearer || bearer.length > 512 || !await sameSecret(bearer, config.token)) return reply({ error: 'Invalid connector credential.' }, 401);
  try {
    const raw = await req.text();
    if (raw.length > 4096) return reply({ error: 'Request too large.' }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'Expected an object.' }, 400);
    if (body.contract !== CONNECTION_CONTRACT || !UUID.test(String(body.challenge || '')) ||
        !['health', 'identity'].includes(String(body.operation))) return reply({ error: 'Invalid connection request.' }, 400);
    if (body.component !== config.component || body.instance_id !== config.instanceId || body.environment !== config.environment) {
      return reply({ error: 'Wrong component, instance or environment.' }, 409);
    }
    let identity: Identity | null | undefined;
    if (body.operation === 'identity') {
      if (typeof body.local_user_id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(body.local_user_id)) return reply({ error: 'Invalid local user ID.' }, 400);
      identity = await store.identity(body.local_user_id);
      if (identity && identity.local_user_id !== body.local_user_id) throw new Error('Invalid identity lookup');
    } else await store.health();
    return reply({
      contract: CONNECTION_CONTRACT, component: config.component, instance_id: config.instanceId,
      environment: config.environment, challenge: body.challenge, database_available: true,
      read_only: true, provisioning_ready: false, capabilities: ['health', 'identity'],
      ...(identity === undefined ? {} : { identity }), checked_at: new Date().toISOString(),
    });
  } catch {
    // Never return SQL errors, DB connection strings or upstream diagnostics.
    return reply({ error: 'Connector database inspection failed.' }, 503);
  }
}
