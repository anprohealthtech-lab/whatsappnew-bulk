/**
 * Lead Pipeline Sync — push Google Sheet rows to your WhatsApp lead pipeline.
 *
 * This runs INSIDE Google (Apps Script), so there is no Google API / OAuth setup
 * on the app side. The script simply POSTs your rows to the pipeline webhook.
 *
 * SETUP
 * ─────
 * 1. Open your Google Sheet → Extensions → Apps Script.
 * 2. Delete anything in the editor and paste this whole file.
 * 3. Fill in WEBHOOK_URL and INGEST_TOKEN below (copy them from the app's
 *    "Lead Pipelines" panel → your pipeline → "Copy Apps Script").
 * 4. Row 1 of the sheet must be headers. A column named "phone" (or "mobile" /
 *    "phoneNumber") is REQUIRED; a "name" column is recommended. Every other
 *    column is sent along as extra data and stored with the lead.
 * 5. Run `syncAllLeads` once (authorise it when prompted) to push every row.
 * 6. To keep it in sync automatically: Triggers (clock icon on the left) →
 *    Add Trigger → function `syncNewLeads`, event source "Time-driven",
 *    e.g. every 5 minutes. New rows get a "Synced" timestamp so they are not
 *    sent twice.
 */

// ─── FILL THESE IN ───────────────────────────────────────────────────────────
const WEBHOOK_URL = 'https://YOUR-APP-DOMAIN/api/ingest/lead';
const INGEST_TOKEN = 'PASTE_YOUR_PIPELINE_TOKEN';
// ─────────────────────────────────────────────────────────────────────────────

// Header text of the column used to mark a row as already synced.
// The script creates it automatically if it does not exist. Set to '' to disable
// dedupe (every run then re-pushes all rows — the app upserts, so it is safe,
// just wasteful).
const SYNCED_HEADER = 'Synced At';

// Which TAB (sheet) inside the spreadsheet holds your leads, e.g. 'abc'.
// Leave '' to use whichever tab is currently active. IMPORTANT: if you run this
// on a time-driven trigger and your data is not on the first tab, set this —
// triggers have no "active" tab and default to the first one.
const SHEET_TAB = '';

// If your phone column header is NOT one of phone / mobile / phoneNumber, put its
// exact header text here, e.g. 'Mobile Number'. Leave '' if it already matches.
const PHONE_HEADER = '';

// If your name column header is NOT 'name' / 'Name', put its exact header here,
// e.g. 'Full Name'. Leave '' if it already matches (optional — name is not required).
const NAME_HEADER = '';

/** Push EVERY row (ignores the synced marker). Good for a first import. */
function syncAllLeads() {
  const { sheet, rows, syncedCol } = readSheet_();
  if (!rows.length) { Logger.log('No rows to sync.'); return; }

  const result = pushLeads_(rows.map(r => r.data));
  Logger.log(result.message);

  // Stamp every pushed row so a later syncNewLeads trigger does not re-send them.
  // Only stamp when the webhook actually accepted the batch.
  if (result.ok) stampSynced_(sheet, rows, syncedCol);
}

/** Push only rows that have not been marked synced yet. Use this on a trigger. */
function syncNewLeads() {
  const { sheet, rows, syncedCol } = readSheet_();
  const pending = rows.filter(r => !r.synced);
  if (!pending.length) { Logger.log('Nothing new to sync.'); return; }

  const result = pushLeads_(pending.map(r => r.data));
  Logger.log(result.message);

  // Mark the pushed rows so they are not sent again (only if the push succeeded).
  if (result.ok) stampSynced_(sheet, pending, syncedCol);
}

/** Write the current time into the "Synced At" column for the given rows. */
function stampSynced_(sheet, rows, syncedCol) {
  if (syncedCol <= 0 || !rows.length) return;
  const stamp = new Date();
  rows.forEach(r => sheet.getRange(r.rowIndex, syncedCol).setValue(stamp));
}

/** Read the target tab into structured rows keyed by header. */
function readSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = SHEET_TAB ? ss.getSheetByName(SHEET_TAB) : ss.getActiveSheet();
  if (!sheet) throw new Error('Tab not found: "' + SHEET_TAB + '". Check the SHEET_TAB name.');
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { sheet, rows: [], syncedCol: 0 };

  const headers = values[0].map(h => String(h).trim());
  let syncedCol = 0;
  if (SYNCED_HEADER) {
    const idx = headers.indexOf(SYNCED_HEADER);
    if (idx === -1) {
      syncedCol = headers.length + 1;
      sheet.getRange(1, syncedCol).setValue(SYNCED_HEADER);
      headers.push(SYNCED_HEADER);
    } else {
      syncedCol = idx + 1;
    }
  }

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const data = {};
    headers.forEach((h, c) => { if (h && h !== SYNCED_HEADER) data[h] = values[i][c]; });
    // Map custom column headers to the names the pipeline expects.
    if (PHONE_HEADER && data[PHONE_HEADER] != null && data.phone == null) data.phone = data[PHONE_HEADER];
    if (NAME_HEADER && data[NAME_HEADER] != null && data.name == null) data.name = data[NAME_HEADER];
    const synced = syncedCol > 0 ? !!values[i][syncedCol - 1] : false;
    rows.push({ rowIndex: i + 1, data: data, synced: synced });
  }
  return { sheet, rows, syncedCol };
}

/**
 * POST an array of lead objects to the pipeline webhook.
 * Returns { ok, message } — ok is true only on a 2xx response, so callers
 * know whether it is safe to mark the rows as synced.
 */
function pushLeads_(leads) {
  const valid = leads.filter(l => l && (l.phone || l.mobile || l.phoneNumber));
  if (!valid.length) return { ok: false, message: 'No rows with a phone/mobile column.' };

  const res = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-token': INGEST_TOKEN },
    payload: JSON.stringify({ leads: valid }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  return { ok: code >= 200 && code < 300, message: code + ': ' + res.getContentText() };
}
