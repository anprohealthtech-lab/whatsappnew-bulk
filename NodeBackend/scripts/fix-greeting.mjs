/**
 * Fix chatbot greeting_message in DO PostgreSQL
 * Run: node scripts/fix-greeting.mjs
 */
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }

const sql = postgres(DATABASE_URL, { max: 1, ssl: 'require', prepare: false, fetch_types: false });

// The correct 4-part greeting with real newlines and ===NEXT_MESSAGE=== separators
const greetingMessage = 
`Hello 👋
Welcome to *AnPro Solutions!*

*AnPro LIMS* में interest दिखाने के लिए thank you।

AnPro India का first *AI-based Laboratory Information Management System (LIMS)* है, जो specially modern diagnostic labs के लिए design किया गया है।
यह lab operations को automate करता है, manual work कम करता है, और complete *WhatsApp integration* provide करता है — बिना किसी extra cost के।

आपसे request है कि पहले नीचे दिया गया short introduction video देख लें।
इस video में आपको AnPro का overview, key features, pricing और additional demo video links मिल जाएंगे:

👉 https://app.supademo.com/demo/cml52cn4j3h6nzsadnq3xl323

अगर आपको AnPro आपकी lab के लिए suitable लगे, तो इसी number पर हमें वापस contact कीजिए।

आपसे बात करने का इंतज़ार रहेगा 😊

Regards,
*Team AnPro Solutions*
===NEXT_MESSAGE===
AUDIO_URL: https://api.limsapp.in/storage/v1/object/public/reports/reports/ElevenLabs_2026-02-22T05_04_24_Riya%20Rao%20-%20Hindi%20Customer%20Care_pvc_sp109_s50_sb17_se0_b_m2.mp3
===NEXT_MESSAGE===
Hello 👋

Welcome to *AnPro Solutions!*

Thank you for showing interest in *AnPro LIMS*.

AnPro is India's first AI-based Laboratory Information Management System, specially designed for modern diagnostic laboratories. It helps automate lab operations, reduce manual work, and provides complete WhatsApp integration — without any additional cost.

We request you to please watch the short introduction video below first.
In this video, you will find an overview of AnPro, key features, pricing details, and links to additional demo videos:

👉 https://app.supademo.com/demo/cml52cn4j3h6nzsadnq3xl323

If you find AnPro suitable for your lab, please feel free to contact us on this number.

We look forward to speaking with you 😊

Regards,
*Team AnPro Solutions*
===NEXT_MESSAGE===
AUDIO_URL: https://api.limsapp.in/storage/v1/object/public/reports/reports/ElevenLabs_2026-02-22T05_02_26_Riya%20Rao%20-%20Hindi%20Customer%20Care_pvc_sp109_s50_sb17_se0_b_m2.mp3`;

try {
  // Check current state
  const current = await sql`SELECT id, agent_name, length(greeting_message) as len FROM chatbot_configs`;
  console.log('Current chatbot_configs:', current);

  // Count parts in current greeting
  const currentGreeting = await sql`SELECT greeting_message FROM chatbot_configs LIMIT 1`;
  if (currentGreeting.length > 0) {
    const parts = currentGreeting[0].greeting_message?.split('===NEXT_MESSAGE===') || [];
    console.log(`Current greeting has ${parts.length} part(s)`);
    parts.forEach((p, i) => console.log(`  Part ${i+1}: ${p.trim().substring(0, 60)}...`));
  }

  // Update with correct 4-part greeting (update ALL rows — there's only 1)
  const result = await sql`
    UPDATE chatbot_configs 
    SET greeting_message = ${greetingMessage},
        updated_at = NOW()
  `;

  console.log(`\n✅ Updated ${result.count} row(s)`);

  // Verify
  const verify = await sql`SELECT greeting_message FROM chatbot_configs LIMIT 1`;
  const newParts = verify[0]?.greeting_message?.split('===NEXT_MESSAGE===') || [];
  console.log(`✅ Verified: now has ${newParts.length} part(s)`);
  newParts.forEach((p, i) => console.log(`  Part ${i+1}: ${p.trim().substring(0, 80)}`));

} catch (err) {
  console.error('Error:', err.message);
} finally {
  await sql.end();
}
