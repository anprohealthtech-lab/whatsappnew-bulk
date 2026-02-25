import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@shared/schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Force IPv4 to avoid EHOSTUNREACH errors on IPv6
// Parse URL and ensure sslmode is set
const dbUrl = new URL(process.env.DATABASE_URL);
if (!dbUrl.searchParams.has('sslmode')) {
  dbUrl.searchParams.set('sslmode', 'require');
}
const connectionString = dbUrl.toString();

// Configure postgres-js with robust pooling and retry logic
const queryClient = postgres(connectionString, {
  max: 10,                    // Moderate pool — Neon has connection limits
  idle_timeout: 20,           // Release idle connections (Neon bills by compute time)
  connect_timeout: 30,        // Allow time for Neon cold-start wake-up (can take 5-10s)
  max_lifetime: 60 * 30,      // Recycle connections every 30 minutes
  fetch_types: true,
  connection: {
    application_name: 'whatsapp-persistent',
  },
  transform: {
    undefined: null
  },
  onnotice: () => {},         // Suppress notices
  debug: false,
  prepare: true,
});

// Add connection health check
let isConnected = false;
queryClient.unsafe('SELECT 1').then(() => {
  isConnected = true;
  console.log('✅ Database connection pool established');
}).catch((err) => {
  console.error('❌ Initial database connection failed:', err.message);
});

// Keep-alive ping every 4 minutes to prevent Neon compute suspension
// Neon suspends after ~5 min of inactivity; this keeps it warm
setInterval(async () => {
  try {
    await queryClient.unsafe('SELECT 1');
    if (!isConnected) {
      isConnected = true;
      console.log('✅ Database connection restored');
    }
  } catch (err: any) {
    isConnected = false;
    console.warn('⚠️ Database keep-alive ping failed:', err.code || err.message);
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