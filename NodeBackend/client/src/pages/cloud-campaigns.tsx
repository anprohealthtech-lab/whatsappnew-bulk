import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { apiRequest } from '@/lib/queryClient';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, Download, Plus, ShieldCheck } from 'lucide-react';

type Row = Record<string, any>;
const selectClass='w-full border rounded-md bg-background p-2 text-sm';
const parameterCount=(text='')=>Math.max(0,...Array.from(text.matchAll(/\{\{(\d+)\}\}/g)).map(m=>Number(m[1])));

export default function CloudCampaigns() {
  const [,navigate]=useLocation();
  const cache=useQueryClient();
  const {user}=useAuth();
  const [selected,setSelected]=useState('');
  const [creating,setCreating]=useState(false);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [name,setName]=useState('');
  const [sessionId,setSessionId]=useState('');
  const [templateKey,setTemplateKey]=useState('');
  const [media,setMedia]=useState('');
  const [headerTexts,setHeaderTexts]=useState<string[]>([]);
  const [buttonTexts,setButtonTexts]=useState<Record<number,string>>({});
  const [consent,setConsent]=useState('');
  const [csv,setCsv]=useState('name,phone,param_1\n');
  const [daily,setDaily]=useState(100);
  const [interval,setIntervalSeconds]=useState(25);
  const [scheduled,setScheduled]=useState('');
  const [launchPreview,setLaunchPreview]=useState(false);
  const {data:senders=[],error:senderError}=useQuery<Row[]>({queryKey:['/api/cloud/campaign-senders',user?.id],queryFn:async()=> (await apiRequest('GET','/api/cloud/campaign-senders')).json()});
  const {data:campaigns=[],error:listError}=useQuery<Row[]>({queryKey:['/api/cloud/campaigns',user?.id],refetchInterval:5000,queryFn:async()=> (await apiRequest('GET','/api/cloud/campaigns')).json()});
  const {data:templates=[],error:templateError}=useQuery<Row[]>({queryKey:['/api/cloud/campaign-templates',user?.id,sessionId],enabled:!!sessionId,
    queryFn:async()=> (await apiRequest('GET',`/api/cloud/campaign-templates?sessionId=${encodeURIComponent(sessionId)}`)).json()});
  const {data:report,error:reportError}=useQuery<Row>({queryKey:['/api/cloud/campaigns',user?.id,selected],enabled:!!selected,refetchInterval:5000,queryFn:async()=> (await apiRequest('GET',`/api/cloud/campaigns/${selected}`)).json()});
  const {data:events=[],error:eventsError}=useQuery<Row[]>({queryKey:['/api/cloud/status-events',user?.id],refetchInterval:10000,queryFn:async()=> (await apiRequest('GET','/api/cloud/status-events')).json()});
  const template=templates.find(t=>`${t.name}:${t.language}`===templateKey);
  const header=template?.components?.find((p:Row)=>p.type==='HEADER');
  const body=template?.components?.find((p:Row)=>p.type==='BODY');
  const buttons:Row[]=template?.components?.find((p:Row)=>p.type==='BUTTONS')?.buttons || [];
  async function work(fn:()=>Promise<void>) {
    setBusy(true);setError('');
    try {await fn();await cache.invalidateQueries({queryKey:['/api/cloud/campaigns']});}
    catch(e){setError(e instanceof Error ? e.message : 'Request failed');}
    finally{setBusy(false);}
  }
  async function createDraft(){
    if(!template) throw new Error('Choose an approved template');
    const XLSX=await import('xlsx');
    const workbook=XLSX.read(csv,{type:'string',raw:true});
    const rows=XLSX.utils.sheet_to_json<Row>(workbook.Sheets[workbook.SheetNames[0]],{defval:'',raw:false});
    const count=parameterCount(body?.text);
    const recipients=rows.map(r=>({name:String(r.name || '').trim(),phone:String(r.phone || '').trim(),
      bodyParams:Array.from({length:count},(_,i)=>String(r[`param_${i+1}`] || '').trim()),consentNote:consent}));
    const headerParams= !header ? [] : header.format==='TEXT'
      ? Array.from({length:parameterCount(header.text)},(_,i)=>({type:'text',text:headerTexts[i] || ''}))
      : [{type:header.format.toLowerCase(),[header.format.toLowerCase()]:{link:media}}];
    const buttonParams=buttons.flatMap((b,i)=>b.type==='URL' && parameterCount(b.url)>0
      ? [{index:i,subType:'url',text:buttonTexts[i] || ''}] : []);
    const result=await (await apiRequest('POST','/api/cloud/campaigns',{name,sessionId,templateName:template.name,
      language:template.language,headerParams,buttonParams,intervalSeconds:interval,dailyLimit:daily,recipients})).json();
    setSelected(result.id);setCreating(false);
  }
  const action=(value:string)=>work(async()=>{
    await apiRequest('POST',`/api/cloud/campaigns/${selected}/${value}`,
      value==='start' && scheduled ? {scheduledAt:new Date(scheduled).toISOString()} : {});
    setLaunchPreview(false);
  });
  const download=()=>work(async()=>{
    const response=await apiRequest('GET',`/api/cloud/campaigns/${selected}/report.csv`);
    const url=URL.createObjectURL(await response.blob());
    const a=document.createElement('a');a.href=url;a.download='official-whatsapp-report.csv';a.click();URL.revokeObjectURL(url);
  });
  const counts:Row=report?.counts || {};
  return <main className="min-h-screen bg-background text-foreground overflow-y-auto"><div className="max-w-6xl mx-auto p-6 space-y-6">
    <Button variant="ghost" onClick={()=>{if(selected || creating){setSelected('');setCreating(false);setLaunchPreview(false);}else navigate('/');}}><ArrowLeft className="w-4 h-4 mr-2"/>Back</Button>
    <div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-bold flex gap-2 items-center"><ShieldCheck/>Official WhatsApp campaigns</h1>
      <p className="text-muted-foreground mt-2">Approved templates, scheduled batches and delivery reports.</p></div>
      {!creating && !selected && <Button onClick={()=>{setCreating(true);setError('');}}><Plus className="w-4 h-4 mr-2"/>New campaign</Button>}</div>
    {(error || listError || reportError || senderError || templateError || eventsError) && <div role="alert" className="border border-destructive text-destructive rounded-lg p-4">{error || String(listError || reportError || senderError || templateError || eventsError)}</div>}
    {creating ? <form className="border rounded-xl p-6 space-y-5" onSubmit={e=>{e.preventDefault();void work(createDraft);}}>
      <div className="grid md:grid-cols-2 gap-4"><div><Label htmlFor="campaign-name">Campaign name</Label><Input id="campaign-name" required value={name} onChange={e=>setName(e.target.value)}/></div>
      <div><Label htmlFor="sender">Sender number</Label><select id="sender" className={selectClass} required value={sessionId} onChange={e=>{setSessionId(e.target.value);setTemplateKey('');}}><option value="">Select official number</option>{senders.map(s=><option key={s.id} value={s.id} disabled={s.status!=='connected'}>{s.phone_number || s.session_name} · {s.status}</option>)}</select></div></div>
      <div><Label htmlFor="template">Approved template</Label><select id="template" className={selectClass} required value={templateKey} onChange={e=>{setTemplateKey(e.target.value);setMedia('');setHeaderTexts([]);setButtonTexts({});}}><option value="">Select template and language</option>{templates.map(t=><option key={`${t.name}:${t.language}`} value={`${t.name}:${t.language}`}>{t.name} · {t.language} · {t.category}</option>)}</select></div>
      {template && <div className="rounded-lg bg-muted p-4 whitespace-pre-wrap text-sm">{header?.text && <p className="font-semibold">{header.text}</p>}<p>{body?.text}</p>{template.components?.filter((p:Row)=>p.type==='FOOTER').map((p:Row,i:number)=><p key={i} className="mt-2 text-muted-foreground">{p.text}</p>)}{buttons.length>0 && <p className="mt-3">Buttons: {buttons.map(b=>b.text).join(' · ')}</p>}</div>}
      {header && header.format!=='TEXT' && <div><Label htmlFor="media">{header.format} header URL</Label><Input id="media" type="url" placeholder="https://…" required value={media} onChange={e=>setMedia(e.target.value)}/><p className="text-xs text-muted-foreground mt-1">Use a durable HTTPS link that Meta can download.</p></div>}
      {header?.format==='TEXT' && Array.from({length:parameterCount(header.text)},(_,i)=><div key={i}><Label>Header parameter {i+1}</Label><Input required value={headerTexts[i] || ''} onChange={e=>setHeaderTexts(old=>{const next=[...old];next[i]=e.target.value;return next;})}/></div>)}
      {buttons.map((b,i)=>b.type==='URL' && parameterCount(b.url)>0 && <div key={i}><Label>{b.text} — URL parameter</Label><Input required value={buttonTexts[i] || ''} onChange={e=>setButtonTexts(old=>({...old,[i]:e.target.value}))}/></div>)}
      <div><Label htmlFor="recipients">Recipients CSV</Label><p className="text-sm text-muted-foreground mb-2">Columns: name, phone{Array.from({length:parameterCount(body?.text)},(_,i)=>`, param_${i+1}`).join('')}. Include country codes. One recipient per row; duplicates are rejected.</p>
        <Input aria-label="Import recipients CSV" type="file" accept=".csv,text/csv" onChange={e=>{const file=e.target.files?.[0];if(file) void work(async()=>{if(file.size>500000)throw new Error('CSV must be under 500 KB');setCsv(await file.text());});}}/>
        <Textarea id="recipients" className="mt-2 font-mono" rows={7} required value={csv} onChange={e=>setCsv(e.target.value)}/></div>
      <div><Label htmlFor="consent">Audience opt-in source</Label><Input id="consent" required placeholder="Where and when this audience opted in" value={consent} onChange={e=>setConsent(e.target.value)}/></div>
      <div className="grid md:grid-cols-2 gap-4"><div><Label htmlFor="daily">Campaign send attempts per rolling 24 hours</Label><Input id="daily" type="number" min={1} max={250} required value={daily} onChange={e=>setDaily(Number(e.target.value))}/></div>
      <div><Label htmlFor="interval">Seconds between recipients</Label><Input id="interval" type="number" min={5} max={3600} required value={interval} onChange={e=>setIntervalSeconds(Number(e.target.value))}/></div></div>
      <p className="text-sm text-muted-foreground">Meta’s account and recipient limits still apply. Saving creates a draft; review the audience before starting.</p>
      <Button type="submit" disabled={busy}>Save draft</Button>
    </form> : selected ? report && <section className="space-y-5">
      <div className="border rounded-xl p-5 space-y-3"><h2 className="text-xl font-semibold">{report.campaign.name}</h2><p>{report.campaign.template_name} · {report.campaign.language} · {report.campaign.status}</p>
        <p className="text-sm text-muted-foreground">Sender: {senders.find(s=>s.id===report.campaign.session_id)?.phone_number || report.campaign.phone_number_id} · {report.recipients.length} recipients · {report.campaign.daily_limit} attempts per 24 hours</p>
        <details className="text-sm border rounded-lg p-3"><summary className="cursor-pointer font-medium">Saved campaign content and audience details</summary>
          <div className="mt-3 space-y-3"><p>WABA: {report.campaign.waba_id} · Sender ID: {report.campaign.phone_number_id}</p>
            <p>Interval: {report.campaign.interval_seconds} seconds · Category: {report.campaign.template_snapshot?.category || '—'}</p>
            {report.campaign.template_snapshot?.components?.filter((p:Row)=>p.text).map((p:Row,i:number)=><p className="whitespace-pre-wrap" key={i}>{p.text}</p>)}
            {(report.campaign.header_params || []).map((p:Row,i:number)=><p key={i} className="break-all">Header: {p.text || p.image?.link || p.video?.link || p.document?.link}</p>)}
            <div className="max-h-64 overflow-auto"><table className="text-left w-full"><thead><tr><th className="p-2">Recipient</th><th className="p-2">Parameters</th><th className="p-2">Opt-in source</th></tr></thead><tbody>{report.recipients.map((r:Row)=><tr className="border-t" key={r.id}><td className="p-2">{r.name}</td><td className="p-2">{(r.body_params || []).join(' · ')}</td><td className="p-2">{r.consent_note}</td></tr>)}</tbody></table></div>
          </div></details>
        {report.campaign.error_reason && <p role="alert" className="text-destructive">{report.campaign.error_reason}</p>}
        {report.campaign.next_send_at && ['running','scheduled'].includes(report.campaign.status) && <p className="text-sm">Next eligible send: {new Date(report.campaign.next_send_at).toLocaleString()}</p>}
        <div className="flex flex-wrap gap-3">
          {['running','scheduled'].includes(report.campaign.status) ? <Button disabled={busy} onClick={()=>void action('pause')}>Pause campaign</Button> : (counts.pending || 0)>0 && <Button disabled={busy} onClick={()=>setLaunchPreview(true)}>Review and start</Button>}
          {!['running','scheduled'].includes(report.campaign.status) && (counts.failed || 0)>0 && <Button variant="outline" disabled={busy} onClick={()=>void action('retry-failed')}>Queue failed recipients for retry</Button>}
          <Button variant="outline" onClick={()=>void download()} disabled={busy}><Download className="w-4 h-4 mr-2"/>Download report</Button>
        </div>
        {launchPreview && <div className="border rounded-lg p-4 space-y-3"><p>Send <strong>{report.campaign.template_name}</strong> to the <strong>{counts.pending || 0} pending recipients</strong> shown below. Approved template messages may incur Meta charges.</p>
          <Label htmlFor="scheduled">Optional start time (your local timezone)</Label><Input id="scheduled" type="datetime-local" value={scheduled} onChange={e=>setScheduled(e.target.value)}/>
          <Button disabled={busy} onClick={()=>void action('start')}>{scheduled ? 'Schedule campaign' : 'Start sending'}</Button><Button className="ml-2" variant="ghost" onClick={()=>setLaunchPreview(false)}>Cancel</Button></div>}
      </div>
      <div><h3 className="font-medium mb-2">Latest recipient status</h3><div className="flex flex-wrap gap-2">{['pending','dispatching','accepted','sent','delivered','read','failed','unknown','skipped'].map(s=><div key={s} className="border rounded-lg px-4 py-3"><p className="text-2xl font-semibold">{counts[s] || 0}</p><p className="text-xs capitalize">{s}</p></div>)}</div>
      <p className="text-xs text-muted-foreground mt-3">Accepted means Meta accepted the request. Delivery and read states require a webhook. Unknown sends are held for review and are never retried automatically. Pausing allows an already-dispatched message to finish.</p></div>
      <div className="overflow-x-auto border rounded-xl"><table className="w-full text-sm text-left"><thead className="bg-muted"><tr>{['Name','Phone','Status','Delivered','Read','Error'].map(h=><th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{report.recipients.map((r:Row)=><tr key={r.id} className="border-t"><td className="p-3">{r.name}</td><td className="p-3">{r.phone}</td><td className="p-3">{r.status}</td><td className="p-3">{r.delivered_at ? new Date(r.delivered_at).toLocaleString() : '—'}</td><td className="p-3">{r.read_at ? new Date(r.read_at).toLocaleString() : '—'}</td><td className="p-3">{r.error_reason || '—'}</td></tr>)}</tbody></table></div>
    </section> : <section className="space-y-3">{campaigns.length===0 && <div className="border border-dashed rounded-xl p-10 text-center text-muted-foreground">No official campaigns yet. Create a draft to prepare your audience and approved template.</div>}{campaigns.map(c=><button key={c.id} className="w-full text-left border rounded-xl p-4 hover:bg-accent" onClick={()=>{setSelected(c.id);setScheduled('');setError('');}}><span className="font-semibold">{c.name}</span><p className="text-sm text-muted-foreground mt-1">{c.template_name} · {c.total} recipients · {c.status}</p></button>)}</section>}
    {!creating && !selected && <section className="border rounded-xl p-5"><h2 className="font-semibold">Recent official WhatsApp receipts</h2><p className="text-sm text-muted-foreground my-2">Also captures direct API sends. Only receipts received after tracking was enabled are available.</p><div className="overflow-auto max-h-80"><table className="w-full text-left text-sm"><thead><tr>{['Received','Recipient','Status','Message ID'].map(s=><th key={s} className="p-2">{s}</th>)}</tr></thead><tbody>{events.map(e=><tr key={e.id} className="border-t"><td className="p-2 whitespace-nowrap">{new Date(e.received_at).toLocaleString()}</td><td className="p-2">{e.recipient_phone}</td><td className="p-2">{e.status}</td><td className="p-2 max-w-xs truncate" title={e.message_id}>{e.message_id}</td></tr>)}</tbody></table>{!events.length && <p className="py-4 text-muted-foreground">No receipts recorded yet.</p>}</div></section>}
  </div></main>;
}
