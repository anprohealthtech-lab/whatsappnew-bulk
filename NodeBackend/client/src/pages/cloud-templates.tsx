import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { ArrowLeft, ExternalLink, FileText, Loader2, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { recruitmentAcknowledgmentBrief, templateContent, templateVariableCount, type TemplateContent, type TemplateButton } from '@shared/cloudTemplate';

type Row = Record<string, any>;
const selectClass = 'w-full border rounded-md bg-background p-2 text-sm';
const languages = [['en_US', 'English (US)'], ['en', 'English'], ['en_GB', 'English (UK)'], ['hi', 'Hindi'], ['gu', 'Gujarati'], ['mr', 'Marathi'], ['ta', 'Tamil'], ['te', 'Telugu'], ['bn', 'Bengali'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['pa', 'Punjabi'], ['ur', 'Urdu'], ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt_BR', 'Portuguese (Brazil)']];
const emptyDraft = (): TemplateContent => ({ name: '', category: 'UTILITY', language: 'en_US', headerText: '', bodyText: '', footerText: '', bodyExamples: [], buttons: [] });
function errorText(error: unknown) {
  if (error && typeof error === 'object' && 'issues' in error) return (error as { issues: { message: string }[] }).issues.map(i => i.message).join('. ');
  if (error instanceof Error) {
    try {
      const body = JSON.parse(error.message.replace(/^\d+:\s*/, ''));
      const message = body.error || body.message;
      if (typeof message === 'string') {
        try { const issues = JSON.parse(message); if (Array.isArray(issues)) return issues.map(i => i.message).join('. '); } catch { /* Plain error text. */ }
        return message;
      }
    } catch { /* Network errors do not contain a JSON response. */ }
    return error.message;
  }
  return 'Request failed';
}
function Preview({ draft }: { draft: TemplateContent }) {
  const [showSamples, setShowSamples] = useState(false);
  const body = showSamples ? draft.bodyText.replace(/\{\{(\d+)\}\}/g, (match, index) => draft.bodyExamples[Number(index) - 1] || match) : draft.bodyText;
  return <div className="rounded-xl border bg-muted/40 p-5 space-y-3 max-w-lg">
    <div className="flex flex-wrap gap-2" role="group" aria-label="Message preview mode">
      <Button type="button" size="sm" variant={!showSamples ? 'default' : 'outline'} aria-pressed={!showSamples} onClick={() => setShowSamples(false)}>Placeholders</Button>
      <Button type="button" size="sm" variant={showSamples ? 'default' : 'outline'} aria-pressed={showSamples} onClick={() => setShowSamples(true)}>Sample values</Button>
    </div>
    {draft.headerText && <p className="font-semibold">{draft.headerText}</p>}
    <p className="whitespace-pre-wrap break-words">{body || 'Your message preview appears here.'}</p>
    {draft.footerText && <p className="text-xs text-muted-foreground">{draft.footerText}</p>}
    {draft.buttons.map((b, i) => <div key={i} className="border-t pt-2 text-primary text-center text-sm">{b.text || 'Button'}</div>)}
  </div>;
}

export default function CloudTemplates() {
  const [, navigate] = useLocation();
  const cache = useQueryClient();
  const { user } = useAuth();
  const [sessionId, setSessionId] = useState(() => new URLSearchParams(window.location.search).get('sessionId') || '');
  const [draft, setDraft] = useState<TemplateContent>(emptyDraft);
  const [brief, setBrief] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [filter, setFilter] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const [busy, setBusy] = useState<'ai' | 'submit' | ''>('');
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState<TemplateContent | null>(null);
  const [submitted, setSubmitted] = useState<Row | null>(null);
  const [tab, setTab] = useState<'library' | 'create'>('library');
  const { data: senders = [], error: senderError } = useQuery<Row[]>({ queryKey: ['/api/cloud/campaign-senders', user?.id], queryFn: async () => (await apiRequest('GET', '/api/cloud/campaign-senders')).json() });
  const sender = senders.find(s => s.id === sessionId);
  const connected = sender?.status === 'connected';
  const libraryKey = ['/api/cloud/template-library', user?.id, sessionId];
  const { data: library, error: libraryError, isFetching, refetch } = useQuery<{ wabaId: string; templates: Row[] }>({
    queryKey: libraryKey, enabled: !!connected, refetchInterval: 60000,
    queryFn: async () => (await apiRequest('GET', `/api/cloud/template-library?sessionId=${encodeURIComponent(sessionId)}`)).json(),
  });
  const { data: billing, error: billingError } = useQuery<Row>({ queryKey: ['/api/cloud/billing-info', user?.id, sessionId], enabled: !!connected,
    queryFn: async () => (await apiRequest('GET', `/api/cloud/billing-info?sessionId=${encodeURIComponent(sessionId)}`)).json() });
  const templates = library?.templates || [];
  const visible = templates.filter(t => (filter === 'ALL' || t.status === filter) && (category === 'ALL' || t.category === category));
  let variableCount = 0;
  try { variableCount = templateVariableCount(draft.bodyText); } catch { /* Show validation when reviewing the draft. */ }
  const update = (patch: Partial<TemplateContent>) => { setDraft(old => ({ ...old, ...patch })); setReviewed(null); setError(''); };
  const updateButton = (index: number, button: TemplateButton) => update({ buttons: draft.buttons.map((b, i) => i === index ? button : b) });
  const sameSubmission = submitted?.sessionId === sessionId && submitted?.name === draft.name && submitted?.language === draft.language;
  async function generate() {
    setBusy('ai'); setError(''); setReviewed(null);
    try {
      const result = await (await apiRequest('POST', '/api/cloud/template-assistant', { sessionId, category: draft.category, language: draft.language, brief })).json();
      const parsed = templateContent.parse(result.template);
      setDraft(parsed); setNotes(result.notes || []);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(''); }
  }
  async function submit() {
    if (!reviewed) return;
    setBusy('submit'); setError('');
    try {
      const result = await (await apiRequest('POST', '/api/cloud/template-library', { sessionId, template: reviewed })).json();
      setSubmitted({ ...result, sessionId, name: reviewed.name, language: reviewed.language });
      setReviewed(null); setTab('library'); setFilter('ALL'); setCategory('ALL');
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['/api/cloud/template-library', user?.id, sessionId] }),
        cache.invalidateQueries({ queryKey: ['/api/cloud/campaign-templates', user?.id, sessionId] }),
      ]);
    } catch (e) { setError(`${errorText(e)}. Refresh the template list before retrying: Meta may have received the submission.`); }
    finally { setBusy(''); }
  }
  return <main className="min-h-screen bg-background text-foreground overflow-y-auto"><div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
    <Button variant="ghost" onClick={() => navigate('/cloud-campaigns')}><ArrowLeft className="w-4 h-4 mr-2" />Official campaigns</Button>
    <div className="space-y-2"><h1 className="text-2xl font-bold flex items-center gap-2"><FileText />WhatsApp templates</h1>
      <p className="text-muted-foreground">Draft with Claude Haiku, review your message, and submit it to Meta. Only approved templates can be used in campaigns.</p></div>
    <section className="border rounded-xl p-5 grid md:grid-cols-2 gap-5">
      <div className="space-y-2"><Label htmlFor="template-sender">Your WhatsApp number</Label><select id="template-sender" className={selectClass} value={sessionId} disabled={!!busy || !!reviewed} onChange={e => {
        setSessionId(e.target.value); setDraft(emptyDraft()); setNotes([]); setSubmitted(null); setError(''); setReviewed(null);
      }}><option value="">Select a connected official number</option>{senders.map(s => <option key={s.id} value={s.id} disabled={s.status !== 'connected'}>{s.phone_number || s.session_name} · {s.status}</option>)}</select>
        <p className="text-xs text-muted-foreground">Signed in as {user?.username}. Templates belong to the selected WhatsApp account. Numbers sharing that account share its templates.</p>
        {sender && <p className="text-xs text-muted-foreground">WhatsApp account: {sender.cloud_waba_id}</p>}
        {!senders.length && !senderError && <p className="text-sm">Connect an official WhatsApp number in WhatsApp Sessions to get started.</p>}</div>
      <div className="space-y-2"><h2 className="font-semibold">Meta billing & credit</h2>
        <p className="text-sm text-muted-foreground">{billing?.message || 'Select a connected number to view its WhatsApp account and open Meta Billing.'}</p>
        {billing && <a className="text-sm text-primary inline-flex items-center gap-1 underline" href={billing.billingUrl} target="_blank" rel="noopener noreferrer">Open Meta Billing<ExternalLink className="w-3 h-3" /></a>}
        {billing && <p className="text-xs text-muted-foreground">In Meta, select the business owning account {billing.wabaId}. Meta messaging charges are separate from AI drafting.</p>}</div>
    </section>
    {(error || senderError || libraryError || billingError) && <div role="alert" className="border border-destructive text-destructive rounded-lg p-4 break-words">{error || errorText(senderError || libraryError || billingError)}</div>}
    {submitted && <div role="status" className="border rounded-lg p-4 bg-muted/30"><strong>{submitted.name}</strong> was submitted to Meta. Status: <strong>{submitted.status}</strong>. Category: {submitted.category}. Meta decides approval and may change the category.</div>}
    <div className="flex gap-2 border-b pb-3"><Button variant={tab === 'library' ? 'default' : 'outline'} disabled={!!busy || !!reviewed} onClick={() => setTab('library')}>Template library</Button>
      <Button variant={tab === 'create' ? 'default' : 'outline'} disabled={!!busy} onClick={() => setTab('create')}><Plus className="w-4 h-4 mr-1" />Create template</Button></div>
    {tab === 'library' ? <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3"><div><Label htmlFor="status-filter">Status</Label><select id="status-filter" className={selectClass} value={filter} onChange={e => setFilter(e.target.value)}><option value="ALL">All statuses</option>{Array.from(new Set(['APPROVED', 'PENDING', 'REJECTED', ...templates.map(t => String(t.status))])).map(s => <option key={s}>{s}</option>)}</select></div>
        <div><Label htmlFor="category-filter">Category</Label><select id="category-filter" className={selectClass} value={category} onChange={e => setCategory(e.target.value)}>{['ALL', 'UTILITY', 'MARKETING', 'AUTHENTICATION'].map(s => <option key={s} value={s}>{s === 'ALL' ? 'All categories' : s}</option>)}</select></div>
        <Button variant="outline" disabled={!connected || isFetching} onClick={() => { void refetch(); void cache.invalidateQueries({ queryKey: ['/api/cloud/campaign-templates', user?.id, sessionId] }); }}><RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />Refresh status</Button></div>
      {!connected ? <p className="border border-dashed rounded-xl p-8 text-center text-muted-foreground">Choose a connected official number to see its templates.</p> : !visible.length ? <p className="border border-dashed rounded-xl p-8 text-center text-muted-foreground">{isFetching ? 'Loading templates…' : 'No templates match these filters. Create a template or refresh after Meta reviews a submission.'}</p> : <div className="grid md:grid-cols-2 gap-4">{visible.map(t => <article key={t.id || `${t.name}:${t.language}`} className="border rounded-xl p-5 space-y-3">
        <div className="flex justify-between gap-2"><h2 className="font-semibold break-all">{t.name}</h2><Badge variant={t.status === 'REJECTED' ? 'destructive' : t.status === 'APPROVED' ? 'default' : 'secondary'}>{t.status}</Badge></div>
        <p className="text-xs text-muted-foreground">{t.category} · {t.language}</p>
        {(t.components || []).filter((p: Row) => p.text).map((p: Row, i: number) => <p key={i} className={`whitespace-pre-wrap break-words text-sm ${p.type === 'HEADER' ? 'font-semibold' : ''}`}>{p.text}</p>)}
        {(t.components || []).filter((p: Row) => p.type === 'HEADER' && p.format !== 'TEXT').map((p: Row, i: number) => <p key={i} className="text-xs text-muted-foreground">{p.format} header</p>)}
        {(t.components || []).filter((p: Row) => p.type === 'BUTTONS').map((p: Row, i: number) => <p key={i} className="text-xs text-muted-foreground">Buttons: {(p.buttons || []).map((b: Row) => b.text).join(' · ')}</p>)}
        {t.rejected_reason && <p className="text-sm text-destructive">Meta rejection reason: {String(t.rejected_reason)}</p>}
        {t.status === 'APPROVED' && ['UTILITY', 'MARKETING'].includes(t.category) && <Button variant="outline" onClick={() => navigate(`/cloud-campaigns?${new URLSearchParams({ sessionId, template: t.name, language: t.language, category: t.category })}`)}>Use in a campaign</Button>}
        {t.category === 'AUTHENTICATION' && <p className="text-xs text-muted-foreground">Authentication templates use a dedicated OTP flow and are not available for bulk campaigns.</p>}
      </article>)}</div>}
    </section> : <section className="grid lg:grid-cols-2 gap-6 items-start">
      <div className="space-y-5"><fieldset className="border rounded-xl p-5 space-y-4 disabled:opacity-60" disabled={!connected || !!busy || !!reviewed}>
        <legend className="px-2 font-semibold flex items-center gap-2"><Sparkles className="w-4 h-4" />Claude Haiku helper</legend>
        <p className="text-sm text-muted-foreground">Describe the message and its purpose. Drafts stay short and WhatsApp-friendly, with placeholders for recipient details.</p>
        <p className="text-xs text-muted-foreground">Uses the category and language selected in the editor below.</p>
        <Button type="button" size="sm" variant="outline" onClick={() => { setBrief(recruitmentAcknowledgmentBrief); update({ category: 'UTILITY' }); setNotes([]); }}>Use recruitment prompt</Button>
        <Label htmlFor="template-brief">What should this template say?</Label><Textarea id="template-brief" rows={4} maxLength={3000} value={brief} onChange={e => setBrief(e.target.value)} placeholder="Confirm receipt of a recruitment profile/CV in 3 short lines. Use {{1}} for the candidate name and {{2}} for the role. Say HR will review and contact them about next steps." />
        <Button type="button" disabled={brief.trim().length < 10} onClick={() => void generate()}>{busy === 'ai' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}Generate draft</Button>
      </fieldset>
      {notes.length > 0 && <div className="border rounded-xl p-4 space-y-2"><h2 className="font-semibold">AI suggestions</h2>{notes.map((note, i) => <p key={i} className="text-sm text-muted-foreground">{note}</p>)}</div>}
      <form onSubmit={e => { e.preventDefault(); try {
        const count = templateVariableCount(draft.bodyText);
        const parsed = templateContent.parse({ ...draft, bodyExamples: Array.from({ length: count }, (_, i) => draft.bodyExamples[i] || '') });
        setDraft(parsed); setReviewed(parsed); setError('');
      } catch (error) { setError(errorText(error)); } }}>
        <fieldset className="border rounded-xl p-5 space-y-4 disabled:opacity-60" disabled={!connected || !!busy || !!reviewed}><legend className="px-2 font-semibold">Edit your template</legend>
          <div className="grid sm:grid-cols-2 gap-3"><div><Label htmlFor="template-category">Category</Label><select id="template-category" className={selectClass} value={draft.category} onChange={e => update({ category: e.target.value as TemplateContent['category'] })}><option value="UTILITY">Utility</option><option value="MARKETING">Marketing</option></select></div>
            <div><Label htmlFor="template-language">Language</Label><select id="template-language" className={selectClass} value={draft.language} onChange={e => update({ language: e.target.value })}>{languages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></div></div>
          <p className="text-xs text-muted-foreground">Utility is for an existing transaction, appointment or user request. Offers and promotional announcements belong to Marketing. Meta makes the final decision.</p>
          <div><Label htmlFor="template-name">Template name</Label><Input id="template-name" required pattern="[a-z0-9_]+" maxLength={512} value={draft.name} onChange={e => update({ name: e.target.value })} placeholder="appointment_confirmation" /></div>
          <div><Label htmlFor="template-header">Header (optional)</Label><Input id="template-header" maxLength={60} value={draft.headerText} onChange={e => update({ headerText: e.target.value })} /></div>
          <div><Label htmlFor="template-body">Message body</Label><Textarea id="template-body" required rows={7} maxLength={1024} value={draft.bodyText} onChange={e => update({ bodyText: e.target.value })} /><p className="text-xs text-muted-foreground mt-1">{draft.bodyText.length}/1024 · Use {'{{1}}, {{2}}'} for variables.</p></div>
          {variableCount > 0 && <p className="text-xs text-muted-foreground">Use fictional samples. Enter only each field value, such as Asha or Accountant, without a greeting or a full message.</p>}
          {Array.from({ length: variableCount }, (_, i) => <div key={i}><Label htmlFor={`sample-${i}`}>Sample for {`{{${i + 1}}}`}</Label><Input id={`sample-${i}`} required maxLength={200} value={draft.bodyExamples[i] || ''} onChange={e => update({ bodyExamples: Array.from({ length: variableCount }, (_, index) => index === i ? e.target.value : draft.bodyExamples[index] || '') })} /></div>)}
          <div><Label htmlFor="template-footer">Footer (optional)</Label><Input id="template-footer" maxLength={60} value={draft.footerText} onChange={e => update({ footerText: e.target.value })} /></div>
          <div className="space-y-3"><div className="flex justify-between items-center"><Label>Buttons (optional)</Label><Button type="button" size="sm" variant="outline" disabled={draft.buttons.length >= 3} onClick={() => update({ buttons: [...draft.buttons, { type: 'QUICK_REPLY', text: '' }] })}>Add button</Button></div>
            {draft.buttons.map((button, i) => <div key={i} className="border rounded-lg p-3 space-y-2"><div className="flex gap-2"><select aria-label={`Button ${i + 1} type`} className={selectClass} value={button.type} onChange={e => updateButton(i, e.target.value === 'URL' ? { type: 'URL', text: button.text, url: '' } : e.target.value === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: button.text, phone_number: '' } : { type: 'QUICK_REPLY', text: button.text })}><option value="QUICK_REPLY">Quick reply</option><option value="URL">Website</option><option value="PHONE_NUMBER">Call phone</option></select><Button type="button" variant="ghost" size="sm" aria-label={`Remove button ${i + 1}`} onClick={() => update({ buttons: draft.buttons.filter((_, index) => index !== i) })}><Trash2 className="w-4 h-4" /></Button></div>
              <Input aria-label={`Button ${i + 1} label`} required maxLength={25} placeholder="Button label" value={button.text} onChange={e => updateButton(i, { ...button, text: e.target.value })} />
              {button.type === 'URL' && <Input aria-label={`Button ${i + 1} URL`} type="url" required placeholder="https://your-business.com" value={button.url} onChange={e => updateButton(i, { ...button, url: e.target.value })} />}
              {button.type === 'PHONE_NUMBER' && <Input aria-label={`Button ${i + 1} phone`} required placeholder="+919000000000" value={button.phone_number} onChange={e => updateButton(i, { ...button, phone_number: e.target.value })} />}
            </div>)}
          </div>
          <Button type="submit" disabled={sameSubmission}>Review before submission</Button>
          {sameSubmission && <p className="text-sm text-muted-foreground">This name and language were already submitted. Refresh the library to check their status, or use a new name for a new template.</p>}
        </fieldset>
      </form></div>
      <aside className="space-y-4 lg:sticky lg:top-6"><div className="flex gap-2"><Badge>{(reviewed || draft).category}</Badge><Badge variant="outline">{(reviewed || draft).language}</Badge></div>
        <h2 className="font-semibold">{reviewed ? 'Review the exact message to submit' : 'Message preview'}</h2><Preview draft={reviewed || draft} />
        <p className="text-xs text-muted-foreground">Placeholders are replaced with each recipient's values when sending a campaign. Fictional sample values are only for preview and template review.</p>
        {reviewed && <div className="border rounded-xl p-5 space-y-3"><p>Submit <strong>{reviewed.name}</strong> to Meta for WhatsApp account <strong>{sender?.cloud_waba_id}</strong> using {sender?.phone_number || sender?.session_name}.</p>
          <p className="text-sm text-muted-foreground">Submission requests a review. It does not send a campaign or guarantee approval.</p>
          <div className="flex gap-2"><Button disabled={!!busy} onClick={() => void submit()}>{busy === 'submit' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Submit to Meta</Button><Button variant="outline" disabled={!!busy} onClick={() => setReviewed(null)}>Keep editing</Button></div></div>}
      </aside>
    </section>}
  </div></main>;
}
