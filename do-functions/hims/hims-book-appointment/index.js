/**
 * DO Serverless Function: hims-book-appointment
 * Proxies to HIMS Supabase Edge Function to book an appointment
 */

const HIMS_SUPABASE_URL = process.env.HIMS_SUPABASE_URL;
const HIMS_BOT_SECRET = process.env.HIMS_BOT_SECRET;

async function main(args) {
  const { orgId, doctorId, date, timeSlot, patientName, patientPhone, reason } = args;

  if (!orgId || !doctorId || !date || !timeSlot || !patientName || !patientPhone) {
    return { body: { success: false, error: 'orgId, doctorId, date, timeSlot, patientName, and patientPhone are required' } };
  }

  if (!HIMS_SUPABASE_URL || !HIMS_BOT_SECRET) {
    return { body: { success: false, error: 'HIMS Supabase not configured' } };
  }

  try {
    const resp = await fetch(`${HIMS_SUPABASE_URL}/functions/v1/hims-book-appointment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hims-bot-secret': HIMS_BOT_SECRET,
      },
      body: JSON.stringify({
        clinicId: orgId,
        doctorId,
        date,
        timeSlot,
        patientName,
        patientPhone,
        reason: reason || undefined,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { body: { success: false, error: data.error || data.message || `Edge function error: ${resp.status}`, statusCode: resp.status } };
    }
    return { body: { success: true, ...data } };
  } catch (err) {
    return { body: { success: false, error: err.message } };
  }
}

exports.main = main;
