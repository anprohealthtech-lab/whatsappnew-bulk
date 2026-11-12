import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeSignupRegistration } from './signupRegistration';

const connected = { platform_type: 'CLOUD_API', status: 'CONNECTED' };

test('Business app completion verifies Meta status without registering the phone again', async () => {
  const requests: string[] = [];
  const steps: Record<string, string> = {};
  const result = await completeSignupRegistration({
    phone: {}, signupEvent: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', steps,
    register: async () => { requests.push('register'); },
    readPhone: async () => { requests.push('read'); return connected; },
  });
  assert.deepEqual(requests, ['read']);
  assert.equal(result.status, 'CONNECTED');
  assert.match(steps.register, /skipped/);
});

test('a client completion event cannot bypass Meta registration verification', async () => {
  await assert.rejects(completeSignupRegistration({
    phone: {}, signupEvent: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', steps: {},
    register: async () => { assert.fail('must not register a Business app phone'); },
    readPhone: async () => ({ platform_type: 'ON_PREMISE', status: 'DISCONNECTED' }),
  }), /Meta has not completed Cloud API registration/);
});

test('standard signup registers an unconnected phone before verifying it', async () => {
  const requests: string[] = [];
  const steps: Record<string, string> = {};
  await completeSignupRegistration({
    phone: { status: 'PENDING' }, signupEvent: 'FINISH', steps,
    register: async () => { requests.push('register'); },
    readPhone: async () => { requests.push('read'); return connected; },
  });
  assert.deepEqual(requests, ['register', 'read']);
  assert.equal(steps.register, 'ok');
});

test('relinking a connected Cloud API phone skips registration but checks its current state', async () => {
  let reads = 0;
  await completeSignupRegistration({
    phone: connected, signupEvent: 'FINISH', steps: {},
    register: async () => { assert.fail('must not re-register'); },
    readPhone: async () => { reads++; return connected; },
  });
  assert.equal(reads, 1);
});

test('registration failures do not continue onboarding', async () => {
  await assert.rejects(completeSignupRegistration({
    phone: {}, steps: {},
    register: async () => { throw new Error('Permission denied'); },
    readPhone: async () => { assert.fail('must stop after a registration failure'); },
  }), /Permission denied/);
});
