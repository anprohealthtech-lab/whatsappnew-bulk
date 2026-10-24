import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestHIMSBotConfiguration, resolveHIMSBotSettings, type HIMSBotConfiguration } from './HIMSOpdSettingsService';

const clinicA = '11111111-1111-4111-8111-111111111111';
const clinicB = '22222222-2222-4222-8222-222222222222';
const draft = { greetingMessage: 'Welcome to Clinic A', systemPrompt: 'Check live slots', contactNumber: '123', allowedLanguages: ['English'] };
const config = (id: string): HIMSBotConfiguration => ({ context: { clinic: { id, name: id, phone: '', address: '', timezone: 'Asia/Kolkata', workingHours: null }, doctors: [], specialties: [] }, settings: null, draft, updatedAt: null, fetchedAt: new Date().toISOString() });

test('HIMS settings are cached by clinic, reject mismatched responses and preserve saved configuration', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { url: process.env.HIMS_SUPABASE_URL, secret: process.env.HIMS_BOT_SECRET, key: process.env.HIMS_SUPABASE_ANON_KEY };
  process.env.HIMS_SUPABASE_URL = 'https://test.supabase.co';
  process.env.HIMS_BOT_SECRET = 'test-only-secret';
  process.env.HIMS_SUPABASE_ANON_KEY = 'eyJtest';
  let calls = 0;
  let wrongClinic = false;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://test.supabase.co/functions/v1/hims-opd-bot');
    const body = JSON.parse(String(options?.body));
    assert.equal(new Headers(options?.headers).get('x-hims-bot-secret'), 'test-only-secret');
    const result = config(wrongClinic ? clinicB : body.clinicId);
    if (body.action === 'save') result.settings = body.settings;
    return Response.json(result);
  };
  try {
    await requestHIMSBotConfiguration(clinicA, 'get', undefined, true);
    await requestHIMSBotConfiguration(clinicA);
    assert.equal(calls, 1);
    await requestHIMSBotConfiguration(clinicB);
    assert.equal(calls, 2);
    wrongClinic = true;
    await assert.rejects(requestHIMSBotConfiguration(clinicA, 'tune'), /invalid clinic/);
    wrongClinic = false;
    const saved = { ...draft, greetingMessage: 'Updated greeting from HIMS' };
    await requestHIMSBotConfiguration(clinicA, 'save', saved);
    assert.equal((await requestHIMSBotConfiguration(clinicA)).settings?.greetingMessage, saved.greetingMessage);
    assert.equal(resolveHIMSBotSettings({ himsGreetingMessage: 'Old local greeting' }, { ...config(clinicA), settings: saved }).greetingMessage, saved.greetingMessage);
    assert.equal(resolveHIMSBotSettings({ himsGreetingMessage: 'Existing custom greeting' }, config(clinicA)).greetingMessage, 'Existing custom greeting');
    assert.equal(resolveHIMSBotSettings({}, config(clinicA)).greetingMessage, draft.greetingMessage);
    process.env.HIMS_SUPABASE_URL = 'https://clinic.example.com\nOTHER_KEY=value';
    await assert.rejects(requestHIMSBotConfiguration(clinicA, 'tune'));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({ HIMS_SUPABASE_URL: originalEnv.url, HIMS_BOT_SECRET: originalEnv.secret, HIMS_SUPABASE_ANON_KEY: originalEnv.key })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
