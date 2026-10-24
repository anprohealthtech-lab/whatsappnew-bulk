import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { CloudCampaignStore } from './store';
import { cloudSchemaSql } from './schema';
import { csvCell, normalizePhone, templateComponents, type Query } from './model';

const pg = new PGlite();
const q: Query = async(text,params=[]) => (await pg.query(text,params)).rows as any[];
const store = new CloudCampaignStore({query:q,transaction:fn=>pg.transaction(tx=>fn(async(text,params=[])=> (await tx.query(text,params)).rows as any[]))});
const tenant={organizationId:'clinic',userId:'owner'};
const other={organizationId:'other',userId:'other-owner'};
const template={name:'dr_amit_now_available',language:'en',status:'APPROVED',components:[
  {type:'HEADER',format:'IMAGE'}, {type:'BODY',text:'Hello {{1}}'},
  {type:'BUTTONS',buttons:[{type:'QUICK_REPLY',text:'STOP'}]},
]};
const input=()=>({name:'Test draft',sessionId:'cloud',templateName:template.name,language:'en',
  headerParams:[{type:'image',image:{link:'https://example.com/creative.jpg'}}],
  dailyLimit:100,intervalSeconds:5,
  recipients:[{name:'Fixture',phone:'+91 90000 00001',bodyParams:['Fixture'],consentNote:'Test fixture consent'}]});
const webhook=(status='delivered',id='wamid.1',opaque?:string,phone='919000000001',timestamp='1792850000',phoneId='phone-1',waba='waba-1')=>({
  object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{metadata:{phone_number_id:phoneId},statuses:[{
    id,status,recipient_id:phone,timestamp,...(opaque?{biz_opaque_callback_data:opaque}:{}),
    ...(status==='failed'?{errors:[{code:131026,title:'Undeliverable'}]}:{}),
  }]}}]}],
});
async function started() {
  const campaign=await store.create(tenant,input(),template);
  await store.control(tenant,campaign.id,'start');
  return campaign;
}
before(async()=>{
  await pg.exec(`CREATE TABLE whatsapp_sessions(id text,organization_id text,user_id text,session_name text,phone_number text,
    cloud_phone_number_id text,cloud_waba_id text,status text,provider text);
    CREATE TABLE blocked_numbers(organization_id text,user_id text,phone_number text);
    CREATE TABLE campaigns(id text,original_message text);
    CREATE TABLE campaign_recipients(id text,status text);
    INSERT INTO campaigns VALUES('legacy','Baileys original');INSERT INTO campaign_recipients VALUES('legacy','sent');`);
  await pg.exec(cloudSchemaSql);
  await pg.exec(cloudSchemaSql); // Re-deploy migration is idempotent.
});
beforeEach(async()=>{
  await pg.exec('TRUNCATE cloud_message_status_events,cloud_message_attempts,cloud_campaign_recipients,cloud_campaigns,whatsapp_sessions,blocked_numbers CASCADE');
  await q(`INSERT INTO whatsapp_sessions VALUES('cloud','clinic','owner','cloud','919999999999','phone-1','waba-1','connected','cloud_api'),
    ('other','other','other-owner','cloud','918888888888','phone-2','waba-2','connected','cloud_api'),
    ('baileys','clinic','owner','default','917777777777',NULL,NULL,'connected','baileys')`);
});
after(()=>pg.close());

test('additive migration and draft leave Baileys records untouched; draft does not send',async()=>{
  const c=await store.create(tenant,input(),template);
  assert.equal(c.status,'draft');
  assert.equal(await store.claim(c.id),null);
  assert.deepEqual(await q('SELECT * FROM campaigns'),[{id:'legacy',original_message:'Baileys original'}]);
  assert.deepEqual(await q('SELECT * FROM campaign_recipients'),[{id:'legacy',status:'sent'}]);
});
test('tenant isolation and explicit Cloud API sender selection',async()=>{
  const c=await store.create(tenant,input(),template);
  assert.equal((await store.list(other)).length,0);
  await assert.rejects(store.report(other,c.id),/not found/);
  await assert.rejects(store.control(other,c.id,'start'),/not found/);
  await assert.rejects(store.create(tenant,{...input(),sessionId:'baileys'},template),/not found/);
  await assert.rejects(store.create(other,input(),template),/not found/);
});
test('campaign validation rejects duplicates, unapproved templates and wrong parameters',async()=>{
  const data=input();data.recipients.push(data.recipients[0]);
  await assert.rejects(store.create(tenant,data,template),/Duplicate/);
  await assert.rejects(store.create(tenant,input(),{...template,status:'PAUSED'}),/approved/);
  const bad=input();bad.recipients[0].bodyParams=[];
  await assert.rejects(store.create(tenant,bad,template),/parameter count/);
  assert.equal((await store.list(tenant)).length,0);
});
test('one claim only; acceptance is distinct from delivery',async()=>{
  const c=await started();const claim=await store.claim(c.id);assert.ok(claim);
  assert.equal(await store.claim(c.id),null);
  await store.accepted(claim.attemptId,'wamid.1');
  const report=await store.report(tenant,c.id);
  assert.equal(report.counts.accepted,1);assert.equal(report.recipients[0].delivered_at,null);
});
test('duplicate and out-of-order receipts do not regress read state',async()=>{
  const c=await started();const claim=(await store.claim(c.id))!;await store.accepted(claim.attemptId,'wamid.1');
  for(const status of ['read','read','sent','delivered','failed']) await store.persistWebhook(webhook(status));
  const report=await store.report(tenant,c.id);
  assert.equal(report.counts.read,1);assert.ok(report.recipients[0].read_at);assert.ok(report.recipients[0].delivered_at);
  assert.equal(report.recipients[0].error_reason,null);
  assert.equal((await q('SELECT * FROM cloud_message_status_events')).length,4);
});
test('receipt before send response is linked using callback and acceptance does not regress it',async()=>{
  const c=await started();const claim=(await store.claim(c.id))!;
  await store.persistWebhook(webhook('delivered','wamid.1',claim.attemptId));
  assert.equal((await store.report(tenant,c.id)).counts.delivered,1);
  await store.accepted(claim.attemptId,'wamid.1');
  assert.equal((await store.report(tenant,c.id)).counts.delivered,1);
});
test('orphan receipts persist and reconcile when message ID is saved later',async()=>{
  await store.persistWebhook(webhook());
  const c=await started();const claim=(await store.claim(c.id))!;
  await store.accepted(claim.attemptId,'wamid.1');
  assert.equal((await store.report(tenant,c.id)).counts.delivered,1);
  assert.equal((await q('SELECT attempt_id FROM cloud_message_status_events'))[0].attempt_id,claim.attemptId);
});
test('cross-tenant, wrong WABA and wrong recipient callbacks cannot change another attempt',async()=>{
  const c=await started();const claim=(await store.claim(c.id))!;
  await store.persistWebhook(webhook('read','wamid.other',claim.attemptId,'919000000001','1792850000','phone-2','waba-2'));
  await store.persistWebhook(webhook('read','wamid.wrong',claim.attemptId,'919000000099'));
  await store.persistWebhook(webhook('read','wamid.bad',claim.attemptId,'919000000001','1792850000','phone-1','waba-2'));
  assert.equal((await store.report(tenant,c.id)).counts.dispatching,1);
});
test('failed sends can be explicitly queued; late old receipts cannot overwrite a new attempt',async()=>{
  const c=await started();const first=(await store.claim(c.id))!;
  await store.accepted(first.attemptId,'wamid.1');await store.persistWebhook(webhook('failed'));
  assert.equal((await store.report(tenant,c.id)).recipients[0].error_code,'131026');
  await store.control(tenant,c.id,'pause');await store.control(tenant,c.id,'retry-failed');await store.control(tenant,c.id,'start');
  const second=(await store.claim(c.id))!;assert.notEqual(second.attemptId,first.attemptId);
  await store.accepted(second.attemptId,'wamid.2');await store.persistWebhook(webhook('failed'));
  assert.equal((await store.report(tenant,c.id)).counts.accepted,1);
  assert.equal((await store.report(tenant,c.id)).attempts.length,2);
});
test('restart recovery holds ambiguous sends and does not resend them',async()=>{
  const c=await started();const claim=(await store.claim(c.id))!;
  await q("UPDATE cloud_message_attempts SET created_at=now()-interval '3 minutes' WHERE id=$1",[claim.attemptId]);
  await store.recover();
  await store.control(tenant,c.id,'pause');await store.control(tenant,c.id,'retry-failed');await store.control(tenant,c.id,'start');
  assert.equal(await store.claim(c.id),null);assert.equal((await store.report(tenant,c.id)).counts.unknown,1);
  await store.persistWebhook(webhook('delivered','wamid.1',claim.attemptId));
  assert.equal((await store.report(tenant,c.id)).counts.delivered,1);
});
test('STOP quick reply persists suppression and does not suppress another tenant',async()=>{
  await store.persistWebhook({object:'whatsapp_business_account',entry:[{id:'waba-1',changes:[{field:'messages',value:{metadata:{phone_number_id:'phone-1'},messages:[{id:'inbound-stop',from:'919000000001',button:{text:'STOP',payload:'STOP'}}]}}]}]});
  const c=await started();assert.equal(await store.claim(c.id),null);
  assert.equal((await store.report(tenant,c.id)).counts.skipped,1);
  assert.equal(await store.suppressed(q,other,'919000000001'),false);
});
test('existing tenant blocklist and rolling campaign limit are respected',async()=>{
  await q("INSERT INTO blocked_numbers VALUES('clinic','owner','+91 90000 00001')");
  const c=await started();await store.claim(c.id);assert.equal((await store.report(tenant,c.id)).counts.skipped,1);
  await q('DELETE FROM blocked_numbers');
  const data=input();data.dailyLimit=1;data.recipients.push({...data.recipients[0],phone:'919000000002'});
  const limited=await store.create(tenant,data,template);await store.control(tenant,limited.id,'start');
  const claim=(await store.claim(limited.id))!;await store.accepted(claim.attemptId,'wamid.limit');
  await q("UPDATE cloud_campaigns SET next_send_at=now() WHERE id=$1",[limited.id]);
  assert.equal(await store.claim(limited.id),null);
  assert.equal((await store.report(tenant,limited.id)).counts.pending,1);
});
test('pause, schedule and empty completion never send extra messages',async()=>{
  const c=await started();await store.control(tenant,c.id,'pause');assert.equal(await store.claim(c.id),null);
  await store.control(tenant,c.id,'start',new Date(Date.now()+86400000).toISOString());assert.equal(await store.claim(c.id),null);
  await store.control(tenant,c.id,'pause');await store.control(tenant,c.id,'start');
  const claim=(await store.claim(c.id))!;await store.accepted(claim.attemptId,'wamid.1');
  await q('UPDATE cloud_campaigns SET next_send_at=now() WHERE id=$1',[c.id]);assert.equal(await store.claim(c.id),null);
  assert.equal((await store.campaign(tenant,c.id)).status,'completed');
});
test('CSV export escapes formulas and quotes; media template payload is preserved',()=>{
  assert.equal(csvCell('=HYPERLINK("evil")'),'"\'=HYPERLINK(""evil"")"');
  assert.equal(normalizePhone('+91 (90000) 00001'),'919000000001');
  assert.throws(()=>normalizePhone('123'),/country code/);
  const components=templateComponents(template,['Fixture'],input().headerParams,[]);
  assert.equal(components[0].parameters[0].image.link,'https://example.com/creative.jpg');
});
