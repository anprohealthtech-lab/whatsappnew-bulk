/**
 * DO Serverless Function: hims-get-doctors
 * Proxies to HIMS Supabase Edge Function to get doctors list
 *
 * Deploy: doctl serverless deploy .
 * Test:   node -e "require('./index.js').main({ orgId: 'xxx' })"
 */

const HIMS_SUPABASE_URL = process.env.HIMS_SUPABASE_URL;
const HIMS_BOT_SECRET = process.env.HIMS_BOT_SECRET;

async function main(args) {
  const { orgId, specialization, searchQuery } = args;

  if (!orgId) {
    return { body: { success: false, error: 'orgId is required' } };
  }

  if (!HIMS_SUPABASE_URL || !HIMS_BOT_SECRET) {
    return { body: { success: false, error: 'HIMS Supabase not configured' } };
  }

  try {
    const resp = await fetch(`${HIMS_SUPABASE_URL}/functions/v1/hims-get-doctors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hims-bot-secret': HIMS_BOT_SECRET,
      },
      body: JSON.stringify({
        clinicId: orgId,
        specialization: specialization || undefined,
        searchQuery: searchQuery || undefined,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { body: { success: false, error: data.error || data.message || `Edge function error: ${resp.status}` } };
    }
    return { body: { success: true, ...data } };
  } catch (err) {
    return { body: { success: false, error: err.message } };
  }
}

exports.main = main;
