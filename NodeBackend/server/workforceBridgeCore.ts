export type WorkforceAdmin = { id: string; email: string | null; name: string | null };
export type WorkforceScope = { sourceId: string; organizationId: string; userId: string; sessionName: string; action: string; admins: WorkforceAdmin[] };
export class WorkforceError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actions = ['sync_admins', 'handshake', 'connect', 'refresh_qr', 'qr', 'status', 'disconnect'];
export function parseWorkforceScope(raw: unknown, expectedSource: string): WorkforceScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkforceError('Invalid request.');
  const body = raw as Record<string, unknown>;
  if (!UUID.test(expectedSource) || body.source_id !== expectedSource) throw new WorkforceError('Wrong Workforce source.', 403);
  if (!UUID.test(String(body.organization_id || '')) || !UUID.test(String(body.user_id || '')) || !actions.includes(String(body.action))) throw new WorkforceError('Invalid Workforce operation.');
  if (typeof body.session_name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.session_name)) throw new WorkforceError('Invalid session name.');
  if (!Array.isArray(body.admins) || body.admins.length < 1 || body.admins.length > 200) throw new WorkforceError('Invalid administrator list.');
  const ids = new Set<string>();
  const admins = body.admins.map((row: Record<string, unknown>) => {
    if (!row || typeof row !== 'object' || !UUID.test(String(row.id || '')) || ids.has(String(row.id))) throw new WorkforceError('Invalid or duplicate user ID.');
    ids.add(String(row.id));
    const email = typeof row.email === 'string' && row.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) ? row.email.toLowerCase() : null;
    return { id: String(row.id), email, name: typeof row.name === 'string' ? row.name.slice(0, 160) : null };
  });
  if (!ids.has(String(body.user_id))) throw new WorkforceError('Requested user is outside the administrator scope.', 403);
  return { sourceId: expectedSource, organizationId: String(body.organization_id), userId: String(body.user_id), sessionName: body.session_name, action: String(body.action), admins };
}
export function workforceRoute(scope: WorkforceScope): { method: 'GET' | 'POST'; url: string; body: Record<string, unknown> } {
  const user = encodeURIComponent(scope.userId); const session = encodeURIComponent(scope.sessionName);
  switch (scope.action) {
    case 'handshake': return { method: 'POST', url: '/api/external/users/sync', body: { id: scope.userId } };
    case 'connect': return { method: 'POST', url: `/api/users/${user}/whatsapp/connect`, body: { sessionName: scope.sessionName } };
    case 'refresh_qr': return { method: 'POST', url: `/api/users/${user}/whatsapp/refresh-qr`, body: { sessionName: scope.sessionName } };
    case 'qr': return { method: 'GET', url: `/api/users/${user}/whatsapp/qr?sessionName=${session}`, body: {} };
    case 'status': return { method: 'GET', url: `/api/users/${user}/whatsapp/status`, body: {} };
    case 'disconnect': return { method: 'POST', url: '/api/external/sessions/disconnect', body: { userId: scope.userId, sessionName: scope.sessionName } };
    default: throw new WorkforceError('This operation cannot be forwarded.');
  }
}
