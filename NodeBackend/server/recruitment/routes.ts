import type {Express,Request} from 'express';
import {z} from 'zod';
import {getTenant,requireAuth} from '../authMiddleware';
import {cloudStore,cloudSession} from '../cloud/runtime';
import {csvCell} from '../cloud/model';
import {recruitmentStore} from './runtime';

async function tenant(req:Request){
 const requested=req.query.userId;
 if(!requested||requested===req.auth!.userId)return getTenant(req);
 if(req.auth!.role!=='super_admin')throw new Error('Only an administrator can select another account');
 const [u]=await cloudStore.database.query('SELECT id,organization_id FROM users WHERE id=$1',[String(requested)]);
 if(!u)throw new Error('Account not found');
 return {organizationId:u.organization_id,userId:u.id};
}
const input=z.object({sessionId:z.string().min(1),recipients:z.array(z.object({name:z.string().trim().min(1).max(200),phone:z.string().min(1),sourceLeadId:z.string().min(1),consentNote:z.string().trim().max(1000).optional()})).min(1).max(1000)});
export function registerRecruitmentRoutes(app:Express){
 const route=(fn:any)=>async(req:any,res:any)=>{try{await fn(req,res);}catch(e){res.status(400).json({error:e instanceof Error?e.message:'Recruitment request failed'});}};
 app.get('/api/recruitment/candidates',requireAuth,route(async(req:any,res:any)=>res.json(await recruitmentStore.list(await tenant(req)))));
 app.get('/api/recruitment/senders',requireAuth,route(async(req:any,res:any)=>{
  const t=await tenant(req);res.json(await cloudStore.database.query(`SELECT id,session_name,phone_number,status FROM whatsapp_sessions WHERE organization_id=$1 AND user_id=$2 AND provider='cloud_api'`,[t.organizationId,t.userId]));
 }));
 app.post('/api/recruitment/enroll',requireAuth,route(async(req:any,res:any)=>{
  const t=await tenant(req),data=input.parse(req.body);
  const s=await cloudStore.session(t,data.sessionId);
  if(s.status!=='connected')throw new Error('Select the connected official WhatsApp sender');
  await recruitmentStore.enroll(t,s.session_name,data.recipients);
  res.json({candidates:await recruitmentStore.list(t),sent:false});
 }));
 app.post('/api/recruitment/start',requireAuth,route(async(req:any,res:any)=>{
  const t=await tenant(req);
  const data=z.object({sessionId:z.string().min(1),consentSource:z.string().trim().min(5).max(1000),candidateIds:z.array(z.string()).min(1).max(1000)}).parse(req.body);
  const session=await cloudSession(t,data.sessionId);
  const sender=await cloudStore.session(t,data.sessionId);
  const all=await recruitmentStore.list(t);
  const candidates=all.filter(c=>data.candidateIds.includes(c.id));
  if(candidates.length!==new Set(data.candidateIds).size)throw new Error('Candidate not found in this account');
  if(candidates.some(c=>c.status!=='awaiting_reply'||c.session_name!==sender.session_name))throw new Error('Only uncontacted candidates for this sender may be started');
  const previouslySent=await cloudStore.database.query(`SELECT DISTINCT r.phone FROM cloud_campaign_recipients r JOIN cloud_campaigns c ON c.id=r.campaign_id
   WHERE c.organization_id=$1 AND c.user_id=$2 AND c.template_name='cv_received' AND c.status NOT IN ('draft','cancelled')`,[t.organizationId,t.userId]);
  if(candidates.some(c=>previouslySent.some(r=>r.phone===c.phone)))throw new Error('A CV campaign already exists for an applicant. Review its delivery report before retrying.');
  const template=await session.getCampaignTemplate('cv_received','en');
  const campaign=await cloudStore.create(t,{name:'Accountant CV refresh - '+new Date().toISOString().slice(0,10),sessionId:data.sessionId,templateName:'cv_received',language:'en',headerParams:[],buttonParams:[],intervalSeconds:25,dailyLimit:100,
   recipients:candidates.map(c=>({name:c.name,phone:c.phone,bodyParams:[c.name,'Accounts Executive'],consentNote:data.consentSource}))},template);
  // Reserve every candidate under row locks before a worker can send. Concurrent
  // start requests may leave an unused draft, but cannot start duplicate invitations.
  await cloudStore.database.transaction(async q=>{
   for(const c of [...candidates].sort((a,b)=>a.id.localeCompare(b.id))){
    const [locked]=await q('SELECT status FROM recruitment_candidates WHERE id=$1 FOR UPDATE',[c.id]);
    if(locked?.status!=='awaiting_reply')throw new Error('An invitation was already queued for this applicant');
    await q("UPDATE recruitment_candidates SET status='invitation_queued',consent_note=$2,updated_at=now() WHERE id=$1",[c.id,data.consentSource]);
   }
  });
  await cloudStore.control(t,campaign.id,'start');
  res.json({campaignId:campaign.id,status:'running',recipients:candidates.length});
 }));
 app.get('/api/recruitment/candidates/:id/files',requireAuth,route(async(req:any,res:any)=>res.json(await recruitmentStore.files(await tenant(req),req.params.id))));
 app.get('/api/recruitment/files/:id',requireAuth,route(async(req:any,res:any)=>{
  const file=await recruitmentStore.download(await tenant(req),req.params.id);
  if(!file)return res.status(404).json({error:'CV not found'});
  res.setHeader('Content-Type',file.mime_type);res.setHeader('Content-Disposition',`attachment; filename="${file.file_name.replace(/[^\w. -]/g,'_')}"`);
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.send(Buffer.from(file.data,'base64'));
 }));
 app.get('/api/recruitment/report.csv',requireAuth,route(async(req:any,res:any)=>{
  const rows=await recruitmentStore.list(await tenant(req));
  const keys=['name','phone','position','status','current_organisation','current_ctc','expected_ctc','residence','cv_count'];
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="recruitment-report.csv"');
  res.send('\uFEFF'+[keys.map(csvCell).join(','),...rows.map(r=>keys.map(k=>csvCell(r[k]??r.answers?.[k]??'')).join(','))].join('\r\n'));
 }));
}
