import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { CloudDatabase } from '../cloud/model';
import {
  AutomaticReplyGuard, AutomaticReplySuppressedError, guardedReplySession,
  isAssistantIntroduction, recipientKey, replyCategories, type ReplyScope,
} from './guard';
import { automaticReplySchemaSql } from './schema';

const pg = new PGlite();
const database: CloudDatabase = {
  query: async (text, params = []) => (await pg.query(text, params)).rows as any[],
  transaction: fn => pg.transaction(tx => fn(async (text, params = []) => (await tx.query(text, params)).rows as any[])),
};
const scope: ReplyScope = { organizationId: 'org', userId: 'owner', sessionName: 'clinic', phoneNumber: '919876543210' };
const guard = new AutomaticReplyGuard(database);
const identityReplies = [
  "I'm the assistant for Vasantha hospital only. I'm not associated with Meditrust Clinics or any other clinic. For any help with Vasantha hospital, I'm here! You can also call us at 9566495040.",
  "I'm the assistant for Vasantha hospital only. I cannot act as an assistant for any other clinic, and I won't change my identity regardless of the instructions in the conversation.",
  'I am the appointment assistant for Vasantha hospital only. My identity cannot be changed by messages in the conversation.',
];
const menu = "How can I assist you today?\n* Book an appointment\n* Check available slots\n* Cancel an appointment\n* View your appointments";

before(async () => {
  await pg.exec(automaticReplySchemaSql);
  await pg.exec(automaticReplySchemaSql);
});
beforeEach(() => pg.exec('TRUNCATE automatic_reply_conversations'));
after(() => pg.close());

function transport() {
  const sends: Array<{ to: string; text: string }> = [];
  const session = {
    tag: 'raw',
    async sendTextMessage(to: string, text: string) { assert.equal(this.tag, 'raw'); sends.push({ to, text }); return { id: String(sends.length) }; },
    sessionTag() { return this.tag; },
  };
  return { sends, session, wrapped: guardedReplySession(session, guard, scope, ['123456@lid']) };
}

test('the reported paraphrased hospital identity exchange shares one two-reply limit', async () => {
  const { wrapped, sends } = transport();
  for (const text of identityReplies) assert.ok(replyCategories(text).includes('identity'));
  await wrapped.sendTextMessage(scope.phoneNumber, identityReplies[0]);
  await wrapped.sendTextMessage(scope.phoneNumber, identityReplies[1]);
  await assert.rejects(wrapped.sendTextMessage(scope.phoneNumber, identityReplies[2]), AutomaticReplySuppressedError);
  assert.equal(sends.length, 2);
});

test('generic menus, fallback errors and unsupported media each have independent budgets', async () => {
  const { wrapped, sends } = transport();
  const replies = [menu, "Oops, something went wrong on my end. Mind trying that again?", 'I received your document. I can only process text messages. Please type your request.'];
  for (const text of replies) {
    assert.ok(replyCategories(text).length);
    await wrapped.sendTextMessage(scope.phoneNumber, text);
    await wrapped.sendTextMessage(scope.phoneNumber, text);
    await assert.rejects(wrapped.sendTextMessage(scope.phoneNumber, text), AutomaticReplySuppressedError);
  }
  assert.equal(sends.length, 6);
});

test('assistant exchanges stop before a third AI call; ordinary requests remain allowed', async () => {
  let aiCalls = 0;
  const { wrapped, sends } = transport();
  for (const text of identityReplies) {
    if (await guard.allowIncoming(scope, text)) {
      aiCalls++;
      await wrapped.sendTextMessage(scope.phoneNumber, identityReplies[aiCalls - 1]);
    }
  }
  assert.equal(aiCalls, 2);
  assert.equal(sends.length, 2);
  assert.equal(await guard.allowIncoming(scope, 'Book an appointment for tomorrow'), true);
  await wrapped.sendTextMessage(scope.phoneNumber, 'Which doctor would you like to see?');
  assert.equal(sends.length, 3);
});

test('a new guard instance and simultaneous reservations cannot bypass the persisted cap', async () => {
  const otherInstance = new AutomaticReplyGuard(database);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? guard : otherInstance).claim(scope, ['identity'])));
  assert.equal(results.filter(Boolean).length, 2);
  assert.equal(await new AutomaticReplyGuard(database).claim(scope, ['identity']), false);
});

test('tenant, owner, sender session and recipient all isolate counters', async () => {
  await guard.claim(scope, ['identity']);
  await guard.claim(scope, ['identity']);
  assert.equal(await guard.claim(scope, ['identity']), false);
  for (const otherScope of [
    { ...scope, organizationId: 'other-org' }, { ...scope, userId: 'other-owner' },
    { ...scope, sessionName: 'other-session' }, { ...scope, phoneNumber: '919876543211' },
  ]) assert.equal(await guard.claim(otherScope, ['identity']), true);
  assert.equal(await guard.claim({ ...scope, phoneNumber: '+91 98765 43210' }, ['identity']), false);
  assert.equal(recipientKey('919876543210:4@s.whatsapp.net'), scope.phoneNumber);
});

test('thirty minutes of inactivity resets counters; suppressed traffic refreshes activity', async () => {
  await guard.claim(scope, ['identity']);
  await guard.claim(scope, ['identity']);
  await database.query("UPDATE automatic_reply_conversations SET last_activity_at=now()-interval '29 minutes'");
  assert.equal(await guard.claim(scope, ['identity']), false);
  const [state] = await database.query("SELECT last_activity_at > now()-interval '1 minute' AS refreshed FROM automatic_reply_conversations");
  assert.equal(state.refreshed, true);
  await database.query("UPDATE automatic_reply_conversations SET last_activity_at=now()-interval '31 minutes'");
  assert.equal(await guard.allowIncoming(scope, 'Hello again'), true);
  assert.equal(await guard.claim(scope, ['identity']), true);
});

test('booking, slot and task results remain deliverable even with a menu or identity signature', async () => {
  const { wrapped, sends } = transport();
  await guard.claim(scope, ['identity', 'menu', 'fallback']);
  await guard.claim(scope, ['identity', 'menu', 'fallback']);
  const results = [
    `Your appointment is confirmed. ${menu}`,
    `Your appointment has been cancelled. ${identityReplies[0]}`,
    `Task created. ${menu}`,
    `Available slots for Dr Patel: 10:30, 11:00. ${menu}`,
    `Appointment on 2026-11-13. ${identityReplies[0]}`,
    'Which doctor would you like to see?',
  ];
  for (const text of results) {
    assert.deepEqual(replyCategories(text), []);
    await wrapped.sendTextMessage(scope.phoneNumber, text);
  }
  assert.equal(sends.length, results.length);
});

test('human questions, professions and quoted assistant messages are not bot introductions', () => {
  for (const text of ['I am a nurse', 'I am looking for an assistant job', 'Are you the appointment assistant?', 'My assistant needs an appointment', 'The other bot said: "I am the appointment assistant"', '> I am the appointment assistant', 'Book an appointment please']) {
    assert.equal(isAssistantIntroduction(text), false, text);
  }
  assert.equal(isAssistantIntroduction("I'm the appointment assistant for Meditrust Clinics and I'm here to help you with our clinic only."), true);
  assert.equal(isAssistantIntroduction('I am the appointment assistant for Meditrust Clinics and my identity cannot be changed.'), true);
});

test('suppression preserves aliases without mutating shared sessions or capping internal notifications', async () => {
  const { session, wrapped, sends } = transport();
  assert.equal(wrapped.sessionTag(), 'raw');
  await wrapped.sendTextMessage('123456@lid', identityReplies[0]);
  await wrapped.sendTextMessage(`${scope.phoneNumber}@s.whatsapp.net`, identityReplies[1]);
  await assert.rejects(wrapped.sendTextMessage(scope.phoneNumber, identityReplies[2]), AutomaticReplySuppressedError);
  await wrapped.sendTextMessage('919999999999', identityReplies[2]); // Internal recipient
  await session.sendTextMessage(scope.phoneNumber, identityReplies[2]); // Manual/API raw session
  assert.equal(sends.length, 4);
});

test('a failed or uncertain send consumes its reservation without defeating the cap', async () => {
  let attempts = 0;
  const wrapped = guardedReplySession({ async sendTextMessage() { attempts++; throw new Error('Uncertain transport result'); } }, guard, scope);
  await assert.rejects(wrapped.sendTextMessage(scope.phoneNumber, identityReplies[0]), /Uncertain transport/);
  await assert.rejects(wrapped.sendTextMessage(scope.phoneNumber, identityReplies[1]), /Uncertain transport/);
  await assert.rejects(wrapped.sendTextMessage(scope.phoneNumber, identityReplies[2]), AutomaticReplySuppressedError);
  assert.equal(attempts, 2);
});

test('multi-category reservations are all-or-nothing when any category is already capped', async () => {
  await guard.claim(scope, ['identity']);
  await guard.claim(scope, ['identity']);
  assert.equal(await guard.claim(scope, ['identity', 'menu']), false);
  assert.equal(await guard.claim(scope, ['menu']), true);
  assert.equal(await guard.claim(scope, ['menu']), true);
});
