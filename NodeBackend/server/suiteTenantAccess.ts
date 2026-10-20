import { AccessError, identifier, record } from './suiteAccessCore';

export type AccessSettings = { enabled?: string; url?: string; token?: string; allowUnmanaged?: string };
// Call with a tenant derived from the local database, never an unverified body field.
// No positive cache: each dispatch/tool call checks current central state.
export async function requireTenantAccess(product: 'opd'|'growth'|'whatsapp'|'workforce', tenant: string, settings: AccessSettings) {
  if (settings.enabled !== 'true') return;
  identifier(tenant);
  if (!settings.url || !settings.token || settings.token.length < 32) throw new AccessError('Suite access checks are not configured.',503);
  let url: URL; try { url = new URL(settings.url); } catch { throw new AccessError('Invalid suite access URL.',503); }
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new AccessError('Invalid suite access URL.',503);
  let response: Response;
  try { response = await fetch(url, {method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{Authorization:`Bearer ${settings.token}`,'Content-Type':'application/json'},body:JSON.stringify({local_tenant_id:tenant})}); }
  catch {throw new AccessError('Suite access could not be verified.',503);}
  if(!response.ok)throw new AccessError('Suite access could not be verified.',503);
  let value:Record<string,unknown>;
  try { const raw=await response.text();if(raw.length>256000)throw new Error();value=record(JSON.parse(raw)); }
  catch {throw new AccessError('Invalid suite access response.',503);}
  if(value.product_code!==product||value.local_tenant_id!==tenant||value.contract!=='suite.access.v1')throw new AccessError('Suite access identity mismatch.',503);
  if(value.managed===false){
    if(settings.allowUnmanaged==='true')return;
    throw new AccessError('This account has not been enrolled in the suite.');
  }
  const issued=Date.parse(String(value.issued_at)),refresh=Date.parse(String(value.refresh_by)),until=Date.parse(String(value.access_until));const now=Date.now();
  if(!Number.isFinite(issued)||issued>now+30000||issued<now-300000||!Number.isFinite(refresh)||refresh<=now||refresh>issued+300000)throw new AccessError('Suite access response is stale.',503);
  if(value.allowed!==true||!Number.isFinite(until)||until<=now)throw new AccessError('Product access has expired, is suspended or is awaiting setup.');
}
