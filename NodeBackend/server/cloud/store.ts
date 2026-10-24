import { createHash, randomUUID } from 'crypto';
import { campaignInput, templateComponents, type CloudDatabase, type Query, type Row, type Tenant } from './model';

export class CloudCampaignStore {
  constructor(readonly database: CloudDatabase) {}
  async session(tenant: Tenant, id: string) {
    const [row] = await this.database.query(`SELECT id, organization_id, user_id, session_name, phone_number,
      cloud_phone_number_id, cloud_waba_id, status FROM whatsapp_sessions
      WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND provider='cloud_api'`, [id, tenant.organizationId, tenant.userId]);
    if (!row) throw new Error('Official WhatsApp sender not found');
    return row;
  }
  async campaign(tenant: Tenant, id: string, q: Query = this.database.query) {
    const [row] = await q('SELECT * FROM cloud_campaigns WHERE id=$1 AND organization_id=$2 AND user_id=$3', [id, tenant.organizationId, tenant.userId]);
    if (!row) throw new Error('Campaign not found');
    return row;
  }
  async create(tenant: Tenant, raw: unknown, template: Row) {
    const input = campaignInput.parse(raw);
    const session = await this.session(tenant, input.sessionId);
    if (!session.cloud_phone_number_id || !session.cloud_waba_id) throw new Error('Sender configuration is incomplete');
    if (template.name !== input.templateName || template.language !== input.language) throw new Error('Template mismatch');
    const phones = new Set<string>();
    for (const recipient of input.recipients) {
      if (phones.has(recipient.phone)) throw new Error('Duplicate recipient phone number');
      phones.add(recipient.phone);
      templateComponents(template, recipient.bodyParams, input.headerParams, input.buttonParams);
    }
    const id = randomUUID();
    await this.database.transaction(async q => {
      await q(`INSERT INTO cloud_campaigns(id,organization_id,user_id,name,session_id,phone_number_id,waba_id,
        template_name,language,template_snapshot,header_params,button_params,interval_seconds,daily_limit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)`,
      [id, tenant.organizationId, tenant.userId, input.name, session.id, session.cloud_phone_number_id, session.cloud_waba_id,
        input.templateName, input.language, JSON.stringify(template), JSON.stringify(input.headerParams), JSON.stringify(input.buttonParams), input.intervalSeconds, input.dailyLimit]);
      for (const r of input.recipients) await q(`INSERT INTO cloud_campaign_recipients(id,campaign_id,name,phone,body_params,consent_note)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [randomUUID(), id, r.name, r.phone, JSON.stringify(r.bodyParams), r.consentNote]);
    });
    return this.campaign(tenant, id);
  }
  list(tenant: Tenant) {
    return this.database.query(`SELECT c.*, (SELECT count(*)::int FROM cloud_campaign_recipients r WHERE r.campaign_id=c.id) AS total
      FROM cloud_campaigns c WHERE organization_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 200`, [tenant.organizationId, tenant.userId]);
  }
  async report(tenant: Tenant, id: string) {
    const campaign = await this.campaign(tenant, id);
    const recipients = await this.database.query(`SELECT r.*,a.message_id,a.accepted_at,a.sent_at,a.delivered_at,a.read_at,a.failed_at,a.error_code,
      (SELECT count(*)::int FROM cloud_message_attempts p WHERE p.recipient_id=r.id) AS attempts
      FROM cloud_campaign_recipients r LEFT JOIN cloud_message_attempts a ON a.id=r.latest_attempt_id
      WHERE r.campaign_id=$1 ORDER BY r.created_at,r.id`, [id]);
    const counts: Record<string, number> = {};
    for (const r of recipients) counts[r.status] = (counts[r.status] || 0) + 1;
    const attempts = await this.database.query('SELECT * FROM cloud_message_attempts WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 5000', [id]);
    return { campaign, counts, recipients, attempts };
  }
  async control(tenant: Tenant, id: string, action: 'start' | 'pause' | 'retry-failed', scheduledAt?: string) {
    return this.database.transaction(async q => {
      await q('SELECT id FROM cloud_campaigns WHERE id=$1 FOR UPDATE', [id]);
      const c = await this.campaign(tenant, id, q);
      if (action === 'pause') {
        await q("UPDATE cloud_campaigns SET status='paused',updated_at=now() WHERE id=$1", [id]);
      } else if (action === 'retry-failed') {
        if (['running', 'scheduled'].includes(c.status)) throw new Error('Pause the campaign before retrying failures');
        await q("UPDATE cloud_campaign_recipients SET status='pending',error_reason=NULL WHERE campaign_id=$1 AND status='failed'", [id]);
        await q("UPDATE cloud_campaigns SET status='paused',updated_at=now() WHERE id=$1", [id]);
      } else {
        if (['running', 'scheduled'].includes(c.status)) return;
        const when = scheduledAt ? new Date(scheduledAt) : new Date();
        if (!Number.isFinite(when.getTime())) throw new Error('Invalid scheduled time');
        await q(`UPDATE cloud_campaigns SET status=$2,scheduled_at=$3,next_send_at=$3,error_reason=NULL,updated_at=now() WHERE id=$1`,
          [id, when.getTime() > Date.now() ? 'scheduled' : 'running', when.toISOString()]);
      }
    });
  }
  async suppressed(q: Query, tenant: Tenant, phone: string) {
    const rows = await q(`SELECT 1 FROM blocked_numbers WHERE organization_id=$1 AND user_id=$2
      AND regexp_replace(phone_number,'[^0-9]','','g')=$3
      UNION ALL SELECT 1 FROM cloud_message_status_events WHERE organization_id=$1 AND user_id=$2
      AND recipient_phone=$3 AND status='opted_out' LIMIT 1`, [tenant.organizationId, tenant.userId, phone]);
    return rows.length > 0;
  }
  // Claim is durable before calling Meta. Expired claims become unknown, NEVER automatically resent.
  async claim(campaignId: string) {
    return this.database.transaction(async q => {
      const [c] = await q(`SELECT * FROM cloud_campaigns WHERE id=$1 AND status IN ('running','scheduled')
        AND next_send_at<=now() FOR UPDATE SKIP LOCKED`, [campaignId]);
      if (!c) return null;
      const tenant = { organizationId: c.organization_id, userId: c.user_id };
      const active = await q("SELECT id FROM cloud_message_attempts WHERE campaign_id=$1 AND status='dispatching' LIMIT 1", [c.id]);
      if (active.length) return null;
      const [usage] = await q(`SELECT count(*)::int AS total,min(created_at) AS oldest FROM cloud_message_attempts
        WHERE campaign_id=$1 AND created_at>now()-interval '24 hours'`, [c.id]);
      if (usage.total >= c.daily_limit) {
        await q("UPDATE cloud_campaigns SET next_send_at=$2::timestamptz+interval '24 hours 1 second' WHERE id=$1", [c.id, usage.oldest]);
        return null;
      }
      const [r] = await q("SELECT * FROM cloud_campaign_recipients WHERE campaign_id=$1 AND status='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE", [c.id]);
      if (!r) {
        await q("UPDATE cloud_campaigns SET status='completed',updated_at=now() WHERE id=$1", [c.id]);
        return null;
      }
      if (await this.suppressed(q, tenant, r.phone)) {
        await q("UPDATE cloud_campaign_recipients SET status='skipped',error_reason='Recipient opted out or is blocked' WHERE id=$1", [r.id]);
        return null;
      }
      const components = templateComponents(c.template_snapshot, r.body_params, c.header_params, c.button_params);
      const id = randomUUID();
      const request = { name: c.template_name, language: { code: c.language }, components };
      await q(`INSERT INTO cloud_message_attempts(id,campaign_id,recipient_id,organization_id,user_id,phone_number_id,phone,request_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [id,c.id,r.id,c.organization_id,c.user_id,c.phone_number_id,r.phone,JSON.stringify(request)]);
      await q("UPDATE cloud_campaign_recipients SET status='dispatching',latest_attempt_id=$2,error_reason=NULL WHERE id=$1", [r.id,id]);
      await q("UPDATE cloud_campaigns SET status='running',next_send_at=now()+interval '1 second'*interval_seconds,updated_at=now() WHERE id=$1", [c.id]);
      return { campaign: c, recipient: r, attemptId: id, request };
    });
  }
  async accepted(id: string, messageId: string) {
    await this.database.transaction(async q => {
      await q(`UPDATE cloud_message_attempts SET message_id=$2,accepted_at=coalesce(accepted_at,now()),
        status=CASE WHEN status IN ('dispatching','unknown') THEN 'accepted' ELSE status END,
        error_reason=CASE WHEN status IN ('dispatching','unknown') THEN NULL ELSE error_reason END
        WHERE id=$1 AND (message_id IS NULL OR message_id=$2)`, [id,messageId]);
      await this.reconcile(q, id);
    });
  }
  async outcome(id: string, status: 'failed' | 'unknown' | 'skipped', reason: string, code?: string) {
    await this.database.transaction(async q => {
      await q(`UPDATE cloud_message_attempts SET status=$2,error_reason=$3,error_code=$4,
        failed_at=CASE WHEN $2='failed' THEN now() ELSE failed_at END WHERE id=$1 AND status='dispatching'`, [id,status,reason,code || null]);
      await this.project(q,id);
    });
  }
  async recover() {
    const rows = await this.database.query("SELECT id FROM cloud_message_attempts WHERE status='dispatching' AND created_at<now()-interval '2 minutes'");
    for (const row of rows) await this.outcome(row.id,'unknown','Send was interrupted; delivery is uncertain. Not automatically retried.');
  }
  private async project(q: Query, id: string) {
    await q(`UPDATE cloud_campaign_recipients r SET status=a.status,error_reason=a.error_reason
      FROM cloud_message_attempts a WHERE a.id=$1 AND r.latest_attempt_id=a.id`, [id]);
  }
  private async reconcile(q: Query, id: string) {
    const [a] = await q('SELECT * FROM cloud_message_attempts WHERE id=$1 FOR UPDATE', [id]);
    if (!a) return;
    await q(`UPDATE cloud_message_status_events SET attempt_id=$1 WHERE organization_id=$2 AND user_id=$3
      AND phone_number_id=$4 AND message_id=$5 AND recipient_phone=$6 AND attempt_id IS NULL`,
    [id,a.organization_id,a.user_id,a.phone_number_id,a.message_id,a.phone]);
    const [s] = await q(`SELECT min(occurred_at) FILTER(WHERE status='sent') AS sent_at,
      min(occurred_at) FILTER(WHERE status='delivered') AS delivered_at,
      min(occurred_at) FILTER(WHERE status='read') AS read_at,
      min(occurred_at) FILTER(WHERE status='failed') AS failed_at
      FROM cloud_message_status_events WHERE organization_id=$1 AND user_id=$2 AND phone_number_id=$3
      AND message_id=$4 AND recipient_phone=$5`, [a.organization_id,a.user_id,a.phone_number_id,a.message_id,a.phone]);
    const status = s.read_at ? 'read' : s.delivered_at ? 'delivered' : s.failed_at ? 'failed' : s.sent_at ? 'sent' : a.status;
    const [failure] = s.failed_at ? await q(`SELECT payload FROM cloud_message_status_events WHERE organization_id=$1 AND user_id=$2
      AND phone_number_id=$3 AND message_id=$4 AND recipient_phone=$5 AND status='failed' ORDER BY occurred_at DESC LIMIT 1`,
    [a.organization_id,a.user_id,a.phone_number_id,a.message_id,a.phone]) : [];
    const error = failure?.payload?.errors?.[0];
    await q(`UPDATE cloud_message_attempts SET status=$2,sent_at=$3,delivered_at=$4,read_at=$5,failed_at=coalesce($6,failed_at),
      error_reason=$7,error_code=$8 WHERE id=$1`, [id,status,s.sent_at,s.delivered_at,s.read_at,s.failed_at,
      status==='failed' ? error?.error_data?.details || error?.message || error?.title || a.error_reason : ['read','delivered','sent'].includes(status) ? null : a.error_reason,
      status==='failed' ? String(error?.code || a.error_code || '') : null]);
    await this.project(q,id);
  }
  // Called only after signature verification, BEFORE webhook HTTP 200.
  async persistWebhook(body: Row) {
    if (body.object !== 'whatsapp_business_account') return;
    await this.database.transaction(async q => {
      for (const entry of body.entry || []) for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        const phoneId = String(value.metadata?.phone_number_id || '');
        const sessions = await q(`SELECT organization_id,user_id FROM whatsapp_sessions WHERE provider='cloud_api'
          AND cloud_phone_number_id=$1 AND cloud_waba_id=$2`, [phoneId,String(entry.id)]);
        if (!sessions.length) continue;
        if (sessions.length !== 1) throw new Error('Ambiguous official sender mapping');
        const owner = sessions[0];
        for (const status of value.statuses || []) {
          if (!status.id || !status.recipient_id || !status.status) continue;
          const time = new Date(Number(status.timestamp)*1000);
          if (!Number.isFinite(time.getTime())) continue;
          const key = createHash('sha256').update(JSON.stringify([phoneId,status.id,status.status,status.timestamp])).digest('hex');
          const opaque = typeof status.biz_opaque_callback_data === 'string' ? status.biz_opaque_callback_data : '';
          // A callback id is useful when the webhook beats saving the send response. Scope it fully.
          const [attempt] = await q(`SELECT id FROM cloud_message_attempts WHERE organization_id=$1 AND user_id=$2
            AND phone_number_id=$3 AND phone=$4 AND (message_id=$5 OR (id=$6 AND message_id IS NULL)) FOR UPDATE`,
          [owner.organization_id,owner.user_id,phoneId,String(status.recipient_id),String(status.id),opaque]);
          await q(`INSERT INTO cloud_message_status_events(id,event_key,organization_id,user_id,phone_number_id,waba_id,
            message_id,recipient_phone,status,occurred_at,attempt_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
            ON CONFLICT(event_key) DO NOTHING`, [randomUUID(),key,owner.organization_id,owner.user_id,phoneId,String(entry.id),
            String(status.id),String(status.recipient_id),String(status.status),time.toISOString(),attempt?.id || null,JSON.stringify(status)]);
          if (attempt) {
            await q('UPDATE cloud_message_attempts SET message_id=$2 WHERE id=$1 AND message_id IS NULL',[attempt.id,String(status.id)]);
            await this.reconcile(q,attempt.id);
          }
        }
        for (const msg of value.messages || []) {
          const text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || '';
          const payload = msg.button?.payload || msg.interactive?.button_reply?.id || '';
          if (!msg.id || !msg.from || !(String(text).trim().toUpperCase()==='STOP' || ['STOP','STOP_MESSAGES'].includes(String(payload).toUpperCase()))) continue;
          const key = createHash('sha256').update(JSON.stringify([phoneId,msg.id,'opted_out'])).digest('hex');
          await q(`INSERT INTO cloud_message_status_events(id,event_key,organization_id,user_id,phone_number_id,waba_id,
            message_id,recipient_phone,status,occurred_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'opted_out',now(),'{}')
            ON CONFLICT(event_key) DO NOTHING`, [randomUUID(),key,owner.organization_id,owner.user_id,phoneId,String(entry.id),String(msg.id),String(msg.from)]);
        }
      }
    });
  }
}
