import { requireTenantAccess } from './suiteTenantAccess';
export async function requireWorkforceAccess(organizationId: string) {
 return requireTenantAccess('workforce',organizationId,{
  enabled:process.env.SUITE_ACCESS_ENABLED,url:process.env.SUITE_ACCESS_URL,
  token:process.env.SUITE_WORKFORCE_ACCESS_TOKEN,allowUnmanaged:process.env.SUITE_ALLOW_UNMANAGED,
 });
}
// An LLM tool may select task data, never its authenticated actor or tenant.
export function workforceToolScope(input: Record<string,unknown>, admin: {userId:string;organizationId:string}) {
 if(input.userId!==undefined && input.userId!==admin.userId || input.organizationId!==undefined && input.organizationId!==admin.organizationId) {
  throw new Error('The requested actor or organisation does not match this HR account.');
 }
 return {userId:admin.userId,organizationId:admin.organizationId};
}
