import type { Express, Request, Response } from 'express';
import { requireAuth,getTenant } from '../authMiddleware';
import { campaignInput,csvCell } from './model';
import { cloudStore,cloudSession,validateCampaign } from './runtime';

export function registerCloudCampaignRoutes(app: Express) {
  const route = (fn: (req: Request,res: Response)=>Promise<unknown>) => async(req: Request,res: Response) => {
    try { await fn(req,res); }
    catch(e) { res.status(400).json({error:e instanceof Error ? e.message : 'Official campaign request failed'}); }
  };
  app.get('/api/cloud/campaign-senders',requireAuth,route(async(req,res)=>{
    const t=getTenant(req);
    const rows=await cloudStore.database.query(`SELECT id,session_name,phone_number,cloud_phone_number_id,cloud_waba_id,status
      FROM whatsapp_sessions WHERE organization_id=$1 AND user_id=$2 AND provider='cloud_api'`,[t.organizationId,t.userId]);
    res.json(rows);
  }));
  app.get('/api/cloud/campaign-templates',requireAuth,route(async(req,res)=>{
    const s=await cloudSession(getTenant(req),String(req.query.sessionId || ''));
    res.json((await s.listCampaignTemplates()).filter(t=>t.status==='APPROVED'));
  }));
  app.get('/api/cloud/campaigns',requireAuth,route(async(req,res)=>{res.json(await cloudStore.list(getTenant(req)));}));
  app.post('/api/cloud/campaigns',requireAuth,route(async(req,res)=>{
    const input=campaignInput.parse(req.body);
    const s=await cloudSession(getTenant(req),input.sessionId);
    const template=await s.getCampaignTemplate(input.templateName,input.language);
    res.status(201).json(await cloudStore.create(getTenant(req),input,template));
  }));
  app.get('/api/cloud/campaigns/:id',requireAuth,route(async(req,res)=>{res.json(await cloudStore.report(getTenant(req),req.params.id));}));
  app.get('/api/cloud/campaigns/:id/report.csv',requireAuth,route(async(req,res)=>{
    const report=await cloudStore.report(getTenant(req),req.params.id);
    const fields=['name','phone','status','message_id','accepted_at','sent_at','delivered_at','read_at','failed_at','error_code','error_reason','attempts'];
    const lines=[fields.map(csvCell).join(','),...report.recipients.map(r=>fields.map(f=>csvCell(r[f] instanceof Date ? r[f].toISOString() : r[f])).join(','))];
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="official-whatsapp-report.csv"');
    res.send('\uFEFF'+lines.join('\r\n'));
  }));
  app.post('/api/cloud/campaigns/:id/:action',requireAuth,route(async(req,res)=>{
    const action=req.params.action;
    if (!['start','pause','retry-failed'].includes(action)) throw new Error('Unknown campaign action');
    const t=getTenant(req);
    const c=await cloudStore.campaign(t,req.params.id);
    if(action==='start') await validateCampaign(c);
    if(req.body?.scheduledAt && typeof req.body.scheduledAt!=='string') throw new Error('Invalid scheduled time');
    await cloudStore.control(t,c.id,action as 'start'|'pause'|'retry-failed',req.body?.scheduledAt);
    res.json(await cloudStore.report(t,c.id));
  }));
  // Includes receipts for direct API/Python sends, even when they are not campaign-linked.
  app.get('/api/cloud/status-events',requireAuth,route(async(req,res)=>{
    const t=getTenant(req);
    res.json(await cloudStore.database.query(`SELECT * FROM cloud_message_status_events WHERE organization_id=$1 AND user_id=$2
      ORDER BY received_at DESC LIMIT 200`,[t.organizationId,t.userId]));
  }));
}
