import bcrypt from 'bcryptjs';
import { db } from './db';
import { users } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { log } from './utils';

/**
 * Seeds the super admin account on startup if SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD
 * are set as environment variables and the account doesn't already exist.
 */
export async function seedSuperAdmin(): Promise<void> {
  const username = process.env.SUPER_ADMIN_USERNAME;
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!username || !password) {
    return; // No super admin configured via env vars
  }

  try {
    const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);

    if (existing.length > 0) {
      // Account exists — ensure it has super_admin role
      if (existing[0].role !== 'super_admin') {
        await db.update(users).set({ role: 'super_admin', updatedAt: new Date() }).where(eq(users.id, existing[0].id));
        log(`Promoted existing user "${username}" to super_admin`);
      }
      return;
    }

    // Create the super admin account
    const passwordHash = await bcrypt.hash(password, 12);
    await db.insert(users).values({
      username,
      password: passwordHash,
      email: username.includes('@') ? username : null,
      organizationId: 'platform',
      role: 'super_admin',
    });

    log(`Super admin account created: ${username}`);
  } catch (error: any) {
    log(`Warning: Could not seed super admin — ${error.message}`);
  }
}
