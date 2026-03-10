/**
 * One-time contacts import script
 * Usage: node scripts/import-contacts.mjs
 *
 * Reads contacts from ../contacts-data.js and inserts into DO PostgreSQL.
 * Safe to run multiple times — uses INSERT ON CONFLICT DO NOTHING.
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ Set DATABASE_URL environment variable first');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  connect_timeout: 30,
  ssl: 'require',
  prepare: false,
  fetch_types: false,
});

const csvPath = join(__dirname, '..', '..', 'contacts (1).csv');
console.log(`📂 Reading CSV from: ${csvPath}`);

const csvContent = readFileSync(csvPath, 'utf-8');
const rows = parse(csvContent, {
  columns: true,
  skip_empty_lines: true,
  relax_quotes: true,
  trim: true,
});

console.log(`📋 Found ${rows.length} contacts to import`);

let imported = 0;
let skipped = 0;
let errors = 0;

for (const row of rows) {
  try {
    const conversationState = row.conversation_state && row.conversation_state.trim()
      ? (() => { try { return JSON.parse(row.conversation_state); } catch { return null; } })()
      : null;

    await sql`
      INSERT INTO contacts (
        id, phone_number, name, is_lead, lead_trigger_keyword,
        conversation_state, last_message_at, created_at, updated_at,
        chatbot_active, user_type
      ) VALUES (
        ${row.id},
        ${row.phone_number},
        ${row.name || null},
        ${row.is_lead || 'false'},
        ${row.lead_trigger_keyword || null},
        ${conversationState ? JSON.stringify(conversationState) : null},
        ${row.last_message_at || null},
        ${row.created_at || null},
        ${row.updated_at || null},
        ${row.chatbot_active || 'true'},
        ${row.user_type || null}
      )
      ON CONFLICT (phone_number) DO NOTHING
    `;
    imported++;
    if (imported % 50 === 0) console.log(`  ✅ Imported ${imported}/${rows.length}...`);
  } catch (err) {
    errors++;
    console.error(`  ❌ Error on row ${row.phone_number}: ${err.message}`);
  }
}

await sql.end();
console.log(`\n🎉 Import complete!`);
console.log(`   ✅ Imported: ${imported}`);
console.log(`   ⏭️  Skipped (duplicates): ${rows.length - imported - errors}`);
console.log(`   ❌ Errors: ${errors}`);
