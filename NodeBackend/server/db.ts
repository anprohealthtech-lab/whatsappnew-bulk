import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@shared/schema';
import dns from 'node:dns';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Force IPv4 — DO pods sometimes have broken IPv6 routing
dns.setDefaultResultOrder('ipv4first');

try {
  const dbUrl = new URL(process.env.DATABASE_URL);
  console.log(`🔌 DB host: ${dbUrl.hostname}:${dbUrl.port || 5432}`);
} catch {
  console.log(`🔌 DB URL provided (could not parse as URL, but will try connecting)`);
}

// Standard postgres-js driver — works perfectly with DO Managed PostgreSQL (same network)
const queryClient = postgres(process.env.DATABASE_URL, {
  max: 5,                     // Connection pool size
  idle_timeout: 30,           // Release idle connections after 30s
  connect_timeout: 30,        // 30s connection timeout
  max_lifetime: 60 * 30,      // Recycle connections every 30 minutes
  fetch_types: false,         // Disable type fetching (safe default)
  prepare: false,             // Disable prepared statements (safe default)
  connection: {
    application_name: 'whatsapp-persistent',
  },
  transform: {
    undefined: null
  },
  onnotice: () => {},
  ssl: process.env.DATABASE_URL.includes('sslmode=require') ? 'require' : false,
});

let isConnected = false;
let keepAliveFailures = 0;

async function connectWithRetry(): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await queryClient.unsafe('SELECT 1');
      isConnected = true;
      console.log('✅ Database connection established');
      return;
    } catch (err: any) {
      console.error(`❌ DB connection attempt ${attempt}/${maxAttempts} failed: ${err.code || err.message}`);
      if (attempt < maxAttempts) {
        const delay = attempt * 2000;
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  console.error('❌ Could not connect to DB. Check DATABASE_URL in environment variables.');
}

connectWithRetry();

// Keep-alive ping every 4 minutes
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
    console.warn(`⚠️ Database keep-alive failed (${keepAliveFailures} consecutive): ${err.code || err.message}`);
  }
}, 4 * 60 * 1000);

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