// Runtime-neutral contract used by product adapters and dispatch guards.
// No credentials, database clients or environment reads in this module.
export type Product = 'opd' | 'growth' | 'workforce' | 'whatsapp';
export type Member = { id: string; auth_user_id: string | null; email: string; name: string; role: string; status: string };
export type Snapshot = {
  contract: 'suite.access.v1'; job_id: string; organization_id: string; product_code: Product;
  version: number; local_tenant_id: string | null; organization: { id: string; name: string; status: string; plan_snapshot: Record<string, unknown> };
  members: Member[]; trial: { starts_at: string; ends_at: string } | null;
  grants: { starts_at: string; ends_at: string; revoked_at?: string | null }[];
  messaging_routes: Record<string, unknown>[]; issued_at: string; refresh_by: string;
};
export class AccessError extends Error { constructor(message: string, readonly status = 403) { super(message); } }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccessError('Invalid suite payload.', 400);
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new AccessError('Invalid identity.', 400);
  return value;
}
export function uuid(value: unknown): string {
  const id = identifier(value);
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new AccessError('Invalid UUID.', 400);
  return id.toLowerCase();
}
export async function sameSecret(a: string, b: string) {
  const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x,y] = await Promise.all([hash(a),hash(b)]); let diff=0;
  for(let i=0;i<x.length;i++) diff |= x[i]^y[i];
  return diff===0;
}
export function parseSnapshot(raw: unknown, product: Product, now = Date.now()): Snapshot {
  const s=record(raw),org=record(s.organization);
  uuid(s.job_id);uuid(s.organization_id);
  if(s.contract!=='suite.access.v1'||s.product_code!==product||org.id!==s.organization_id) throw new AccessError('Wrong product or organisation.',400);
  if(!Number.isSafeInteger(s.version)||Number(s.version)<1)throw new AccessError('Invalid version.',400);
  if(s.local_tenant_id!==null)identifier(s.local_tenant_id);
  if(!['active','suspended'].includes(String(org.status)) || typeof org.name!=='string')throw new AccessError('Invalid organisation.',400);
  record(org.plan_snapshot);
  const issued=Date.parse(String(s.issued_at)),refresh=Date.parse(String(s.refresh_by));
  if(!Number.isFinite(issued)||!Number.isFinite(refresh)||issued>now+30000||issued<now-300000||refresh<=now||refresh>issued+300000)throw new AccessError('Snapshot is stale or has invalid freshness.',409);
  if(!Array.isArray(s.members)||s.members.length>1000||!Array.isArray(s.grants)||!Array.isArray(s.messaging_routes))throw new AccessError('Invalid snapshot lists.',400);
  const ids=new Set<string>(),authIds=new Set<string>();
  for(const value of s.members){const m=record(value);uuid(m.id);if(m.auth_user_id!==null)uuid(m.auth_user_id);
    if(ids.has(String(m.id)))throw new AccessError('Duplicate member.',400);ids.add(String(m.id));
    if(!['owner','admin','member','billing'].includes(String(m.role))||!['pending','active','disabled'].includes(String(m.status))||typeof m.email!=='string'||typeof m.name!=='string')throw new AccessError('Invalid membership.',400);
    if(m.status==='active'&&!m.auth_user_id)throw new AccessError('Active member lacks verified identity.',400);
    if(m.auth_user_id){if(authIds.has(String(m.auth_user_id)))throw new AccessError('Duplicate Auth identity.',400);authIds.add(String(m.auth_user_id));}
  }
  for(const value of [...s.grants,...(s.trial?[s.trial]:[])]){const g=record(value);const start=Date.parse(String(g.starts_at)),end=Date.parse(String(g.ends_at));if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw new AccessError('Invalid access dates.',400);}
  return s as unknown as Snapshot;
}
export function accessDeadline(s: Snapshot, now=Date.now()): string | null {
  if(s.organization.status!=='active')return null;
  const windows=[...s.grants.filter(g=>!g.revoked_at),...(s.trial?[s.trial]:[])];
  const ends=windows.filter(w=>Date.parse(w.starts_at)<=now&&Date.parse(w.ends_at)>now).map(w=>Date.parse(w.ends_at));
  return ends.length?new Date(Math.max(...ends)).toISOString():null;
}
export function seatLimit(s: Snapshot): number {
  const plan=s.organization.plan_snapshot;
  const limits=record(plan.limits || {});
  const fields=s.product_code==='workforce'?['employees','staff']:s.product_code==='whatsapp'?['operators','staff']:['staff'];
  const value=fields.map(f=>limits[f]).find(v=>Number.isSafeInteger(v)&&Number(v)>0);
  if(value===undefined)throw new AccessError('Plan has no usable seat limit.',409);
  return Number(value);
}
export function activeMembers(s: Snapshot) {
  const members=s.members.filter(m=>m.status==='active'&&m.auth_user_id&&m.role!=='billing');
  if(!members.some(m=>m.role==='owner'))throw new AccessError('A verified active owner is required before provisioning.',409);
  if(members.length>seatLimit(s))throw new AccessError('The selected plan has too many active product members.',409);
  return members;
}
export interface AdapterStore {
  apply(snapshot: Snapshot): Promise<{ local_tenant_id: string; version: number; enforcement: {server: boolean; workers: boolean; expires_at: boolean; tenant_isolation: boolean} }>;
}
export async function handleAdapter(req: Request, config: {product:Product;token?:string;instance?:string;environment?:string}, store:AdapterStore):Promise<Response>{
  const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  if(req.method!=='POST')return reply({error:'Use POST.'},405);
  if(req.headers.has('Origin'))return reply({error:'Server requests only.'},403);
  try{
    if(!config.token||config.token.length<32||!config.instance||!['staging','production'].includes(config.environment||''))throw new AccessError('Adapter is not configured.',503);
    const token=req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if(!token||token.length>512||!await sameSecret(token,config.token))throw new AccessError('Invalid adapter credential.',401);
    const text=await req.text();if(text.length>256000)throw new AccessError('Payload too large.',413);
    let body:Record<string,unknown>;try{body=record(JSON.parse(text));}catch{throw new AccessError('Invalid JSON.',400);}
    if(body.target_instance_id!==config.instance||body.environment!==config.environment)throw new AccessError('Deployment identity mismatch.',409);
    const snapshot=parseSnapshot(body,config.product);activeMembers(snapshot);
    const applied=await store.apply(snapshot);
    if(applied.version!==snapshot.version||snapshot.local_tenant_id&&applied.local_tenant_id!==snapshot.local_tenant_id)throw new AccessError('Conflicting tenant/version.',409);
    return reply({contract:snapshot.contract,organization_id:snapshot.organization_id,product_code:config.product,version:applied.version,local_tenant_id:applied.local_tenant_id,enforcement:applied.enforcement});
  }catch(e){return reply({error:e instanceof AccessError?e.message:'Product adapter unavailable.'},e instanceof AccessError?e.status:503);}
}
