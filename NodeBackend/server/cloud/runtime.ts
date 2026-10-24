import { queryClient } from '../db';
import { CloudCampaignStore } from './store';
import type { Row, Tenant } from './model';
import { sessionManager } from '../services/WhatsAppSessionManager';
import { CloudApiSession, GraphApiError } from '../services/CloudApiSession';
import { log } from '../utils';

export const cloudStore = new CloudCampaignStore({
  query: async (text, params = []) => Array.from(await queryClient.unsafe(text, params)),
  transaction: async fn => {
    // postgres.js's UnwrapPromiseArray type does not model an arbitrary callback result.
    const result: any = await queryClient.begin(async tx => fn(async (text, params = []) => Array.from(await tx.unsafe(text, params))));
    return result;
  },
});

export async function cloudSession(tenant: Tenant, id: string): Promise<CloudApiSession> {
  const row = await cloudStore.session(tenant,id);
  if (row.status !== 'connected') throw new Error('The selected official sender is disconnected');
  const session = await sessionManager.getSession(tenant.userId,row.session_name);
  if (!(session instanceof CloudApiSession) || session.phoneNumberId !== row.cloud_phone_number_id || session.wabaId !== row.cloud_waba_id) {
    throw new Error('Official sender configuration changed; reconnect the sender');
  }
  return session;
}
export async function validateCampaign(c: Row) {
  const session = await cloudSession({organizationId:c.organization_id,userId:c.user_id},c.session_id);
  if (session.phoneNumberId!==c.phone_number_id || session.wabaId!==c.waba_id) throw new Error('Campaign sender has changed');
  const template = await session.getCampaignTemplate(c.template_name,c.language);
  if (template.status !== 'APPROVED') throw new Error('Template is no longer approved');
  if (JSON.stringify(template.components)!==JSON.stringify(c.template_snapshot.components)) throw new Error('Approved template content changed. Create a new campaign.');
  return session;
}

let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
export async function runCloudCampaignTick() {
  if (busy) return;
  busy = true;
  try {
    await cloudStore.recover();
    const campaigns = await cloudStore.database.query("SELECT * FROM cloud_campaigns WHERE status IN ('running','scheduled') AND next_send_at<=now() ORDER BY next_send_at LIMIT 10");
    for (const c of campaigns) {
      let session: CloudApiSession;
      try { session = await validateCampaign(c); }
      catch (e) {
        await cloudStore.database.query("UPDATE cloud_campaigns SET status='paused',error_reason=$2,updated_at=now() WHERE id=$1 AND status IN ('running','scheduled')",[c.id,e instanceof Error ? e.message : 'Sender validation failed']);
        continue;
      }
      const claim = await cloudStore.claim(c.id);
      if (!claim) continue;
      const { attemptId,recipient,request } = claim;
      // Check suppression again immediately before the external send.
      if (await cloudStore.suppressed(cloudStore.database.query,{organizationId:c.organization_id,userId:c.user_id},recipient.phone)) {
        await cloudStore.outcome(attemptId,'skipped','Recipient opted out or is blocked');
        continue;
      }
      let messageId: string;
      try { messageId = await session.sendCampaignTemplate(recipient.phone,request,attemptId); }
      catch (e) {
        const definitive = e instanceof GraphApiError && !!e.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500;
        await cloudStore.outcome(attemptId,definitive ? 'failed' : 'unknown', e instanceof Error ? e.message : 'Send failed', e instanceof GraphApiError ? String(e.code || '') : undefined);
        // Sender/account failures should not burn through the remaining audience.
        if (e instanceof GraphApiError && [190,10,200,131031,131042,132001,132015,132016].includes(e.code || 0)) {
          await cloudStore.database.query("UPDATE cloud_campaigns SET status='paused',error_reason=$2 WHERE id=$1",[c.id,e.message]);
        }
        continue;
      }
      // A database error after Meta accepted must not be treated as a send failure or retried.
      await cloudStore.accepted(attemptId,messageId);
    }
  } catch (e) { log(`[CloudCampaign] Worker error: ${e instanceof Error ? e.message : 'unknown'}`); }
  finally { busy=false; }
}
export function startCloudCampaignScheduler() {
  if (!timer) { timer=setInterval(() => void runCloudCampaignTick(),5000); timer.unref(); }
}
export function stopCloudCampaignScheduler() { if(timer) clearInterval(timer); timer=undefined; }
