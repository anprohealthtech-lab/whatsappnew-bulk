import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from '@shared/schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const dbUrl = new URL(process.env.DATABASE_URL);
console.log(`🔌 DB host: ${dbUrl.hostname}`);
console.log(`🌐 Using Neon HTTP driver (no TCP port 5432 needed — works from any cloud)`);

// Neon serverless HTTP driver — uses HTTPS (port 443) instead of TCP (port 5432)
// This eliminates ETIMEDOUT errors caused by TCP/5432 being blocked between DO and AWS
const sql = neon(process.env.DATABASE_URL);

// Test connection on startup with retry
let isConnected = false;
let keepAliveFailures = 0;

async function connectWithRetry(): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sql`SELECT 1`;
      isConnected = true;
      console.log('✅ Database connection established (Neon HTTP driver)');
      return;
    } catch (err: any) {
      console.error(`❌ DB connection attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        const delay = attempt * 2000;
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  console.error('❌ Could not establish DB connection after all attempts. Will retry via keep-alive.');
}

connectWithRetry();

// Keep-alive ping every 4 minutes to prevent Neon compute suspension
setInterval(async () => {
  try {
    await sql`SELECT 1`;
    if (!isConnected) {
      isConnected = true;
      keepAliveFailures = 0;
      console.log('✅ Database connection restored');
    }
    keepAliveFailures = 0;
  } catch (err: any) {
    keepAliveFailures++;
    isConnected = false;
    console.warn(`⚠️ Database keep-alive ping failed (${keepAliveFailures} consecutive): ${err.message}`);
    if (keepAliveFailures >= 3) {
      console.error('🚨 DB unreachable. Check Neon dashboard — is compute paused?');
      console.error(`   DB host: ${dbUrl.hostname}`);
    }
  }
}, 4 * 60 * 1000);

// Export connection health status
export const getDbHealth = async (): Promise<boolean> => {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
};

export const db = drizzle(sql, { schema });
export type Database = typeof db;