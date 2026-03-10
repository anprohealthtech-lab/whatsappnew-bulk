import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { users } from '@shared/schema';
import { eq } from 'drizzle-orm';
import type { User } from '@shared/schema';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-' + Date.now();
const JWT_EXPIRES_IN = '7d';

export interface AuthPayload {
  userId: string;
  username: string;
  organizationId: string;
  role: string;
}

export interface AuthResult {
  user: Omit<User, 'password'>;
  token: string;
}

class AuthService {
  async register(username: string, password: string, email?: string, organizationId?: string): Promise<AuthResult> {
    // Check if username exists
    const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (existing.length > 0) {
      throw new Error('Username already exists');
    }

    // Check email uniqueness if provided
    if (email) {
      const emailExists = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (emailExists.length > 0) {
        throw new Error('Email already registered');
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await db.insert(users).values({
      username,
      password: passwordHash,
      email: email || null,
      organizationId: organizationId || 'org_' + Date.now(),
      role: 'admin', // First user of an org is admin
    }).returning();

    const user = result[0];
    const token = this.generateToken(user);

    return {
      user: this.stripPassword(user),
      token,
    };
  }

  async login(username: string, password: string): Promise<AuthResult> {
    const result = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (result.length === 0) {
      throw new Error('Invalid credentials');
    }

    const user = result[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      throw new Error('Invalid credentials');
    }

    // Update last login
    await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));

    const token = this.generateToken(user);
    return {
      user: this.stripPassword(user),
      token,
    };
  }

  verifyToken(token: string): AuthPayload {
    return jwt.verify(token, JWT_SECRET) as AuthPayload;
  }

  async getUser(userId: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return result[0];
  }

  private generateToken(user: User): string {
    const payload: AuthPayload = {
      userId: user.id,
      username: user.username,
      organizationId: user.organizationId,
      role: user.role,
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  private stripPassword(user: User): Omit<User, 'password'> {
    const { password, ...rest } = user;
    return rest;
  }
}

export const authService = new AuthService();
