/**
 * DO Serverless Function: hims-cancel-appointment
 * Proxies to HIMS Supabase Edge Function to cancel an appointment
 */

const HIMS_SUPABASE_URL = process.env.HIMS_SUPABASE_URL;
const HIMS_BOT_SECRET = process.env.HIMS_BOT_SECRET;

async function main(args) {
  const { orgId, appointmentId } = args;

  if (!orgId || !appointmentId) {
    return { body: { success: false, error: 'orgId and appointmentId are required' } };
  }

  if (!HIMS_SUPABASE_URL || !HIMS_BOT_SECRET) {
    return { body: { success: false, error: 'HIMS Supabase not configured' } };
  }

  try {
    const resp = await fetch(`${HIMS_SUPABASE_URL}/functions/v1/hims-cancel-appointment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hims-bot-secret': HIMS_BOT_SECRET,
      },
      body: JSON.stringify({
        clinicId: orgId,
        appointmentId,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { body: { success: false, error: data.error || `Edge function error: ${resp.status}` } };
    }
    return { body: { success: true, ...data } };
  } catch (err) {
    return { body: { success: false, error: err.message } };
  }
}

exports.main = main;
