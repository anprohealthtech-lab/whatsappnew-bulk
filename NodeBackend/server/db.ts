import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@shared/schema';
import dns from 'node:dns';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Force Node.js to prefer IPv4 over IPv6 — prevents EHOSTUNREACH from DO pods
// DO Kubernetes pods often lack IPv6 routing, causing EHOSTUNREACH on IPv6 addresses
dns.setDefaultResultOrder('ipv4first');

// Parse URL and ensure sslmode + connection_limit for Neon pooler
const dbUrl = new URL(process.env.DATABASE_URL);
if (!dbUrl.searchParams.has('sslmode')) {
  dbUrl.searchParams.set('sslmode', 'require');
}
// If using Neon pooler, limit connections per instance
if (dbUrl.hostname.includes('pooler') || dbUrl.searchParams.has('pgbouncer')) {
  dbUrl.searchParams.set('connection_limit', '1');
}
const connectionString = dbUrl.toString();

console.log(`🔌 DB host: ${dbUrl.hostname} (pooler: ${dbUrl.hostname.includes('pooler') ? 'YES' : 'NO — consider using pooler URL'})`);

// Configure postgres-js with robust pooling and retry logic
const queryClient = postgres(connectionString, {
  max: dbUrl.hostname.includes('pooler') ? 1 : 5, // Neon pooler: 1 connection per instance
  idle_timeout: 30,           // Release idle connections
  connect_timeout: 60,        // Neon cold-start can take up to 30s — give extra buffer
  max_lifetime: 60 * 20,      // Recycle connections every 20 minutes
  fetch_types: true,
  connection: {
    application_name: 'whatsapp-persistent',
  },
  transform: {
    undefined: null
  },
  onnotice: () => {},         // Suppress notices
  debug: false,
  prepare: false,             // Disable prepared statements — required for Neon pooler (PgBouncer)
  // Handle connection errors gracefully
  onclose: (connection_id) => {
    console.warn(`⚠️ DB connection ${connection_id} closed unexpectedly`);
  },
});

// Add connection health check
let isConnected = false;
let reconnectAttempts = 0;

async function connectWithRetry(): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await queryClient.unsafe('SELECT 1');
      isConnected = true;
      reconnectAttempts = 0;
      console.log('✅ Database connection pool established');
      return;
    } catch (err: any) {
      console.error(`❌ DB connection attempt ${attempt}/${maxAttempts} failed: ${err.code || err.message}`);
      if (attempt < maxAttempts) {
        const delay = attempt * 3000; // 3s, 6s, 9s, 12s
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  console.error('❌ Could not establish initial DB connection after all attempts. App will continue and retry via keep-alive.');
}

connectWithRetry();

// Keep-alive ping every 4 minutes to prevent Neon compute suspension
// Neon suspends after ~5 min of inactivity; this keeps it warm
let keepAliveFailures = 0;
setInterval(async () => {
  try {
    await queryClient.unsafe('SELECT 1');
    if (!isConnected) {
      isConnected = true;
      keepAliveFailures = 0;
      console.log('✅ Database connection restored');
    }
    keepAliveFailures = 0;
  } catch (err: any) {
    keepAliveFailures++;
    isConnected = false;
    console.warn(`⚠️ Database keep-alive ping failed (${keepAliveFailures} consecutive): ${err.code || err.message}`);
    
    // After 3 consecutive failures, log a more actionable message
    if (keepAliveFailures >= 3) {
      console.error('🚨 Database unreachable for extended period. Check:');
      console.error('   1. Neon dashboard — is DB paused/suspended?');
      console.error('   2. Are you using the pooler connection string? (-pooler hostname)');
      console.error(`   3. DB host: ${dbUrl.hostname}`);
    }
  }
}, 4 * 60 * 1000); // 4 minutes

// Export connection health status
export const getDbHealth = async (): Promise<boolean> => {
  try {
    await queryClient.unsafe('SELECT 1');
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
};

export const db = drizzle(queryClient, { schema });
export type Database = typeof db;