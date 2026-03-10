const postgres = require('postgres');
const dns = require('dns');
require('dotenv').config();

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const host = new URL(dbUrl).hostname;

// Use Google DNS (8.8.8.8) to resolve, bypassing local DNS issues
const resolver = new dns.Resolver();
resolver.setServers(['8.8.8.8', '8.8.4.4']);

function resolveHost(hostname) {
  return new Promise((resolve, reject) => {
    resolver.resolve4(hostname, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

async function main() {
  const start = Date.now();
  console.log('Resolving', host, 'via Google DNS...');
  const ips = await resolveHost(host);
  console.log('Resolved to:', ips.join(', '));
  const resolvedIp = ips[0];

  // Build connection URL using resolved IP but keep SNI hostname for TLS
  const urlObj = new URL(dbUrl);
  const origHost = urlObj.hostname;
  urlObj.hostname = resolvedIp;
  const ipUrl = urlObj.toString();

  const sql = postgres(ipUrl, {
    connect_timeout: 30,
    max: 1,
    idle_timeout: 5,
    ssl: { rejectUnauthorized: false, servername: origHost }
  });

  try {
    console.log('');
    console.log('Testing Neon DB connectivity...');
    console.log('Host:', origHost, '→', resolvedIp);
    console.log('');

    // Test 1: Cold connection
    const t1 = Date.now();
    const r1 = await sql`SELECT 1 as test, now() as server_time, version() as pg_version`;
    const d1 = Date.now() - t1;
    console.log('Test 1 (cold connect): ' + d1 + 'ms');
    console.log('  Server time:', r1[0].server_time);
    console.log('  PG version:', r1[0].pg_version.substring(0, 80));
    console.log('');

    // Test 2: Warm query
    const t2 = Date.now();
    await sql`SELECT 1`;
    console.log('Test 2 (warm query): ' + (Date.now() - t2) + 'ms');

    // Test 3: Another warm query
    const t3 = Date.now();
    await sql`SELECT count(*) from information_schema.tables`;
    console.log('Test 3 (warm, count tables): ' + (Date.now() - t3) + 'ms');

    // Test 4: List app tables
    const t4 = Date.now();
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    console.log('Test 4 (list public tables): ' + (Date.now() - t4) + 'ms');
    console.log('  Tables:', tables.map(t => t.table_name).join(', '));
    console.log('');

    // Test 5: Quick 5 pings
    console.log('Test 5 (5x ping):');
    for (let i = 0; i < 5; i++) {
      const tp = Date.now();
      await sql`SELECT 1`;
      console.log('  Ping ' + (i+1) + ': ' + (Date.now() - tp) + 'ms');
    }

    console.log('');
    console.log('Total elapsed: ' + (Date.now() - start) + 'ms');
    console.log('✅ Neon DB is REACHABLE and responsive');

    await sql.end();
  } catch (err) {
    console.error('❌ Connection failed after ' + (Date.now() - start) + 'ms');
    console.error('Error:', err.code || '', err.message);
    await sql.end().catch(() => {});
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
