import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMetaSignupMessage, selectSignupPhone } from './metaSignup';

test('accepts JSON and object completion messages from Meta', () => {
  const payload = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '123' } };
  assert.deepEqual(parseMetaSignupMessage('https://www.facebook.com', JSON.stringify(payload)), payload);
  assert.deepEqual(parseMetaSignupMessage('https://facebook.com', payload), payload);
});
test('ignores unrelated, malformed and spoofed messages without throwing', () => {
  for (const origin of ['null', '', 'https://evilfacebook.com', 'https://facebook.com.evil.test', 'http://facebook.com']) {
    assert.equal(parseMetaSignupMessage(origin, { type: 'WA_EMBEDDED_SIGNUP' }), null);
  }
  assert.equal(parseMetaSignupMessage('https://facebook.com', '{'), null);
  assert.equal(parseMetaSignupMessage('https://facebook.com', { type: 'OTHER' }), null);
});
test('resolves missing phone ID only for exactly one phone', () => {
  assert.equal(selectSignupPhone({ data: [{ id: '456' }] }), '456');
  for (const data of [[], [{ id: '456' }, { id: '789' }]]) {
    assert.throws(() => selectSignupPhone({ data }));
  }
  assert.throws(() => selectSignupPhone({ data: [{ id: '456' }], paging: { next: 'more' } }));
});
test('requires explicit phone to belong to selected account', () => {
  assert.equal(selectSignupPhone({ data: [{ id: '456' }, { id: '789' }] }, '789'), '789');
  assert.throws(() => selectSignupPhone({ data: [{ id: '456' }] }, '999'));
});
