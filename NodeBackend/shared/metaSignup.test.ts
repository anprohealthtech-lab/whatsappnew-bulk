import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metaSignupDiagnostic, parseMetaSignupMessage, selectSignupPhone } from './metaSignup';

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

test('diagnostic shows nested field layout and decimal IDs without copying credentials or personal data', () => {
  const report = metaSignupDiagnostic({
    type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', version: 3,
    access_token: 'top-secret',
    data: {
      result: { messaging_account_ids: ['123', '456'], phone_number_id: '789' },
      code: '123456', access_token: 'token-secret', error_message: 'private details',
      phone_number: '+919876543210', waba_id: 'invalid-secret',
    },
  });
  assert.equal(report.event, 'FINISH');
  assert.equal(report.version, '3');
  assert.equal(report.fields['data.result.messaging_account_ids[0]'], 'string');
  assert.deepEqual(report.ids, {
    'data.result.messaging_account_ids[0]': '123',
    'data.result.messaging_account_ids[1]': '456',
    'data.result.phone_number_id': '789',
  });
  const serialized = JSON.stringify(report);
  for (const secret of ['top-secret', '123456', 'token-secret', 'private details', '+919876543210', 'invalid-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('diagnostic handles missing, untrusted and circular values with bounded output', () => {
  assert.equal(metaSignupDiagnostic(null).event, 'OTHER');
  const data: any = { code: 'secret' };
  data.self = data;
  const report = metaSignupDiagnostic({ event: 'secret', version: 'secret', data });
  assert.equal(report.event, 'OTHER');
  assert.equal(report.version, 'unknown');
  assert.ok(Object.keys(report.fields).length <= 50);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});
