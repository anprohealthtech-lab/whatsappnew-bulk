import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metaTemplatePayload, recruitmentAcknowledgmentBrief, templateContent } from '@shared/cloudTemplate';
import { CloudTemplateWorkflow, type TemplateAccount } from './templateWorkflow';
import { generateTemplateDraft, readAssistantDraft, TEMPLATE_ASSISTANT_MODEL } from './templateAssistant';

const owner = { organizationId: 'clinic', userId: 'owner' };
const another = { organizationId: 'clinic', userId: 'another-user' };
const content = () => ({ name: 'appointment_confirmation', category: 'UTILITY' as const, language: 'en_US',
  headerText: 'Appointment confirmed', bodyText: 'Hi {{1}}, your appointment is on {{2}}. Please contact us to reschedule.',
  bodyExamples: ['Example Customer', '20 November, 10 AM'], footerText: 'Clinic appointments',
  buttons: [{ type: 'QUICK_REPLY' as const, text: 'Reschedule' }] });
const assistantInput = { sessionId: 'sender', category: 'UTILITY', language: 'en_US', brief: 'Confirm an existing appointment without promotions.' };

test('builds a Meta template with ordered examples and no send or account credentials', () => {
  const payload = metaTemplatePayload(content());
  assert.deepEqual(payload, { name: 'appointment_confirmation', category: 'UTILITY', language: 'en_US', components: [
    { type: 'HEADER', format: 'TEXT', text: 'Appointment confirmed' },
    { type: 'BODY', text: content().bodyText, example: { body_text: [['Example Customer', '20 November, 10 AM']] } },
    { type: 'FOOTER', text: 'Clinic appointments' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Reschedule' }] },
  ] });
  const plain = metaTemplatePayload({ ...content(), bodyText: 'Your requested account update is ready.', bodyExamples: [], headerText: '', footerText: '', buttons: [] });
  assert.deepEqual(plain.components, [{ type: 'BODY', text: 'Your requested account update is ready.' }]);
});

test('blocks invalid placeholders, missing samples, unsupported categories and unsafe component fields', () => {
  for (const patch of [
    { name: 'Bad Name' }, { category: 'AUTHENTICATION' }, { bodyText: 'Hi {{2}}, check your appointment.' },
    { bodyText: 'Hi {{name}}, check your appointment.' }, { bodyText: 'Hi {{01}}, check your appointment.' },
    { bodyExamples: ['Only one sample'] }, { bodyText: '{{1}} appointment {{2}}' },
    { headerText: 'Hi {{1}}' }, { accessToken: 'secret' }, { wabaId: 'someone-else' },
    { buttons: [{ type: 'URL', text: 'View', url: 'javascript:alert(1)' }] },
    { buttons: [{ type: 'URL', text: 'View', url: 'https://example.com/{{1}}' }] },
  ]) assert.throws(() => templateContent.parse({ ...content(), ...patch }));
});

test('AI category recommendations stay visible and cannot carry arbitrary tools or language fields', () => {
  const { language: _, ...draft } = content();
  const result = readAssistantDraft({ ...draft, category: 'MARKETING', notes: ['The offer in this brief is promotional.'] }, 'hi');
  assert.equal(result.template.category, 'MARKETING');
  assert.equal(result.template.language, 'hi');
  assert.match(result.notes[0], /promotional/);
  assert.throws(() => readAssistantDraft({ ...draft, notes: [], access_token: 'secret' }, 'en_US'));
});

test('recruitment AI samples stay separate from message text and reject the reported nested greetings', () => {
  const { language: _, ...draft } = content();
  const bodyText = "Hi {{1}}! Thanks for applying for {{2}}.\nWe've received your profile and CV.\nOur HR team will review them and contact you about next steps.";
  const result = readAssistantDraft({ ...draft, headerText: '', footerText: '', buttons: [], bodyText, bodyExamples: ['Asha', 'Accountant'], notes: [] }, 'en_US');
  assert.equal(result.template.bodyText, bodyText);
  assert.deepEqual(result.template.bodyExamples, ['Asha', 'Accountant']);
  const payload = metaTemplatePayload(result.template);
  assert.equal(payload.components[0].text, bodyText);
  assert.deepEqual(payload.components[0].example, { body_text: [['Asha', 'Accountant']] });
  const badBody = "Hi {{1}}, welcome aboard! We're excited to have you join us as {{2}}. This message confirms we've received your recruitment profile and documents.";
  assert.throws(() => readAssistantDraft({ ...draft, bodyText: badBody, bodyExamples: [
    "Sarah, welcome aboard! We're excited to have you join us as Senior Software Engineer.",
    "Marcus, welcome aboard! We're excited to have you join us as Marketing Specialist.",
  ], notes: [] }, 'en_US'), /only one field value/);
  for (const sample of ['Hi {{1}}', 'Asha\nAccountant']) {
    assert.throws(() => readAssistantDraft({ ...draft, bodyText, bodyExamples: [sample, 'Accountant'], notes: [] }, 'en_US'), /only one field value/);
  }
});

test('Haiku helper requests a structured draft with the existing SDK and never submits to Meta', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const requests: { url: string; body: any }[] = [];
  const { language: _, ...draft } = content();
  process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key';
  globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    requests.push({ url: request.url, body: JSON.parse(await request.text()) });
    return new Response(JSON.stringify({ id: 'fixture-message', type: 'message', role: 'assistant', model: TEMPLATE_ASSISTANT_MODEL,
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'fixture-tool', name: 'draft_template', input: { ...draft, notes: ['Check the appointment details before submitting.'] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await generateTemplateDraft(assistantInput as any);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).hostname, 'api.anthropic.com');
    assert.equal(requests[0].body.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(requests[0].body.tool_choice, { type: 'tool', name: 'draft_template' });
    assert.match(requests[0].body.system, /3 short lines and under 45 words/);
    assert.match(requests[0].body.system, /Keep variable placeholders in bodyText/);
    assert.match(requests[0].body.system, /Receipt of a profile\/CV is not a hiring decision/);
    assert.match(requests[0].body.system, /never a greeting, sentence, whole message/);
    assert.match(recruitmentAcknowledgmentBrief, /Use \{\{1\}\} for the candidate name and \{\{2\}\} for the job role/);
    assert.equal(result.template.name, 'appointment_confirmation');
    assert.equal(result.template.language, 'en_US');
    assert.equal(JSON.stringify(result).includes('fixture-anthropic-key'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

test('ownership is checked before listing, drafting, submitting or opening billing, including same-org users', async () => {
  let externalCalls = 0;
  const account: TemplateAccount = { wabaId: 'owned-waba', phoneNumberId: 'owned-phone',
    listCampaignTemplates: async () => { externalCalls++; return []; },
    createMessageTemplate: async () => { externalCalls++; return { id: 'meta-template' }; } };
  const workflow = new CloudTemplateWorkflow(async (tenant, id) => {
    if (tenant.userId !== owner.userId || tenant.organizationId !== owner.organizationId || id !== 'sender') throw new Error('Official WhatsApp sender not found');
    return account;
  }, async () => { externalCalls++; return { template: templateContent.parse(content()), notes: [], model: 'haiku-fixture' }; });
  for (const tenant of [another, { ...owner, organizationId: 'other-org' }]) {
    await assert.rejects(workflow.list(tenant, 'sender'), /not found/);
    await assert.rejects(workflow.draft(tenant, assistantInput), /not found/);
    await assert.rejects(workflow.submit(tenant, { sessionId: 'sender', template: content() }), /not found/);
    await assert.rejects(workflow.billing(tenant, 'sender'), /not found/);
  }
  assert.equal(externalCalls, 0);
  const billing = await workflow.billing(owner, 'sender');
  assert.equal(billing.wabaId, 'owned-waba');
  assert.equal(billing.balance, null); // Never invent a zero balance.
  assert.equal(externalCalls, 0);
});

test('AI drafts do not submit, and submission keeps the real Meta status and category', async () => {
  const sent: unknown[] = [];
  const workflow = new CloudTemplateWorkflow(async () => ({ wabaId: 'owned', phoneNumberId: 'phone',
    listCampaignTemplates: async () => [{ ...content(), status: 'PENDING' }, { ...content(), status: 'REJECTED' }],
    createMessageTemplate: async payload => { sent.push(payload); return { id: 'template-id', status: 'PENDING', category: 'MARKETING' }; },
  }), async () => ({ template: templateContent.parse(content()), notes: [], model: 'haiku-fixture' }));
  await workflow.draft(owner, assistantInput);
  assert.equal(sent.length, 0);
  assert.equal((await workflow.list(owner, 'sender')).templates.length, 2);
  const result = await workflow.submit(owner, { sessionId: 'sender', template: content() });
  assert.equal(sent.length, 1);
  assert.equal(result.status, 'PENDING');
  assert.equal(result.category, 'MARKETING');
  assert.deepEqual(sent[0], metaTemplatePayload(content()));
  await assert.rejects(workflow.submit(owner, { sessionId: 'sender', template: content(), wabaId: 'another-account' }));
});

test('concurrent duplicate submissions make only one Meta request', async () => {
  let complete!: (value: any) => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const workflow = new CloudTemplateWorkflow(async () => ({ wabaId: 'owned', phoneNumberId: 'phone', listCampaignTemplates: async () => [],
    createMessageTemplate: async () => { calls++; entered(); return new Promise(resolve => { complete = resolve; }); },
  }), async () => ({ template: templateContent.parse(content()), notes: [], model: 'haiku-fixture' }));
  const first = workflow.submit(owner, { sessionId: 'sender', template: content() });
  await waiting;
  await assert.rejects(workflow.submit(owner, { sessionId: 'sender', template: content() }), /already being submitted/);
  complete({ id: 'confirmed-id' });
  assert.equal((await first).status, 'SUBMITTED'); // Do not invent Meta's review status when it returns only an ID.
  assert.equal(calls, 1);
});

test('missing Meta confirmation is reported instead of claiming approval or retrying automatically', async () => {
  let calls = 0;
  const workflow = new CloudTemplateWorkflow(async () => ({ wabaId: 'owned', phoneNumberId: 'phone', listCampaignTemplates: async () => [],
    createMessageTemplate: async () => { calls++; return {}; },
  }), async () => ({ template: templateContent.parse(content()), notes: [], model: 'haiku-fixture' }));
  await assert.rejects(workflow.submit(owner, { sessionId: 'sender', template: content() }), /Refresh the template list/);
  assert.equal(calls, 1);
});

test('AI generation is rate-limited per user rather than across the organization', async () => {
  const workflow = new CloudTemplateWorkflow(async () => ({ wabaId: 'owned', phoneNumberId: 'phone', listCampaignTemplates: async () => [], createMessageTemplate: async () => ({}) }),
    async () => ({ template: templateContent.parse(content()), notes: [], model: 'haiku-fixture' }));
  for (let i = 0; i < 5; i++) await workflow.draft(owner, assistantInput);
  await assert.rejects(workflow.draft(owner, assistantInput), /five drafts per minute/);
  await workflow.draft(another, assistantInput);
});
