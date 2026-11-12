import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { automaticReplySchemaSql } from './schema';

const pg = new PGlite();
let api: any;
const scope = { organizationId: 'org', userId: 'owner', sessionName: 'clinic', phoneNumber: '919876543210' };
const identity = "I'm the assistant for Vasantha hospital only. I'm here to help you with our clinic only.";

before(async () => {
  await pg.exec(automaticReplySchemaSql);
  // Exercise the real service handlers with DB/provider/notification adapters
  // replaced. Their normal imports start live DB timers; no live services or
  // credentials are needed by this regression suite.
  const mocks: Record<string, string> = {
    db: 'export const db={select:()=>({from:()=>({where:()=>({limit:async()=>[]})})})};',
    storage: 'export const storage={};',
    UserNotificationService: 'export const sendNotificationForEvent=async()=>{};',
    LeadDripService: 'export const leadDripService={};',
    suiteRuntimeAccess: 'export const requireWorkforceAccess=async()=>{}; export const workforceToolScope=()=>({});',
    HIMSOpdSettingsService: 'export const requestHIMSBotConfiguration=async()=>({context:{}}); export const resolveHIMSBotSettings=()=>({allowedLanguages:["English"]});',
  };
  const bundle = await build({
    stdin: {
      contents: `export * from './guard';
        export {AutoResponseService} from '../services/AutoResponseService';
        export {HIMSChatbotService} from '../services/HIMSChatbotService';
        export {HRChatbotService} from '../services/HRChatbotService';
        export {ChatbotService} from '../services/ChatbotService';`,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts',
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'isolated-service-adapters', setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)(?:db|storage|UserNotificationService|LeadDripService|suiteRuntimeAccess|HIMSOpdSettingsService)$/ }, args => ({ path: args.path.split('/').pop()!, namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  api = module.exports;
});
beforeEach(() => pg.exec('TRUNCATE automatic_reply_conversations'));
after(() => pg.close());

function fixture() {
  const guard = new api.AutomaticReplyGuard({
    query: async (text: string, params: any[] = []) => (await pg.query(text, params)).rows,
    transaction: (fn: any) => pg.transaction(tx => fn(async (text: string, params: any[] = []) => (await tx.query(text, params)).rows)),
  });
  const sent: string[] = [], saved: any[] = [], errors: any[] = [];
  const session = api.guardedReplySession({ async sendTextMessage(_to: string, text: string) { sent.push(text); } }, guard, scope);
  const storage: any = {
    async createMessage(message: any) { saved.push(message); },
    async createSystemLog(error: any) { errors.push(error); },
  };
  return { guard, session, storage, sent, saved, errors };
}

test('appointment suppression sends no fallback and saves/caches only the two delivered replies', async () => {
  const f = fixture();
  f.storage.getHIMSPatient = async () => ({ phoneNumber: scope.phoneNumber, organizationId: 'clinic', chatbotActive: 'true' });
  const service = new api.HIMSChatbotService(f.storage, f.session);
  service.processWithClaude = async () => identity;
  for (let i = 0; i < 2; i++) await service.processHIMSMessage(scope.phoneNumber, 'Who are you?', undefined, undefined, scope.userId, scope.organizationId);
  // The route catches this signal before broadcasting a response-sent event.
  await assert.rejects(service.processHIMSMessage(scope.phoneNumber, 'Who are you?', undefined, undefined, scope.userId, scope.organizationId), api.AutomaticReplySuppressedError);
  assert.equal(f.sent.length, 2);
  assert.equal(f.saved.length, 2);
  assert.equal(service.getConversationFromCache(scope.phoneNumber).filter((m: any) => m.role === 'assistant').length, 2);
  assert.equal(f.errors.length, 0);
});

test('HR suppression sends no fallback and does not record a failed or phantom reply', async () => {
  const f = fixture();
  f.storage.getHRAdmin = async () => ({ phoneNumber: scope.phoneNumber, organizationId: 'org', userId: 'hr', chatbotActive: 'true' });
  f.storage.updateHRAdmin = async () => {};
  const service = new api.HRChatbotService(f.storage, f.session);
  service.processWithClaude = async () => identity;
  for (let i = 0; i < 2; i++) await service.processHRMessage(scope.phoneNumber, 'Who are you?');
  await assert.rejects(service.processHRMessage(scope.phoneNumber, 'Who are you?'), api.AutomaticReplySuppressedError);
  assert.equal(f.sent.length, 2);
  assert.equal(f.saved.length, 2);
  assert.equal(f.errors.length, 0);
  assert.equal(service.getConversationFromCache(scope.phoneNumber).filter((m: any) => m.role === 'assistant').length, 2);
});

test('lead suppression cannot queue a follow-up after a reply was withheld', async () => {
  const f = fixture();
  f.storage.updateContactByTenant = async () => {};
  const service = new api.ChatbotService(f.storage, f.session, scope);
  service.cancelPendingFollowups = async () => {};
  service.resolvePipelineAgentId = async () => null;
  service.getEffectiveChatbotConfig = async () => ({ isActive: 'true', replyCooldownSeconds: 0, typingDelayMs: 0 });
  service.getUserRagConfig = async () => ({ ragBaseUrl: 'https://fixture.invalid' });
  service.getConversationState = async () => ({ userIntent: 'unknown', messageCount: 0, demoAskedCount: 0 });
  service.updateConversationState = async () => {};
  service.getConversationHistory = async () => [];
  service.isFollowupsEnabled = async () => true;
  service.callRagEndpoint = async () => identity + '\n<<FOLLOWUP:2d:Can we help you?>>';
  let queued = 0;
  service.scheduleFollowup = async () => { queued++; };
  for (let i = 0; i < 2; i++) await service.processLeadMessage(scope.phoneNumber, 'Who are you?');
  await assert.rejects(service.processLeadMessage(scope.phoneNumber, 'Who are you?'), api.AutomaticReplySuppressedError);
  assert.equal(f.sent.length, 2);
  assert.equal(f.saved.length, 2);
  assert.equal(queued, 2);
  assert.equal(f.errors.length, 0);
});

test('keyword replies enforce their rule cap, remain handled and use the receiving tenant', async () => {
  const f = fixture();
  const lookups: any[] = [];
  f.storage.getAutoResponsesByTenant = async (tenant: any) => {
    lookups.push(tenant);
    return [{ id: 'hours', keyword: 'hours', response: 'Office hours: nine to five.' }, { id: 'address', keyword: 'address', response: 'We are on Main Street.' }];
  };
  const service = new api.AutoResponseService(f.storage, scope, f.session, { guard: f.guard, scope });
  for (let i = 0; i < 3; i++) assert.equal(await service.handleIncomingMessage(scope.phoneNumber, 'What are your hours?'), true);
  assert.equal(f.sent.length, 2);
  assert.equal(f.saved.length, 2);
  assert.equal(await service.handleIncomingMessage(scope.phoneNumber, 'address'), true);
  assert.equal(f.sent.length, 3);
  assert.equal(f.saved[0].organizationId, scope.organizationId);
  assert.equal(f.saved[0].userId, scope.userId);
  assert.equal(lookups.every(tenant => tenant.userId === scope.userId), true);
  assert.equal(await service.handleIncomingMessage(scope.phoneNumber, 'unmatched'), false);
});

test('capped appointment and HR error fallbacks also reach the route suppression handler', async () => {
  const f = fixture();
  f.storage.getHIMSPatient = async () => ({ phoneNumber: scope.phoneNumber, organizationId: 'clinic', chatbotActive: 'true' });
  f.storage.getHRAdmin = async () => ({ phoneNumber: scope.phoneNumber, organizationId: 'org', userId: 'hr', chatbotActive: 'true' });
  const hims = new api.HIMSChatbotService(f.storage, f.session);
  const hr = new api.HRChatbotService(f.storage, f.session);
  hims.processWithClaude = hr.processWithClaude = async () => { throw new Error('Provider unavailable'); };
  await hims.processHIMSMessage(scope.phoneNumber, 'Hello');
  await hr.processHRMessage(scope.phoneNumber, 'Hello');
  assert.equal(f.sent.length, 2);
  await assert.rejects(hims.processHIMSMessage(scope.phoneNumber, 'Hello'), api.AutomaticReplySuppressedError);
  await assert.rejects(hr.processHRMessage(scope.phoneNumber, 'Hello'), api.AutomaticReplySuppressedError);
  assert.equal(f.sent.length, 2);
});
