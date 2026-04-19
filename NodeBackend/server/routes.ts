import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer } from "ws";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { storage } from "./storage";
import type { WAServiceInstance } from "./services/WhatsAppSessionManager";
import { messageService } from "./services/MessageService";
import { fileService } from "./services/FileService";
import { persistentFileService } from "./services/PersistentFileService";
import { campaignService } from "./services/CampaignService";
import { AutoResponseService } from "./services/AutoResponseService";
import { ChatbotService } from "./services/ChatbotService";
import { HRChatbotService } from "./services/HRChatbotService";
import { HIMSChatbotService } from "./services/HIMSChatbotService";
import { sendMessageSchema, sendReportSchema, createCampaignSchema, bulkSendSchema, chatbotConfigSchema, flagLeadSchema, registerHRAdminSchema, hrChatbotConfigSchema, demoSchedules, scheduleCampaignSchema, userRagAgentSchema, userRagAgents, userNotificationRecipientSchema, userNotificationRecipients, registerSchema, loginSchema, registerHIMSPatientSchema } from "@shared/schema";
import { log } from "./utils";
import { getDbHealth, db } from "./db";
import { sql as drizzleSql, eq, and, desc } from "drizzle-orm";
import { withRetry } from "./dbRetry";
import { z } from "zod";
import * as XLSX from 'xlsx';
import { authService } from "./services/AuthService";
import { requireAuth, optionalAuth, getTenant, requireSuperAdmin } from "./authMiddleware";
import { sessionManager } from "./services/WhatsAppSessionManager";
import { users, messages as messagesTable, chatbotConfigs, contacts as contactsTable, campaigns as campaignsTable } from "@shared/schema";
import { sendNotificationForEvent } from "./services/UserNotificationService";

// Configure CORS
const corsOptions = {
  origin: [
    "http://localhost:4173",
    "http://localhost:5173",
    ...(process.env.REPLIT_DOMAINS ? process.env.REPLIT_DOMAINS.split(',') : [])
  ],
  credentials: true,
};

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760'), // 10MB default
  },
});

type ParsedWebhookLead = {
  source?: string;
  name?: string;
  phoneRaw: string;
  email?: string;
  labStatus?: string;
  launchTimeline?: string;
};

type PhoneNormalizationResult = {
  normalizedPhone: string;
  originalPhone: string;
  duplicatePrefixTrimmed: boolean;
  defaultCountryAdded: boolean;
  notes: string[];
};

type TenantContext = {
  organizationId: string;
  userId: string;
};

function getTenantFromRequest(req: Request): TenantContext {
  // Prefer JWT auth context if available
  if (req.auth) {
    return { organizationId: req.auth.organizationId, userId: req.auth.userId };
  }
  // Fallback for backwards compat / migration period
  const organizationId = String(req.headers['x-organization-id'] || req.query.organizationId || req.body?.organizationId || 'default_org');
  const userId = String(req.headers['x-user-id'] || req.query.userId || req.body?.userId || 'default_user');
  return { organizationId, userId };
}

function hasExplicitTenantInRequest(req: Request): boolean {
  return Boolean(
    req.auth ||
    req.headers['x-organization-id'] ||
    req.headers['x-user-id'] ||
    req.query.organizationId ||
    req.query.userId ||
    req.body?.organizationId ||
    req.body?.userId
  );
}

async function resolveTenantForUserId(userId: string): Promise<TenantContext> {
  const ownerUser = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (ownerUser[0]) {
    return { organizationId: ownerUser[0].organizationId, userId: ownerUser[0].id };
  }
  return { organizationId: 'default_org', userId };
}

function firstNonEmpty(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

function extractLineValue(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.+)\\s*$`, "im"));
  return match?.[1]?.trim();
}

/** Get the user's first connected WhatsApp session, or throw */
async function getUserWASession(req: Request): Promise<WAServiceInstance> {
  const userId = req.auth?.userId;
  if (!userId) throw new Error('Authentication required');
  const session = await sessionManager.getFirstConnectedSession(userId);
  if (!session) throw new Error('No connected WhatsApp session. Please connect WhatsApp first.');
  return session;
}

function parseLeadFromFreeText(text: string): Partial<ParsedWebhookLead> {
  return {
    source: extractLineValue(text, "Source"),
    name: extractLineValue(text, "Name"),
    phoneRaw: extractLineValue(text, "Phone") || "",
    email: extractLineValue(text, "Email"),
    labStatus: firstNonEmpty(
      extractLineValue(text, "Status"),
      extractLineValue(text, "Lab Status")
    ),
    launchTimeline: extractLineValue(text, "Launch Timeline"),
  };
}

function normalizeWebhookLeadPhone(input: string): PhoneNormalizationResult {
  const originalPhone = String(input || "").trim();
  const notes: string[] = [];
  let duplicatePrefixTrimmed = false;
  let defaultCountryAdded = false;

  // Preserve explicit international intent if user typed '+'.
  const hasExplicitInternationalPrefix = originalPhone.includes("+");

  let digits = originalPhone.replace(/\D/g, "");
  if (!digits) {
    throw new Error("Phone number is empty");
  }

  if (digits.startsWith("00") && digits.length > 2) {
    digits = digits.slice(2);
    notes.push("removed_00_prefix");
  }

  const trailingTen = digits.slice(-10);
  const looksLikeIndianMobile = /^[6-9]\d{9}$/.test(trailingTen);
  const hasRepeatedStartChunk =
    digits.length > 10 &&
    ((digits.length >= 4 && digits.slice(0, 2) === digits.slice(2, 4)) || /^(\d)\1{1,3}/.test(digits));

  // Heuristic "AI-like" cleanup for obvious accidental duplicate typing.
  if (!hasExplicitInternationalPrefix && hasRepeatedStartChunk && looksLikeIndianMobile) {
    digits = trailingTen;
    duplicatePrefixTrimmed = true;
    notes.push("trimmed_obvious_duplicate_prefix");
  }

  if (digits.length === 10) {
    digits = `91${digits}`;
    defaultCountryAdded = true;
    notes.push("added_default_country_91");
  } else if (digits.length < 10) {
    throw new Error("Phone number appears too short after normalization");
  } else {
    notes.push("kept_existing_country_or_long_format");
  }

  return {
    normalizedPhone: digits,
    originalPhone,
    duplicatePrefixTrimmed,
    defaultCountryAdded,
    notes,
  };
}

function parseWebhookLeadBody(body: any): ParsedWebhookLead {
  const textPayload = firstNonEmpty(
    body?.message,
    body?.text,
    body?.payload,
    body?.leadText,
    body?.body
  );

  const parsedFromText = textPayload ? parseLeadFromFreeText(textPayload) : {};

  const phoneRaw = firstNonEmpty(
    body?.phoneNumber,
    body?.phone,
    body?.mobile,
    body?.contact,
    parsedFromText.phoneRaw
  );

  if (!phoneRaw) {
    throw new Error("phone / phoneNumber is required in webhook payload");
  }

  return {
    source: firstNonEmpty(body?.source, body?.leadSource, parsedFromText.source),
    name: firstNonEmpty(body?.name, body?.fullName, parsedFromText.name),
    phoneRaw,
    email: firstNonEmpty(body?.email, parsedFromText.email),
    labStatus: firstNonEmpty(body?.labStatus, body?.status, parsedFromText.labStatus),
    launchTimeline: firstNonEmpty(body?.launchTimeline, body?.timeline, parsedFromText.launchTimeline),
  };
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Apply CORS middleware
  app.use(cors(corsOptions));

  // ============================================================
  // AUTH ROUTES (public — no middleware)
  // ============================================================
  app.post('/api/auth/register', async (req, res) => {
    try {
      const data = registerSchema.parse(req.body);
      const result = await authService.register(data.username, data.password, data.email, data.organizationId);
      res.json(result);
    } catch (error: any) {
      const status = error.message?.includes('already') ? 409 : 400;
      res.status(status).json({ message: error.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const data = loginSchema.parse(req.body);
      const result = await authService.login(data.username, data.password);
      res.json(result);
    } catch (error: any) {
      res.status(401).json({ message: error.message || 'Invalid credentials' });
    }
  });

  app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
      const user = await authService.getUser(req.auth!.userId);
      if (!user) return res.status(404).json({ message: 'User not found' });
      const { password, ...safe } = user;
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================
  // SUPER ADMIN ROUTES (requires super_admin role)
  // ============================================================

  // List all organizations with user counts
  app.get('/api/admin/organizations', requireSuperAdmin, async (_req, res) => {
    try {
      const result = await db.select({
        organizationId: users.organizationId,
      }).from(users).groupBy(users.organizationId);

      // Get user counts per org
      const orgs = await Promise.all(
        [...new Set(result.map(r => r.organizationId))].map(async (orgId) => {
          const orgUsers = await db.select().from(users).where(eq(users.organizationId, orgId));
          return {
            organizationId: orgId,
            userCount: orgUsers.length,
            users: orgUsers.map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt })),
          };
        })
      );
      res.json(orgs);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // List all users
  app.get('/api/admin/users', requireSuperAdmin, async (_req, res) => {
    try {
      const allUsers = await db.select({
        id: users.id,
        username: users.username,
        email: users.email,
        organizationId: users.organizationId,
        role: users.role,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      }).from(users).orderBy(desc(users.createdAt));
      res.json(allUsers);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Create a new user (super admin can create users in any org)
  app.post('/api/admin/users', requireSuperAdmin, async (req, res) => {
    try {
      const { username, password, email, organizationId, role } = req.body;
      if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
      }
      const validRoles = ['user', 'admin', 'super_admin'];
      if (role && !validRoles.includes(role)) {
        return res.status(400).json({ message: 'Invalid role' });
      }

      const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);
      if (existing.length > 0) {
        return res.status(409).json({ message: 'Username already exists' });
      }

      const bcrypt = await import('bcryptjs');
      const passwordHash = await bcrypt.hash(password, 12);

      const result = await db.insert(users).values({
        username,
        password: passwordHash,
        email: email || null,
        organizationId: organizationId || 'org_' + Date.now(),
        role: role || 'user',
      }).returning();

      const { password: _, ...safe } = result[0];
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Update user (change role, org, email)
  app.patch('/api/admin/users/:userId', requireSuperAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const { role, organizationId, email, enabledFeatures } = req.body;

      const updateData: any = { updatedAt: new Date() };
      if (role) {
        const validRoles = ['user', 'admin', 'super_admin'];
        if (!validRoles.includes(role)) return res.status(400).json({ message: 'Invalid role' });
        updateData.role = role;
      }
      if (organizationId) updateData.organizationId = organizationId;
      if (email !== undefined) updateData.email = email || null;
      if (enabledFeatures !== undefined) updateData.enabledFeatures = enabledFeatures;

      const result = await db.update(users).set(updateData).where(eq(users.id, userId)).returning();
      if (result.length === 0) return res.status(404).json({ message: 'User not found' });

      const { password: _, ...safe } = result[0];
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Delete user
  app.delete('/api/admin/users/:userId', requireSuperAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      // Prevent deleting yourself
      if (userId === req.auth!.userId) {
        return res.status(400).json({ message: 'Cannot delete your own account' });
      }
      const result = await db.delete(users).where(eq(users.id, userId)).returning();
      if (result.length === 0) return res.status(404).json({ message: 'User not found' });
      res.json({ message: 'User deleted' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Reset user password
  app.post('/api/admin/users/:userId/reset-password', requireSuperAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const { newPassword } = req.body;
      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters' });
      }
      const bcrypt = await import('bcryptjs');
      const hash = await bcrypt.hash(newPassword, 12);
      const result = await db.update(users).set({ password: hash, updatedAt: new Date() }).where(eq(users.id, userId)).returning();
      if (result.length === 0) return res.status(404).json({ message: 'User not found' });
      res.json({ message: 'Password reset successfully' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Platform stats for super admin dashboard
  app.get('/api/admin/stats', requireSuperAdmin, async (_req, res) => {
    try {
      const allUsers = await db.select().from(users);
      const orgSet = new Set(allUsers.map(u => u.organizationId));
      const superAdmins = allUsers.filter(u => u.role === 'super_admin').length;
      const admins = allUsers.filter(u => u.role === 'admin').length;
      const regularUsers = allUsers.filter(u => u.role === 'user').length;

      res.json({
        totalUsers: allUsers.length,
        totalOrganizations: orgSet.size,
        superAdmins,
        admins,
        regularUsers,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================
  // PER-USER WHATSAPP SESSION ROUTES
  // ============================================================
  const MAX_SESSIONS_PER_USER = 3;

  app.post('/api/whatsapp/session/init', requireAuth, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const sessionName = req.body.sessionName || 'default';

      // Check if this is a new session (not re-initializing existing)
      const existingSessions = await sessionManager.listSessions(userId);
      const isExisting = existingSessions.some(s => s.sessionName === sessionName);
      if (!isExisting && existingSessions.length >= MAX_SESSIONS_PER_USER) {
        return res.status(400).json({
          message: `Maximum ${MAX_SESSIONS_PER_USER} sessions allowed per user. Disconnect an existing session first.`
        });
      }

      const wa = await sessionManager.getSession(userId, sessionName);
      await wa.initialize();
      res.json({ status: 'initializing', sessionName });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/whatsapp/session/status', requireAuth, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const sessionName = (req.query.sessionName as string) || 'default';
      const wa = sessionManager.getLoadedSession(userId, sessionName);
      res.json(wa ? wa.getStatus() : { isConnected: false, isAuthenticated: false, lastSeen: null, sessionInfo: null });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/whatsapp/session/qr', requireAuth, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const sessionName = (req.query.sessionName as string) || 'default';
      const wa = sessionManager.getLoadedSession(userId, sessionName);
      const qrData = wa?.getCurrentQR();
      const qrValue = qrData && typeof qrData === 'object' && 'qr' in qrData ? qrData.qr : null;
      const qrCode = qrData && typeof qrData === 'object' && 'qrCode' in qrData ? qrData.qrCode || qrValue : qrValue;
      const rawQR = qrData && typeof qrData === 'object' && 'rawQR' in qrData ? qrData.rawQR || null : null;
      res.json({ qr: qrValue, qrCode, rawQR });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/whatsapp/session/disconnect', requireAuth, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const sessionName = req.body.sessionName || 'default';
      await sessionManager.removeSession(userId, sessionName);
      res.json({ status: 'disconnected' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/whatsapp/sessions', requireAuth, async (req, res) => {
    try {
      const sessions = await sessionManager.listSessions(req.auth!.userId);
      res.json(sessions);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Session connection history
  app.get('/api/whatsapp/session/history', requireAuth, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const sessionName = req.query.sessionName as string | undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const history = await sessionManager.getSessionHistory(userId, sessionName, limit);
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Restore previously connected WhatsApp sessions (multi-user)
  try {
    await sessionManager.restoreConnectedSessions();
    log("WhatsApp sessions restored successfully");
  } catch (error: any) {
    log(`Failed to restore WhatsApp sessions: ${(error as Error).message}`);
  }

  // Initialize chatbot configuration
  // Create HTTP server
  const httpServer = createServer(app);

  // Setup WebSocket server for real-time communication
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // WebSocket connection handling
  wss.on('connection', (ws) => {
    log('WebSocket client connected');

    // Note: WhatsApp status is now per-user — clients should use /api/whatsapp/sessions
    // WebSocket is still used for real-time event broadcasts (QR codes, incoming messages, etc.)

    ws.on('close', () => {
      log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      log(`WebSocket error: ${error.message}`);
    });
  });

  // Broadcast function for WebSocket messages
  const broadcast = (type: string, data: any) => {
    const message = JSON.stringify({ type, data });
    console.log(`Broadcasting ${type} to ${wss.clients.size} clients:`, data);
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    });
  };

  // Setup per-session WhatsApp event listeners via sessionManager
  // These handlers are wired to EVERY session (current and future)

  sessionManager.onSessionEvent('qr-code', (userId, sessionName, data) => {
    console.log(`🎯 ROUTES: Received qr-code event from session ${userId}/${sessionName}`);
    broadcast('qr-code', { ...data, userId, sessionName });
  });

  sessionManager.onSessionEvent('whatsapp-status', (userId, sessionName, data) => {
    broadcast('whatsapp-status', { ...data, userId, sessionName });
  });

  sessionManager.onSessionEvent('whatsapp-authenticated', (userId, sessionName, data) => {
    broadcast('whatsapp-authenticated', { ...data, userId, sessionName });
  });

  sessionManager.onSessionEvent('whatsapp-auth-failure', (userId, sessionName, data) => {
    broadcast('whatsapp-auth-failure', { ...data, userId, sessionName });
  });

  sessionManager.onSessionEvent('disconnected', (userId, sessionName, data) => {
    broadcast('disconnected', { ...data, userId, sessionName });
  });

  sessionManager.onSessionEvent('message-sent', (userId, sessionName, data) => {
    broadcast('message-sent', data);
  });

  sessionManager.onSessionEvent('message-update', async (userId, sessionName, data) => {
    // Update message delivery status
    await messageService.updateMessageDeliveryStatus(data.messageId, data.ack === 3 ? 'delivered' : 'failed');
    broadcast('message-update', data);
  });

  sessionManager.onSessionEvent('button-clicked', async (userId, sessionName, data) => {
    console.log('📱 Button clicked event received:', data);

    // Handle STOP_MESSAGES button
    if (data.buttonId === 'STOP_MESSAGES') {
      try {
        const tenant = await resolveTenantForUserId(String(userId));
        await storage.addToBlocklistForTenant(tenant, data.phoneNumber, 'user_requested');
        console.log(`✅ Added ${data.phoneNumber} to blocklist`);

        // Send confirmation using the session that received the event
        const session = sessionManager.getLoadedSession(userId, sessionName);
        if (session) {
          await session.sendTextMessage(
            data.phoneNumber,
            '✅ You have been unsubscribed. You will not receive any more messages from us.'
          );
        }
      } catch (error) {
        console.error('Failed to block number:', error);
      }
    }

    broadcast('button-clicked', data);
  });

  // Message debouncing: concatenate rapid messages instead of discarding
  const messageDebounceMap = new Map<string, NodeJS.Timeout>();
  const messageBatchMap = new Map<string, { messages: string[]; latestData: any; userId: string; sessionName: string }>();
  const DEBOUNCE_DELAY = 5000; // 5 seconds - wait for user to finish typing
  const getIncomingMessageKey = (userId: string, sessionName: string, phoneNumber: string) => `${userId}:${sessionName}:${phoneNumber}`;

  // Handle incoming messages from any session
  const handleIncomingSessionMessage = async (userId: string, sessionName: string, data: any) => {
    console.log(`📥 Incoming message received (user ${userId}/${sessionName}):`, data);
    const tenant = await resolveTenantForUserId(userId);

    // Store each incoming message immediately in DB (don't lose any)
    try {
      await withRetry(() => storage.createMessage({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        phoneNumber: data.phoneNumber,
        content: data.content,
        type: 'incoming',
        status: 'received',
        metadata: {
          from: data.from || null,
          senderPn: data.senderPn || null,
        },
      }));
    } catch (err) {
      console.error('❌ Failed to store incoming message:', err);
    }

    const incomingKey = getIncomingMessageKey(userId, sessionName, data.phoneNumber);

    // Accumulate messages for this phone number within the owning user/session
    const existing = messageBatchMap.get(incomingKey);
    if (existing) {
      existing.messages.push(data.content);
      existing.latestData = data;
    } else {
      messageBatchMap.set(incomingKey, {
        messages: [data.content],
        latestData: data,
        userId,
        sessionName,
      });
    }

    // Clear existing timeout for this phone number if any
    const existingTimeout = messageDebounceMap.get(incomingKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      console.log(`⏱️ Debouncing message from ${data.phoneNumber} (${messageBatchMap.get(incomingKey)?.messages.length} msgs batched)`);
    }

    // Set new timeout - process all batched messages after debounce window
    const timeoutId = setTimeout(async () => {
      messageDebounceMap.delete(incomingKey);
      const batch = messageBatchMap.get(incomingKey);
      messageBatchMap.delete(incomingKey);

      if (batch) {
        // Combine all batched messages into one for bot processing
        const combinedContent = batch.messages.join('\n');
        const processData = {
          ...batch.latestData,
          content: combinedContent,
          _alreadyStored: true, // Flag: messages already saved to DB individually
          _batchCount: batch.messages.length,
          _userId: batch.userId,
          _sessionName: batch.sessionName,
        };
        console.log(`📦 Processing batch of ${batch.messages.length} message(s) from ${data.phoneNumber}`);
        await processIncomingMessage(processData);
      }
    }, DEBOUNCE_DELAY);

    messageDebounceMap.set(incomingKey, timeoutId);
  };

  sessionManager.onSessionEvent('incoming-message', handleIncomingSessionMessage);

  // Extract message processing logic — now uses the session that received the message
  async function processIncomingMessage(data: any) {
    // Get the WhatsApp session that received this message
    const ownerUserId: string = data._userId;
    const ownerSessionName: string = data._sessionName;
    const waSession = sessionManager.getLoadedSession(ownerUserId, ownerSessionName);
    if (!waSession) {
      console.error(`❌ Cannot process incoming message: session ${ownerUserId}/${ownerSessionName} no longer loaded`);
      return;
    }

    try {
      // Save incoming message to database (skip if already stored by debounce handler)
      if (!data._alreadyStored) {
        const tenant = await resolveTenantForUserId(ownerUserId);
        await withRetry(() => storage.createMessage({
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          phoneNumber: data.phoneNumber,
          content: data.content,
          type: 'incoming',
          status: 'received',
        }));
      }

      const scopedTenant = await resolveTenantForUserId(ownerUserId);

      // Check if number is blocked
      const isBlocked = await withRetry(() => storage.isNumberBlockedForTenant(scopedTenant, data.phoneNumber));
      if (isBlocked) {
        console.log(`⛔ Ignoring message from blocked number: ${data.phoneNumber}`);
        broadcast('incoming-message', data);
        return;
      }

      // ========================================
      // PRIORITY 1: Check if HR Admin
      // ========================================
      const hrChatbotService = new HRChatbotService(storage, waSession);
      const isHRAdmin = await withRetry(() => hrChatbotService.isHRAdmin(data.phoneNumber));

      if (isHRAdmin) {
        console.log(`👔 HR Admin detected: ${data.phoneNumber} (messageType: ${data.messageType || 'text'})`);

        // Check if HR chatbot is active for this admin
        const hrAdmin = await withRetry(() => storage.getHRAdmin(data.phoneNumber));
        console.log(`🔍 HR Chatbot status for ${data.phoneNumber}: ${hrAdmin?.chatbotActive === 'false' ? 'PAUSED ⏸️' : 'ACTIVE ✅'}`);

        if (hrAdmin?.chatbotActive === 'false') {
          console.log(`⏸️ HR Chatbot paused for ${data.phoneNumber} - skipping`);
          broadcast('incoming-message', data);
          return;
        }

        // Handle different message types
        const messageType = data.messageType || 'text';

        if (messageType === 'voice_note' || messageType === 'audio') {
          // Voice notes - send to Claude for transcription and processing
          if (data.audioData) {
            console.log(`🎤 Processing voice note from HR Admin ${data.phoneNumber} through Claude`);
            const audioPayload = {
              base64: data.audioData,
              mimetype: data.mediaInfo?.mimetype || 'audio/ogg'
            };
            // Use data.from to preserve @lid format for proper message delivery
            const replyTo = data.from || data.phoneNumber;
            await hrChatbotService.processHRMessage(data.phoneNumber, '[Voice Note]', audioPayload, replyTo);
            broadcast('hr-chatbot-response-sent', { phoneNumber: data.phoneNumber, type: 'voice_processed' });
            broadcast('incoming-message', data);
            return;
          } else {
            // No audio data available (download failed)
            console.log(`🎤 Voice note from HR Admin ${data.phoneNumber} - no audio data, sending acknowledgment`);
            await waSession.sendTextMessage(
              data.from || data.phoneNumber,
              "🎤 I received your voice note but couldn't process it. Please try again or type your message."
            );
            broadcast('hr-chatbot-response-sent', { phoneNumber: data.phoneNumber, type: 'voice_failed' });
            broadcast('incoming-message', data);
            return;
          }
        }

        if (messageType === 'image' || messageType === 'video' || messageType === 'document') {
          // For media, acknowledge but can't process
          console.log(`📎 Media (${messageType}) from HR Admin ${data.phoneNumber} - sending acknowledgment`);
          await waSession.sendTextMessage(
            data.from || data.phoneNumber,
            `📎 I received your ${messageType}! However, I can only process text messages at the moment.\n\nPlease type your request and I'll be happy to help.`
          );
          broadcast('hr-chatbot-response-sent', { phoneNumber: data.phoneNumber, type: 'media_acknowledgment' });
          broadcast('incoming-message', data);
          return;
        }

        // Process text message through HR chatbot
        console.log(`🤖 Processing HR message from ${data.phoneNumber} (org: ${hrAdmin?.organizationName || hrAdmin?.organizationId})`);
        // Use data.from to preserve @lid format for proper message delivery
        const replyTo = data.from || data.phoneNumber;
        await hrChatbotService.processHRMessage(data.phoneNumber, data.content, undefined, replyTo);
        broadcast('hr-chatbot-response-sent', { phoneNumber: data.phoneNumber });
        broadcast('incoming-message', data);
        return;
      }

      // ========================================
      // PRIORITY 1.5: Check if HIMS Patient
      // ========================================
      const himsChatbotService = new HIMSChatbotService(storage, waSession);
      const isHIMSPatient = await withRetry(() => himsChatbotService.isHIMSPatient(data.phoneNumber));

      if (isHIMSPatient) {
        console.log(`🏥 HIMS Patient detected: ${data.phoneNumber} (messageType: ${data.messageType || 'text'})`);

        const himsPatient = await withRetry(() => storage.getHIMSPatient(data.phoneNumber));
        console.log(`🔍 HIMS Chatbot status for ${data.phoneNumber}: ${himsPatient?.chatbotActive === 'false' ? 'PAUSED ⏸️' : 'ACTIVE ✅'}`);

        if (himsPatient?.chatbotActive === 'false') {
          console.log(`⏸️ HIMS Chatbot paused for ${data.phoneNumber} - skipping`);
          broadcast('incoming-message', data);
          return;
        }

        const messageType = data.messageType || 'text';

        if (messageType === 'voice_note' || messageType === 'audio') {
          if (data.audioData) {
            console.log(`🎤 Processing voice note from HIMS Patient ${data.phoneNumber}`);
            const audioPayload = { base64: data.audioData, mimetype: data.mediaInfo?.mimetype || 'audio/ogg' };
            const replyTo = data.from || data.phoneNumber;
            await himsChatbotService.processHIMSMessage(data.phoneNumber, '[Voice Note]', audioPayload, replyTo);
            broadcast('hims-chatbot-response-sent', { phoneNumber: data.phoneNumber, type: 'voice_processed' });
            broadcast('incoming-message', data);
            return;
          } else {
            console.log(`🎤 Voice note from HIMS Patient ${data.phoneNumber} - no audio data`);
            await waSession.sendTextMessage(
              data.from || data.phoneNumber,
              "🎤 I received your voice note but couldn't process it. Please try again or type your message."
            );
            broadcast('hims-chatbot-response-sent', { phoneNumber: data.phoneNumber, type: 'voice_failed' });
            broadcast('incoming-message', data);
            return;
          }
        }

        if (messageType === 'image' || messageType === 'video' || messageType === 'document') {
          console.log(`📎 Media (${messageType}) from HIMS Patient ${data.phoneNumber}`);
          await waSession.sendTextMessage(
            data.from || data.phoneNumber,
            `📎 I received your ${messageType}! I can only process text messages at the moment.\n\nPlease type your request and I'll be happy to help. 🏥`
          );
          broadcast('hims-chatbot-response-sent', { phoneNumber: data.phoneNumber, type: 'media_acknowledgment' });
          broadcast('incoming-message', data);
          return;
        }

        // Process text message through HIMS chatbot
        console.log(`🏥 Processing HIMS message from ${data.phoneNumber} (org: ${himsPatient?.organizationId})`);
        const replyTo = data.from || data.phoneNumber;
        await himsChatbotService.processHIMSMessage(data.phoneNumber, data.content, undefined, replyTo);
        broadcast('hims-chatbot-response-sent', { phoneNumber: data.phoneNumber });
        broadcast('incoming-message', data);
        return;
      }

      // ========================================
      // PRIORITY 2: Check if Lead (LIMS chatbot)
      // ========================================

      // Resolve the session owner's tenant context for per-user config
      let tenantContext: TenantContext | undefined;
      try {
        const ownerUser = await db.select().from(users).where(eq(users.id, ownerUserId)).limit(1);
        if (ownerUser[0]) {
          tenantContext = { organizationId: ownerUser[0].organizationId, userId: ownerUser[0].id };
        }
      } catch (e) {
        console.error('⚠️ Failed to resolve tenant context for incoming message:', e);
      }
      tenantContext = tenantContext || scopedTenant;

      // Initialize lead chatbot service with the session that received the message
      const chatbotService = new ChatbotService(storage, waSession, tenantContext);

      // Check if this phone number is already a lead
      const isAlreadyLead = await withRetry(() => chatbotService.isLead(data.phoneNumber));

      // Check if message contains lead trigger keyword (only flag if not already a lead)
      if (!isAlreadyLead) {
        const triggerKeyword = await chatbotService.detectLeadTrigger(data.content);
        if (triggerKeyword) {
          console.log(`🎯 Lead trigger detected: "${triggerKeyword}" from ${data.phoneNumber}`);
          await withRetry(() => chatbotService.flagAsLead(
            data.phoneNumber,
            triggerKeyword,
            undefined,
            data.from
          ));
          // After flagging and sending greeting, skip processing this message through RAG
          // The greeting is sufficient for first contact
          broadcast('incoming-message', data);
          return;
        }
      }

      // Check if this phone number is a lead
      const isLead = await withRetry(() => chatbotService.isLead(data.phoneNumber));
      console.log(`🔍 Lead check for ${data.phoneNumber}: ${isLead ? 'YES (will process through chatbot)' : 'NO (checking auto-responses)'}`);

      if (isLead) {
        // Check if chatbot is active for this lead
        const contact = await withRetry(() => storage.getContactByTenant(tenantContext!, data.phoneNumber));
        console.log(`🔍 Chatbot status check for ${data.phoneNumber}: ${contact?.chatbotActive === 'false' ? 'PAUSED ⏸️' : 'ACTIVE ✅'} (value: ${contact?.chatbotActive})`);

        if (contact?.chatbotActive === 'false') {
          console.log(`⏸️ Chatbot paused for ${data.phoneNumber} - skipping auto-response`);
          broadcast('incoming-message', data);
          return;
        }

        // Process through chatbot for leads (with voice note support)
        const messageType = data.messageType || 'text';
        if ((messageType === 'voice_note' || messageType === 'audio') && data.audioData) {
          console.log(`🎤 Processing lead voice note from ${data.phoneNumber}`);
          const audioPayload = { base64: data.audioData, mimetype: data.mediaInfo?.mimetype || 'audio/ogg' };
          await chatbotService.processLeadMessage(data.phoneNumber, '[Voice Note]', data.from, audioPayload);
        } else {
          console.log(`🤖 Processing lead message from ${data.phoneNumber}`);
          await chatbotService.processLeadMessage(data.phoneNumber, data.content, data.from);
        }
        broadcast('chatbot-response-sent', { phoneNumber: data.phoneNumber });
      } else {
        // ========================================
        // PRIORITY 3: Check auto-responses for non-leads
        // ========================================
        // Use a tenant-scoped auto-response service for this session owner
        const autoResponseService = new AutoResponseService(storage, tenantContext!, waSession);
        const responded = await withRetry(() =>
          autoResponseService.handleIncomingMessage(
            data.phoneNumber,
            data.content
          )
        );

        if (responded) {
          console.log(`✅ Auto-response sent to ${data.phoneNumber}`);
        }
      }

      // Broadcast to WebSocket clients
      broadcast('incoming-message', data);
    } catch (error) {
      console.error('❌ Failed to handle incoming message:', error);
      console.error('Error details:', {
        phoneNumber: data?.phoneNumber,
        content: data?.content?.substring(0, 50),
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      // Still broadcast the message even if processing failed
      broadcast('incoming-message', data);
    }
  }

  app.post('/api/external/incoming-message', async (req, res) => {
    try {
      const expectedApiKey =
        process.env.WHATSAPP_SYNC_API_KEY ||
        process.env.EXTERNAL_WA_API_KEY ||
        process.env.NOTIFICATION_API_KEY ||
        'whatsapp-lims-secure-api-key-2024';
      const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.toString().replace('Bearer ', '');

      if (apiKey !== expectedApiKey) {
        return res.status(401).json({ success: false, error: 'Invalid API key' });
      }

      const {
        userId,
        sessionName = 'default',
        phoneNumber,
        content,
        from,
        senderPn,
        timestamp,
        messageType = 'text',
        mediaInfo,
        audioData,
      } = req.body || {};

      if (!userId || !phoneNumber || !content) {
        return res.status(400).json({
          success: false,
          error: 'userId, phoneNumber, and content are required',
        });
      }

      await sessionManager.getSession(String(userId), String(sessionName));

      await handleIncomingSessionMessage(String(userId), String(sessionName), {
        phoneNumber: String(phoneNumber),
        content: String(content),
        from: from ? String(from) : undefined,
        senderPn: senderPn ? String(senderPn) : undefined,
        timestamp: timestamp ? Number(timestamp) : Date.now(),
        messageType: String(messageType),
        mediaInfo,
        audioData,
      });

      res.json({ success: true, message: 'Incoming message accepted' });
    } catch (error) {
      console.error('❌ Failed to accept external incoming message:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // API Routes

  // Send text message
  app.post('/api/send-message', requireAuth, async (req, res) => {
    try {
      const validatedData = sendMessageSchema.parse(req.body);
      const waSession = await getUserWASession(req);
      messageService.setWhatsAppService(waSession);
      const message = await messageService.sendTextMessage(
        validatedData.phoneNumber,
        validatedData.content
      );

      res.json({ success: true, message });
    } catch (error) {
      log(`Send message error: ${error.message}`);
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to send message'
      });
    }
  });

  // Send report with file attachment
  app.post('/api/send-report', requireAuth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file provided'
        });
      }

      const validatedData = sendReportSchema.parse(req.body);
      const waSession = await getUserWASession(req);
      messageService.setWhatsAppService(waSession);

      // Save uploaded file with persistent storage for deployment
      const fileInfo = process.env.DATABASE_URL
        ? await persistentFileService.saveFile(req.file)
        : await fileService.saveFile(req.file);

      try {
        // Send report message
        const message = await messageService.sendReportMessage(
          validatedData.phoneNumber,
          fileInfo.filePath,
          fileInfo.fileName,
          fileInfo.size,
          validatedData.sampleId,
          validatedData.content
        );

        // Schedule file cleanup after successful send
        setTimeout(async () => {
          await fileService.deleteFile(fileInfo.filePath);
        }, 5 * 60 * 1000); // Delete after 5 minutes

        res.json({ success: true, message });
      } catch (sendError) {
        // Clean up file if sending failed
        await fileService.deleteFile(fileInfo.filePath);
        throw sendError;
      }
    } catch (error) {
      log(`Send report error: ${error.message}`);
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to send report'
      });
    }
  });

  // Health check endpoint for DigitalOcean with DB verification
  app.get('/api/health', async (req, res) => {
    const startTime = Date.now();
    const dbHealthy = await getDbHealth();
    const dbLatency = Date.now() - startTime;

    const health = {
      success: true,
      message: 'Server is running',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        connected: dbHealthy,
        latency: `${dbLatency}ms`
      }
    };

    // Return 503 if DB is down so load balancer can route away
    res.status(dbHealthy ? 200 : 503).json(health);
  });

  // Get system status
  app.get('/api/status', requireAuth, async (req, res) => {
    try {
      // Get user's session status (or default disconnected)
      const userSession = await sessionManager.getFirstConnectedSession(req.auth!.userId);
      const whatsappStatus = userSession ? userSession.getStatus() : { isConnected: false, isAuthenticated: false };
      const messageStats = await messageService.getMessageStats();
      const systemLogs = await storage.getSystemLogs(10);

      res.json({
        success: true,
        data: {
          whatsapp: whatsappStatus,
          stats: messageStats,
          systemLogs,
          timestamp: new Date().toISOString(),
        }
      });
    } catch (error) {
      log(`Status error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get system status'
      });
    }
  });

  // Get message history
  app.get('/api/messages', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { status, phoneNumber, type, limit = '50', offset = '0', search, campaignId } = req.query;

      const conditions = [
        eq(messagesTable.organizationId, tenant.organizationId),
        eq(messagesTable.userId, tenant.userId),
      ];
      if (status && status !== 'all') conditions.push(eq(messagesTable.status, String(status)));
      if (phoneNumber) conditions.push(eq(messagesTable.phoneNumber, String(phoneNumber)));
      if (type) conditions.push(eq(messagesTable.type, String(type)));

      const parsedLimit = parseInt(limit as string);
      const parsedOffset = parseInt(offset as string);

      const scopedMessages = await db.select().from(messagesTable)
        .where(and(...conditions))
        .orderBy(desc(messagesTable.createdAt));

      let messages = scopedMessages;
      if (campaignId && typeof campaignId === 'string') {
        messages = messages.filter((msg) => {
          const metadata = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata as Record<string, any> : null;
          return metadata?.campaignId === campaignId;
        });
      }

      if (search && typeof search === 'string') {
        const searchLower = search.toLowerCase();
        messages = messages.filter(msg =>
          msg.content.toLowerCase().includes(searchLower) ||
          msg.phoneNumber.includes(search) ||
          (msg.sampleId && msg.sampleId.toLowerCase().includes(searchLower)) ||
          (msg.metadata && typeof msg.metadata === 'object' && JSON.stringify(msg.metadata).toLowerCase().includes(searchLower))
        );
      }
      const total = messages.length;
      messages = messages.slice(parsedOffset, parsedOffset + parsedLimit);

      res.json({
        success: true,
        data: {
          messages,
          total,
          limit: parsedLimit,
          offset: parsedOffset,
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get messages error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get message history'
      });
    }
  });

  // Generate QR code endpoint
  app.post('/api/generate-qr', requireAuth, async (req: Request, res: Response) => {
    try {
      log('Generate QR code request received');
      const sessionName = req.body.sessionName || 'default';
      const waSession = await sessionManager.getSession(req.auth!.userId, sessionName);
      await waSession.generateQRCode();
      res.json({ success: true, message: 'QR code generation started' });
    } catch (error: any) {
      log(`Generate QR error: ${error.message}`);
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to generate QR code'
      });
    }
  });

  // Get current QR code endpoint (fallback for when WebSocket fails)
  app.get('/api/qr-code', requireAuth, async (req: Request, res: Response) => {
    try {
      // Get user's session (default name)
      const waSession = sessionManager.getLoadedSession(req.auth!.userId, 'default');
      const currentQR = waSession?.getCurrentQR();
      if (currentQR && typeof currentQR === 'object' && 'qr' in currentQR) {
        res.json({
          success: true,
          data: {
            qr: currentQR.qr,
            generated: currentQR.timestamp,
            message: 'QR code available for scanning'
          }
        });
      } else {
        res.json({
          success: false,
          message: 'No QR code available. WhatsApp service initializing...'
        });
      }
    } catch (error: any) {
      log(`Get QR error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to get QR code'
      });
    }
  });

  // WhatsApp API endpoints
  app.get('/api/whatsapp/status', requireAuth, async (req, res) => {
    try {
      const userSession = await sessionManager.getFirstConnectedSession(req.auth!.userId);
      const status = userSession ? userSession.getStatus() : { isConnected: false, isAuthenticated: false };
      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`WhatsApp status error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get WhatsApp status'
      });
    }
  });

  app.post('/api/whatsapp/connect', requireAuth, async (req, res) => {
    try {
      const sessionName = req.body.sessionName || 'default';
      const waSession = await sessionManager.getSession(req.auth!.userId, sessionName);
      await waSession.initialize();
      res.json({
        success: true,
        message: 'WhatsApp connection initiated'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`WhatsApp connect error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage || 'Failed to connect to WhatsApp'
      });
    }
  });

  app.post('/api/whatsapp/disconnect', requireAuth, async (req, res) => {
    try {
      const sessionName = req.body.sessionName || 'default';
      await sessionManager.removeSession(req.auth!.userId, sessionName);
      res.json({
        success: true,
        message: 'WhatsApp disconnected successfully'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`WhatsApp disconnect error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage || 'Failed to disconnect from WhatsApp'
      });
    }
  });

  // Diagnostic: check if session files exist and volume is mounted
  app.get('/api/whatsapp/debug/session-files', requireAuth, async (req, res) => {
    try {
      const userId = req.auth!.userId;
      const baseDir = process.env.AUTH_BASE_DIR || path.join(process.cwd(), 'auth');
      const userAuthDir = path.join(baseDir, userId);
      const baseDirExists = fs.existsSync(baseDir);
      const userDirExists = fs.existsSync(userAuthDir);
      const files = userDirExists ? fs.readdirSync(userAuthDir) : [];

      const credsFile = files.find(f => f.startsWith('creds'));
      const sessionFiles = files.filter(f => f.startsWith('session-'));
      const preKeyFiles = files.filter(f => f.startsWith('pre-key-'));

      res.json({
        cwd: process.cwd(),
        authMode: 'file-based (useMultiFileAuthState)',
        authBaseDir: baseDir,
        authBaseDirExists: baseDirExists,
        userAuthDir,
        userAuthDirExists: userDirExists,
        totalFiles: files.length,
        hasCreds: !!credsFile,
        sessionFileCount: sessionFiles.length,
        preKeyFileCount: preKeyFiles.length,
        allFiles: files,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown' });
    }
  });

  // Clear stale Signal protocol sessions (fixes "waiting for this message")
  // Preserves QR auth — no re-scan needed
  app.post('/api/whatsapp/clear-sessions', requireAuth, async (req, res) => {
    try {
      const waSession = await getUserWASession(req);
      const result = await waSession.clearSignalSessions();
      res.json({
        success: true,
        message: `Cleared ${result.cleared} stale session files, kept ${result.kept} auth files. Connection re-initializing...`,
        ...result,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Clear signal sessions error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  app.get('/api/whatsapp/qr', requireAuth, async (req, res) => {
    try {
      // For now, return a placeholder since qrCode isn't in the status type
      // The QR code will be handled via WebSocket events
      res.json({
        success: false,
        error: 'QR code available via WebSocket events only. Use /api/generate-qr endpoint.'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`WhatsApp QR error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get QR code'
      });
    }
  });

  // Resend failed message
  app.post('/api/messages/:id/resend', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const waSession = await getUserWASession(req);
      messageService.setWhatsAppService(waSession);
      const message = await messageService.resendMessage(id);

      res.json({ success: true, message });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Resend message error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage || 'Failed to resend message'
      });
    }
  });

  // Get system logs
  app.get('/api/logs', requireAuth, async (req, res) => {
    try {
      const { limit = '50', offset = '0' } = req.query;
      const logs = await storage.getSystemLogs(
        parseInt(limit as string),
        parseInt(offset as string)
      );

      res.json({ success: true, data: logs });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get logs error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: 'Failed to get system logs'
      });
    }
  });

  // Campaign Routes

  // List campaigns for tenant
  app.get('/api/campaigns', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const campaigns = await campaignService.listCampaigns(tenant, 'campaign');
      res.json({ success: true, data: campaigns });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`List campaigns error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // List campaign templates for tenant
  app.get('/api/campaign-templates', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const templates = await campaignService.listCampaigns(tenant, 'template');
      res.json({ success: true, data: templates });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`List templates error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Create campaign
  app.post('/api/campaigns', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const validatedData = createCampaignSchema.parse(req.body);
      const campaign = await withRetry(() => campaignService.createCampaign(
        validatedData.name,
        validatedData.originalMessage,
        validatedData.campaignType || 'campaign',
        validatedData.fixedParams,
        validatedData.buttons,
        validatedData.includeStopButton,
        tenant
      ));

      res.json({ success: true, data: campaign });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Create campaign error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Upload attachment for campaign
  app.post('/api/campaigns/:campaignId/attachment', requireAuth, upload.single('file'), async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file provided'
        });
      }

      // Save uploaded file
      const fileInfo = process.env.DATABASE_URL
        ? await persistentFileService.saveFile(req.file)
        : await fileService.saveFile(req.file);

      // Update campaign with attachment path
      const campaign = await campaignService.updateCampaignAttachment(
        campaignId,
        fileInfo.filePath,
        fileInfo.fileName,
        tenant
      );

      res.json({ success: true, data: campaign });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Upload attachment error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Download campaign attachment
  app.get('/api/campaigns/:campaignId/attachment/download', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      const campaign = await campaignService.getCampaign(campaignId, tenant);

      if (!campaign || !campaign.attachmentPath) {
        return res.status(404).json({
          success: false,
          error: 'Attachment not found'
        });
      }

      res.download(campaign.attachmentPath, campaign.attachmentName || 'attachment');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Download attachment error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Get campaign
  app.get('/api/campaigns/:campaignId', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      const campaign = await campaignService.getCampaign(campaignId, tenant);

      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }

      res.json({ success: true, data: campaign });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get campaign error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Upload contacts for campaign
  app.post('/api/campaigns/:campaignId/contacts/upload', requireAuth, upload.single('file'), async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file provided'
        });
      }

      // Parse Excel file
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet) as any[];

      // Validate and format contacts
      const contacts = data.map((row: any) => {
        if (!row.name || !row.phone) {
          throw new Error('Invalid file format. Expected columns: name, phone');
        }

        const { name, phone, ...extra } = row;
        return {
          name: String(name),
          phone: String(phone),
          extra,
        };
      });

      // Upload to database
      const result = await campaignService.uploadContacts(campaignId, contacts, tenant);

      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Upload contacts error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  app.post('/api/campaigns/:campaignId/contacts/upload-json', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];

      if (contacts.length === 0) {
        return res.status(400).json({ success: false, error: 'contacts array is required' });
      }

      const normalizedContacts = contacts.map((row: any) => {
        if (!row.phone) {
          throw new Error('Each contact must include a phone number');
        }

        const { name, phone, ...extra } = row;
        return {
          name: String(name || phone),
          phone: String(phone),
          extra,
        };
      });

      const result = await campaignService.uploadContacts(campaignId, normalizedContacts, tenant);
      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Upload JSON contacts error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get contacts for campaign
  app.get('/api/campaigns/:campaignId/contacts', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      const contacts = await campaignService.getContacts(campaignId, tenant);

      res.json({
        success: true,
        data: contacts,
        total: contacts.length
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get contacts error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Save message variation
  app.post('/api/campaigns/:campaignId/variations', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      const { variation } = req.body;

      if (!variation) {
        return res.status(400).json({
          success: false,
          error: 'Variation message is required'
        });
      }

      const saved = await campaignService.saveMessageVariation(campaignId, variation, tenant);
      await campaignService.updateCampaignVariation(campaignId, variation, tenant);

      res.json({ success: true, data: saved });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Save variation error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Get message variations
  app.get('/api/campaigns/:campaignId/variations', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      const variations = await campaignService.getMessageVariations(campaignId, tenant);

      res.json({
        success: true,
        data: variations
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get variations error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Bulk send campaign messages
  app.post('/api/campaigns/:campaignId/send-bulk', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      const validatedData = bulkSendSchema.parse(req.body);

      await db.update(campaignsTable).set({
        defaultIntervalSeconds: validatedData.intervalSeconds ?? 25,
        defaultJitterSeconds: validatedData.jitterSeconds ?? 0,
        runStatus: 'running',
        runStartedAt: new Date(),
        runPausedAt: null,
        runCompletedAt: null,
        runUpdatedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.organizationId, tenant.organizationId),
        eq(campaignsTable.userId, tenant.userId),
      ));

      const result = await campaignService.sendBulkMessages(
        campaignId,
        validatedData.variation_message,
        validatedData.contacts,
        {
          intervalSeconds: validatedData.intervalSeconds,
          jitterSeconds: validatedData.jitterSeconds,
          startFromContact: validatedData.startFromContact,
        },
        tenant
      );

      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Bulk send error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Upload attachment to multi-attachment pool (max 5)
  app.post('/api/campaigns/:campaignId/attachments', requireAuth, upload.single('file'), async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });

      const fileInfo = process.env.DATABASE_URL
        ? await persistentFileService.saveFile(req.file)
        : await fileService.saveFile(req.file);

      const campaign = await campaignService.addAttachmentToPool(campaignId, fileInfo.filePath, tenant);
      res.json({ success: true, data: campaign });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Remove attachment from pool by index
  app.delete('/api/campaigns/:campaignId/attachments/:index', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId, index } = req.params;
      const campaign = await campaignService.removeAttachmentFromPool(campaignId, parseInt(index), tenant);
      res.json({ success: true, data: campaign });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Update custom filenames pool (up to 5)
  app.put('/api/campaigns/:campaignId/attachment-names', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      const { fileNames } = req.body;
      if (!Array.isArray(fileNames)) return res.status(400).json({ success: false, error: 'fileNames must be an array' });
      const campaign = await campaignService.updateAttachmentFileNames(campaignId, fileNames, tenant);
      res.json({ success: true, data: campaign });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Stop a running campaign
  app.post('/api/campaigns/:campaignId/stop', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      campaignService.stopCampaign(campaignId);
      await db.update(campaignsTable).set({
        runStatus: 'stopped',
        runPausedAt: null,
        runCompletedAt: new Date(),
        runUpdatedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.organizationId, tenant.organizationId),
        eq(campaignsTable.userId, tenant.userId),
      ));
      res.json({ success: true, message: 'Stop signal sent' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  app.post('/api/campaigns/:campaignId/pause', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      campaignService.pauseCampaign(campaignId);
      await db.update(campaignsTable).set({
        runStatus: 'paused',
        runPausedAt: new Date(),
        runUpdatedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.organizationId, tenant.organizationId),
        eq(campaignsTable.userId, tenant.userId),
      ));
      res.json({ success: true, message: 'Pause signal sent' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  app.post('/api/campaigns/:campaignId/resume', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      campaignService.resumeCampaign(campaignId);
      await db.update(campaignsTable).set({
        runStatus: 'running',
        runPausedAt: null,
        runUpdatedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.organizationId, tenant.organizationId),
        eq(campaignsTable.userId, tenant.userId),
      ));
      res.json({ success: true, message: 'Resume signal sent' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Schedule campaign for later run
  app.post('/api/campaigns/:campaignId/schedule', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId } = req.params;
      const payload = scheduleCampaignSchema.parse(req.body);

      await db.update(campaignsTable).set({
        defaultIntervalSeconds: payload.intervalSeconds ?? 25,
        defaultJitterSeconds: payload.jitterSeconds ?? 0,
        updatedAt: new Date(),
      }).where(and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.organizationId, tenant.organizationId),
        eq(campaignsTable.userId, tenant.userId),
      ));

      const schedule = await campaignService.scheduleCampaign(
        campaignId,
        payload.variation_message,
        new Date(payload.scheduledAt),
        tenant,
        {
          intervalSeconds: payload.intervalSeconds,
          jitterSeconds: payload.jitterSeconds,
          startFromContact: payload.startFromContact,
        }
      );

      res.json({ success: true, data: schedule });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Schedule campaign error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Cancel a scheduled or running campaign schedule
  app.post('/api/campaign-schedules/:scheduleId/cancel', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { scheduleId } = req.params;
      const updated = await campaignService.cancelSchedule(scheduleId, tenant);
      res.json({ success: true, data: updated });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  app.post('/api/campaign-schedules/:scheduleId/pause', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { scheduleId } = req.params;
      const updated = await campaignService.pauseSchedule(scheduleId, tenant);
      res.json({ success: true, data: updated });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  app.post('/api/campaign-schedules/:scheduleId/resume', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { scheduleId } = req.params;
      const updated = await campaignService.resumeSchedule(scheduleId, tenant);
      res.json({ success: true, data: updated });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // List scheduled campaigns
  app.get('/api/campaign-schedules', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const schedules = await campaignService.listSchedules(tenant);
      res.json({ success: true, data: schedules });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`List schedules error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Get all WhatsApp groups from connected account
  app.get('/api/whatsapp/groups', requireAuth, async (req, res) => {
    try {
      const waSession = await getUserWASession(req);
      const groups = await waSession.listGroups();
      res.json({ success: true, data: groups });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Scrape members from a WhatsApp group
  app.get('/api/whatsapp/groups/:groupId/members', requireAuth, async (req, res) => {
    try {
      const { groupId } = req.params;
      const waSession = await getUserWASession(req);
      const members = await waSession.scrapeGroupNumbers(groupId);
      res.json({ success: true, data: members, total: members.length });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Save user-scoped RAG agent config
  app.post('/api/user-rag-agent', requireAuth, async (req, res) => {
    try {
      const validated = userRagAgentSchema.parse(req.body);
      const tenant = getTenantFromRequest(req);

      const existing = await db.select().from(userRagAgents).where(and(
        eq(userRagAgents.organizationId, tenant.organizationId),
        eq(userRagAgents.userId, tenant.userId)
      )).orderBy(desc(userRagAgents.updatedAt)).limit(1);

      let data;
      if (existing[0]) {
        const [updated] = await db.update(userRagAgents).set({
          agentName: validated.agentName,
          ragBaseUrl: validated.ragBaseUrl,
          ragAccessKey: validated.ragAccessKey,
          systemPrompt: validated.systemPrompt || null,
          triggerKeywords: validated.triggerKeywords || null,
          greetingMessage: validated.greetingMessage || null,
          contextMessageCount: validated.contextMessageCount ?? null,
          replyCooldownSeconds: validated.replyCooldownSeconds ?? null,
          typingDelayMs: validated.typingDelayMs ?? null,
          isActive: validated.isActive === false ? 'false' : 'true',
          updatedAt: new Date(),
        }).where(eq(userRagAgents.id, existing[0].id)).returning();
        data = updated;
      } else {
        const [created] = await db.insert(userRagAgents).values({
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          agentName: validated.agentName,
          ragBaseUrl: validated.ragBaseUrl,
          ragAccessKey: validated.ragAccessKey,
          systemPrompt: validated.systemPrompt || null,
          triggerKeywords: validated.triggerKeywords || null,
          greetingMessage: validated.greetingMessage || null,
          contextMessageCount: validated.contextMessageCount ?? null,
          replyCooldownSeconds: validated.replyCooldownSeconds ?? null,
          typingDelayMs: validated.typingDelayMs ?? null,
          isActive: validated.isActive === false ? 'false' : 'true',
        }).returning();
        data = created;
      }

      res.json({
        success: true,
        data: {
          ...data,
          ragAccessKey: data.ragAccessKey ? `${data.ragAccessKey.slice(0, 4)}...****` : '',
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get user-scoped RAG agent config
  app.get('/api/user-rag-agent', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const result = await db.select().from(userRagAgents).where(and(
        eq(userRagAgents.organizationId, tenant.organizationId),
        eq(userRagAgents.userId, tenant.userId)
      )).orderBy(desc(userRagAgents.updatedAt)).limit(1);

      if (!result[0]) {
        const [fallbackConfig] = await db.select().from(chatbotConfigs)
          .orderBy(desc(chatbotConfigs.updatedAt))
          .limit(1);

        if (!fallbackConfig) {
          return res.json({ success: true, data: null });
        }

        return res.json({
          success: true,
          data: {
            agentName: fallbackConfig.agentName,
            ragBaseUrl: fallbackConfig.ragBaseUrl,
            ragAccessKey: fallbackConfig.ragAccessKey ? `${fallbackConfig.ragAccessKey.slice(0, 4)}...****` : '',
            systemPrompt: fallbackConfig.systemPrompt,
            isActive: fallbackConfig.isActive,
            triggerKeywords: fallbackConfig.triggerKeywords,
            greetingMessage: fallbackConfig.greetingMessage,
            contextMessageCount: fallbackConfig.contextMessageCount,
            replyCooldownSeconds: fallbackConfig.replyCooldownSeconds,
            typingDelayMs: fallbackConfig.typingDelayMs,
          }
        });
      }

      res.json({
        success: true,
        data: {
          ...result[0],
          ragAccessKey: result[0].ragAccessKey ? `${result[0].ragAccessKey.slice(0, 4)}...****` : '',
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  app.get('/api/notification-recipients', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const recipients = await db.select().from(userNotificationRecipients).where(and(
        eq(userNotificationRecipients.organizationId, tenant.organizationId),
        eq(userNotificationRecipients.userId, tenant.userId),
      )).orderBy(desc(userNotificationRecipients.createdAt));

      res.json({ success: true, data: recipients });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  app.post('/api/notification-recipients', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const validated = userNotificationRecipientSchema.parse(req.body);

      const [created] = await db.insert(userNotificationRecipients).values({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        phoneNumber: String(validated.phoneNumber).replace(/\D/g, ''),
        label: validated.label || null,
        notifyOnLeadCreated: validated.notifyOnLeadCreated === false ? 'false' : 'true',
        notifyOnDemoScheduled: validated.notifyOnDemoScheduled === false ? 'false' : 'true',
        notifyOnBookingConfirmed: validated.notifyOnBookingConfirmed === false ? 'false' : 'true',
        isActive: validated.isActive === false ? 'false' : 'true',
      }).returning();

      res.json({ success: true, data: created });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  app.put('/api/notification-recipients/:id', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const validated = userNotificationRecipientSchema.partial().parse(req.body);

      const updateData: any = { updatedAt: new Date() };
      if (validated.phoneNumber !== undefined) updateData.phoneNumber = String(validated.phoneNumber).replace(/\D/g, '');
      if (validated.label !== undefined) updateData.label = validated.label || null;
      if (validated.notifyOnLeadCreated !== undefined) updateData.notifyOnLeadCreated = validated.notifyOnLeadCreated ? 'true' : 'false';
      if (validated.notifyOnDemoScheduled !== undefined) updateData.notifyOnDemoScheduled = validated.notifyOnDemoScheduled ? 'true' : 'false';
      if (validated.notifyOnBookingConfirmed !== undefined) updateData.notifyOnBookingConfirmed = validated.notifyOnBookingConfirmed ? 'true' : 'false';
      if (validated.isActive !== undefined) updateData.isActive = validated.isActive ? 'true' : 'false';

      const [updated] = await db.update(userNotificationRecipients).set(updateData).where(and(
        eq(userNotificationRecipients.id, req.params.id),
        eq(userNotificationRecipients.organizationId, tenant.organizationId),
        eq(userNotificationRecipients.userId, tenant.userId),
      )).returning();

      if (!updated) {
        return res.status(404).json({ success: false, error: 'Notification recipient not found' });
      }

      res.json({ success: true, data: updated });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  app.delete('/api/notification-recipients/:id', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      await db.delete(userNotificationRecipients).where(and(
        eq(userNotificationRecipients.id, req.params.id),
        eq(userNotificationRecipients.organizationId, tenant.organizationId),
        eq(userNotificationRecipients.userId, tenant.userId),
      ));

      res.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // ====== Knowledge Base / RAG File Management ======

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  // Upload a knowledge file (PDF, TXT, CSV, MD)
  app.post('/api/knowledge/upload', requireAuth, upload.single('file'), async (req: any, res) => {
    try {
      const tenant = getTenantFromRequest(req);

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
      }

      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ success: false, error: 'Supabase not configured. Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
      }

      const allowedTypes = ['text/plain', 'text/csv', 'text/markdown', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
      if (!allowedTypes.includes(req.file.mimetype) && !req.file.originalname.match(/\.(txt|csv|md|pdf|docx)$/i)) {
        return res.status(400).json({ success: false, error: 'Unsupported file type. Upload TXT, CSV, MD, PDF, or DOCX files.' });
      }

      // Generate a unique file ID for storage path
      const fileId = crypto.randomUUID();
      const storagePath = `${tenant.organizationId}/${tenant.userId}/${fileId}/${req.file.originalname}`;

      // Upload to Supabase Storage bucket
      const storageRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/knowledge-files/${encodeURIComponent(storagePath)}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': req.file.mimetype,
          },
          body: req.file.buffer,
        }
      );

      if (!storageRes.ok) {
        const err = await storageRes.text();
        throw new Error(`Failed to upload file to storage: ${err}`);
      }

      log(`Knowledge file stored: ${storagePath}`);

      // Create file record in Supabase with storage_path
      const createRes = await fetch(`${SUPABASE_URL}/rest/v1/knowledge_files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'apikey': SUPABASE_SERVICE_KEY,
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({
          id: fileId,
          organization_id: tenant.organizationId,
          user_id: tenant.userId,
          file_name: req.file.originalname,
          file_size: req.file.size,
          mime_type: req.file.mimetype,
          storage_path: storagePath,
          status: 'processing',
        }),
      });

      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`Failed to create file record: ${err}`);
      }

      const [fileRecord] = await createRes.json();
      log(`Knowledge file record created: ${fileRecord.id} (${req.file.originalname})`);

      // Call edge function to process (chunk + embed) — fire and don't wait
      fetch(`${SUPABASE_URL}/functions/v1/process-knowledge-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          file_id: fileRecord.id,
          organization_id: tenant.organizationId,
          user_id: tenant.userId,
          storage_path: storagePath,
          file_name: req.file.originalname,
          mime_type: req.file.mimetype,
        }),
      }).then(async (r) => {
        if (!r.ok) log(`Knowledge file processing failed: ${await r.text()}`);
        else log(`Knowledge file processed: ${fileRecord.id}`);
      }).catch((err) => log(`Knowledge file processing error: ${err.message}`));

      res.json({
        success: true,
        data: {
          id: fileRecord.id,
          fileName: req.file.originalname,
          fileSize: req.file.size,
          status: 'processing',
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Knowledge upload error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // List user's knowledge files
  app.get('/api/knowledge/files', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);

      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ success: false, error: 'Supabase not configured' });
      }

      const listRes = await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_files?organization_id=eq.${encodeURIComponent(tenant.organizationId)}&user_id=eq.${encodeURIComponent(tenant.userId)}&order=created_at.desc`,
        {
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
          },
        }
      );

      if (!listRes.ok) {
        throw new Error(`Failed to list files: ${await listRes.text()}`);
      }

      const files = await listRes.json();
      res.json({ success: true, data: files });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Delete a knowledge file (and its chunks via CASCADE)
  app.delete('/api/knowledge/files/:fileId', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { fileId } = req.params;

      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ success: false, error: 'Supabase not configured' });
      }

      // Verify ownership and get storage_path
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_files?id=eq.${encodeURIComponent(fileId)}&organization_id=eq.${encodeURIComponent(tenant.organizationId)}&user_id=eq.${encodeURIComponent(tenant.userId)}&select=id,storage_path`,
        {
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
          },
        }
      );

      const existing = await checkRes.json();
      if (!existing || existing.length === 0) {
        return res.status(404).json({ success: false, error: 'File not found' });
      }

      // Delete from storage bucket if path exists
      if (existing[0].storage_path) {
        await fetch(
          `${SUPABASE_URL}/storage/v1/object/knowledge-files/${encodeURIComponent(existing[0].storage_path)}`,
          {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
          }
        ).catch((err: any) => log(`Storage delete warning: ${err.message}`));
      }

      // Delete DB record (CASCADE will remove chunks too)
      const delRes = await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_files?id=eq.${encodeURIComponent(fileId)}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
          },
        }
      );

      if (!delRes.ok) {
        throw new Error(`Failed to delete file: ${await delRes.text()}`);
      }

      log(`Knowledge file deleted: ${fileId}`);
      res.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Retry processing a failed knowledge file (re-reads from storage)
  app.post('/api/knowledge/files/:fileId/retry', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { fileId } = req.params;

      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ success: false, error: 'Supabase not configured' });
      }

      // Verify ownership and get file info
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_files?id=eq.${encodeURIComponent(fileId)}&organization_id=eq.${encodeURIComponent(tenant.organizationId)}&user_id=eq.${encodeURIComponent(tenant.userId)}`,
        {
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
          },
        }
      );

      const existing = await checkRes.json();
      if (!existing || existing.length === 0) {
        return res.status(404).json({ success: false, error: 'File not found' });
      }

      const file = existing[0];
      if (!file.storage_path) {
        return res.status(400).json({ success: false, error: 'File has no storage path — please re-upload' });
      }

      // Delete any existing chunks from previous failed attempt
      await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_chunks?file_id=eq.${encodeURIComponent(fileId)}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
          },
        }
      );

      // Reset status to processing
      await fetch(
        `${SUPABASE_URL}/rest/v1/knowledge_files?id=eq.${encodeURIComponent(fileId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
          },
          body: JSON.stringify({ status: 'processing', error_message: null, chunk_count: 0 }),
        }
      );

      // Re-trigger edge function — it will fetch file from storage
      fetch(`${SUPABASE_URL}/functions/v1/process-knowledge-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          file_id: fileId,
          organization_id: tenant.organizationId,
          user_id: tenant.userId,
          storage_path: file.storage_path,
          file_name: file.file_name,
          mime_type: file.mime_type,
        }),
      }).then(async (r) => {
        if (!r.ok) log(`Knowledge file retry processing failed: ${await r.text()}`);
        else log(`Knowledge file retry processed: ${fileId}`);
      }).catch((err) => log(`Knowledge file retry error: ${err.message}`));

      log(`Knowledge file retry initiated: ${fileId}`);
      res.json({ success: true, data: { id: fileId, status: 'processing' } });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // RAG Chat — call Supabase edge function for knowledge-augmented response
  app.post('/api/knowledge/chat', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { message, conversation_history, system_prompt } = req.body;

      if (!message) {
        return res.status(400).json({ success: false, error: 'Message is required' });
      }

      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ success: false, error: 'Supabase not configured' });
      }

      const ragRes = await fetch(`${SUPABASE_URL}/functions/v1/rag-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          organization_id: tenant.organizationId,
          user_id: tenant.userId,
          message,
          conversation_history: conversation_history || [],
          system_prompt: system_prompt || undefined,
        }),
      });

      if (!ragRes.ok) {
        const err = await ragRes.text();
        throw new Error(`RAG chat failed: ${err}`);
      }

      const result = await ragRes.json();
      res.json({ success: true, data: result });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`RAG chat error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Block a phone number
  app.post('/api/blocklist/add', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { phoneNumber, reason } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'Phone number is required' });
      }

      await storage.addToBlocklistForTenant(tenant, phoneNumber, reason || 'user_requested');

      log(`Blocked number: ${phoneNumber}`);
      res.json({ success: true, message: 'Number blocked successfully' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Block number error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Unblock a phone number
  app.post('/api/blocklist/remove', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { phoneNumber } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'Phone number is required' });
      }

      await storage.removeFromBlocklistForTenant(tenant, phoneNumber);

      log(`Unblocked number: ${phoneNumber}`);
      res.json({ success: true, message: 'Number unblocked successfully' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Unblock number error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Check if number is blocked
  app.get('/api/blocklist/check/:phoneNumber', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { phoneNumber } = req.params;
      const isBlocked = await storage.isNumberBlockedForTenant(tenant, phoneNumber);

      res.json({ isBlocked });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Check blocklist error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get all blocked numbers
  app.get('/api/blocklist', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const blockedNumbers = await storage.getBlockedNumbersByTenant(tenant);
      res.json(blockedNumbers);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get blocklist error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Auto-response routes

  // Get all auto-responses (active only)
  app.get('/api/auto-responses', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const autoResponses = await storage.getAutoResponsesByTenant(tenant);
      res.json(autoResponses);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get auto-responses error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get all auto-responses (including inactive)
  app.get('/api/auto-responses/all', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const autoResponses = await withRetry(() => storage.getAllAutoResponsesByTenant(tenant));
      res.json(autoResponses);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : '';
      log(`Get all auto-responses error: ${errorMessage}`);
      console.error('Full error:', error);
      console.error('Stack:', errorStack);
      res.status(500).json({ success: false, error: errorMessage || 'Failed to get auto-responses' });
    }
  });

  // Create new auto-response
  app.post('/api/auto-responses', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { keyword, response, isActive } = req.body;

      if (!keyword || !response) {
        return res.status(400).json({
          success: false,
          error: 'Keyword and response are required'
        });
      }

      const autoResponse = await withRetry(() => storage.createAutoResponseForTenant(tenant, {
        keyword,
        response,
        isActive: isActive !== false, // Default to true
      }));

      res.json({ success: true, autoResponse });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : '';
      log(`Create auto-response error: ${errorMessage}`);
      console.error('Full error:', error);
      console.error('Stack:', errorStack);
      res.status(500).json({ success: false, error: errorMessage || 'Failed to create auto-response' });
    }
  });

  // Update auto-response
  app.put('/api/auto-responses/:id', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { id } = req.params;
      const { keyword, response, isActive } = req.body;

      const autoResponse = await withRetry(() => storage.updateAutoResponseForTenant(tenant, id, {
        keyword,
        response,
        isActive,
      }));

      if (!autoResponse) {
        return res.status(404).json({
          success: false,
          error: 'Auto-response not found'
        });
      }

      res.json({ success: true, autoResponse });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Update auto-response error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Delete auto-response
  app.delete('/api/auto-responses/:id', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { id } = req.params;
      await withRetry(() => storage.deleteAutoResponseForTenant(tenant, id));
      res.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Delete auto-response error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get recent incoming messages
  app.get('/api/incoming-messages', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const limit = parseInt(req.query.limit as string) || 50;
      const scopedMessages = await db.select().from(messagesTable)
        .where(and(
          eq(messagesTable.organizationId, tenant.organizationId),
          eq(messagesTable.userId, tenant.userId),
          eq(messagesTable.type, 'incoming'),
        ))
        .orderBy(desc(messagesTable.createdAt))
        .limit(limit);
      res.json(scopedMessages);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : '';
      log(`Get incoming messages error: ${errorMessage}`);
      console.error('Full error:', error);
      console.error('Stack:', errorStack);
      res.status(500).json({ success: false, error: errorMessage || 'Failed to get incoming messages' });
    }
  });

  // ==================== CHATBOT & LEADS API ====================

  // Get chatbot configuration
  app.get('/api/chatbot/config', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const [config] = await db.select().from(userRagAgents).where(and(
        eq(userRagAgents.organizationId, tenant.organizationId),
        eq(userRagAgents.userId, tenant.userId),
      )).orderBy(desc(userRagAgents.updatedAt)).limit(1);

      if (!config) {
        const [fallbackConfig] = await db.select().from(chatbotConfigs)
          .orderBy(desc(chatbotConfigs.updatedAt))
          .limit(1);

        if (!fallbackConfig) {
          return res.json({
            success: true,
            config: null,
          });
        }

        return res.json({
          success: true,
          config: {
            ...fallbackConfig,
            ragAccessKey: fallbackConfig.ragAccessKey
              ? `${fallbackConfig.ragAccessKey.substring(0, 4)}...${fallbackConfig.ragAccessKey.substring(fallbackConfig.ragAccessKey.length - 4)}`
              : '',
          },
        });
      }

      // Mask the access key for security
      const maskedConfig = {
        ...config,
        ragAccessKey: config.ragAccessKey ? `${config.ragAccessKey.substring(0, 4)}...${config.ragAccessKey.substring(config.ragAccessKey.length - 4)}` : '',
      };

      res.json({
        success: true,
        config: maskedConfig,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get chatbot config error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Update chatbot configuration
  app.put('/api/chatbot/config', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const validation = chatbotConfigSchema.safeParse(req.body);

      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: validation.error.errors[0].message,
        });
      }

      const { agentName, triggerKeywords, ragBaseUrl, ragAccessKey, systemPrompt, greetingMessage, contextMessageCount, replyCooldownSeconds, typingDelayMs, isActive } = validation.data;

      const existing = await db.select().from(userRagAgents).where(and(
        eq(userRagAgents.organizationId, tenant.organizationId),
        eq(userRagAgents.userId, tenant.userId),
      )).orderBy(desc(userRagAgents.updatedAt)).limit(1);

      let config;
      if (existing[0]) {
        const [updated] = await db.update(userRagAgents).set({
          agentName,
          ragBaseUrl,
          ragAccessKey,
          systemPrompt: systemPrompt || null,
          triggerKeywords: triggerKeywords || [],
          greetingMessage: greetingMessage || null,
          contextMessageCount: contextMessageCount ?? null,
          replyCooldownSeconds: replyCooldownSeconds ?? null,
          typingDelayMs: typingDelayMs ?? null,
          isActive: typeof isActive === 'boolean' ? (isActive ? 'true' : 'false') : existing[0].isActive,
          updatedAt: new Date(),
        }).where(eq(userRagAgents.id, existing[0].id)).returning();
        config = updated;
      } else {
        const [created] = await db.insert(userRagAgents).values({
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          agentName,
          ragBaseUrl,
          ragAccessKey,
          systemPrompt: systemPrompt || null,
          triggerKeywords: triggerKeywords || [],
          greetingMessage: greetingMessage || null,
          contextMessageCount: contextMessageCount ?? null,
          replyCooldownSeconds: replyCooldownSeconds ?? null,
          typingDelayMs: typingDelayMs ?? null,
          isActive: typeof isActive === 'boolean' ? (isActive ? 'true' : 'false') : 'true',
        }).returning();
        config = created;
      }

      // Mask the access key in response
      const maskedConfig = {
        ...config,
        ragAccessKey: config.ragAccessKey ? `${config.ragAccessKey.substring(0, 4)}...${config.ragAccessKey.substring(config.ragAccessKey.length - 4)}` : '',
      };

      res.json({
        success: true,
        config: maskedConfig,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Update chatbot config error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Test chatbot RAG endpoint connection
  app.post('/api/chatbot/test', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const [config] = await db.select().from(userRagAgents).where(and(
        eq(userRagAgents.organizationId, tenant.organizationId),
        eq(userRagAgents.userId, tenant.userId),
      )).orderBy(desc(userRagAgents.updatedAt)).limit(1);

      if (!config) {
        return res.status(400).json({
          success: false,
          error: 'Chatbot not configured. Please save configuration first.',
        });
      }

      const waSession = await getUserWASession(req);
      const chatbotService = new ChatbotService(storage, waSession, tenant);
      const result = await chatbotService.testConnection(config as any);

      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Test chatbot connection error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        message: `Test failed: ${errorMessage}`,
      });
    }
  });

  app.get('/api/campaign-runs', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const runs = campaignService.listLiveRuns(tenant);
      res.json({ success: true, data: runs });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  app.get('/api/contacts', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const search = String(req.query.search || '').trim().toLowerCase();
      let result = await storage.getContactsByTenant(tenant);

      if (search) {
        result = result.filter((contact) =>
          (contact.name || '').toLowerCase().includes(search) ||
          contact.phoneNumber.includes(search)
        );
      }

      res.json({ success: true, data: result, total: result.length });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  app.post('/api/contacts/add-to-campaign', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { campaignId, contactIds } = req.body as { campaignId?: string; contactIds?: string[] };

      if (!campaignId || !Array.isArray(contactIds) || contactIds.length === 0) {
        return res.status(400).json({ success: false, error: 'campaignId and contactIds are required' });
      }

      const tenantContacts = await storage.getContactsByTenant(tenant);
      const selectedContacts = tenantContacts
        .filter((contact) => contactIds.includes(contact.id))
        .map((contact) => ({
          name: contact.name || contact.phoneNumber,
          phone: contact.phoneNumber,
          extra: {},
        }));

      if (selectedContacts.length === 0) {
        return res.status(400).json({ success: false, error: 'No matching contacts found' });
      }

      const result = await campaignService.uploadContacts(campaignId, selectedContacts, tenant);
      res.json({ success: true, data: result });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Inbound webhook: create/update lead from external source (forms, automations, CRMs)
  app.post('/api/webhooks/leads', async (req, res) => {
    try {
      if (!hasExplicitTenantInRequest(req)) {
        return res.status(400).json({
          success: false,
          error: 'organizationId and userId are required for webhook lead routing',
        });
      }

      const expectedSecret = process.env.LEAD_WEBHOOK_SECRET;
      if (expectedSecret) {
        const providedSecret = firstNonEmpty(
          req.headers['x-webhook-secret'],
          req.headers['x-lead-webhook-secret'],
          req.query.secret
        );
        if (!providedSecret || providedSecret !== expectedSecret) {
          return res.status(401).json({
            success: false,
            error: 'Invalid webhook secret',
          });
        }
      }

      const bodySchema = z.record(z.any());
      const bodyValidation = bodySchema.safeParse(req.body);
      if (!bodyValidation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid webhook payload',
        });
      }

      const parsedLead = parseWebhookLeadBody(bodyValidation.data);
      const phoneInfo = normalizeWebhookLeadPhone(parsedLead.phoneRaw);
      const normalizedPhone = phoneInfo.normalizedPhone;

      const tenant = getTenantFromRequest(req);
      const existingContact = await withRetry(() => storage.getContactByTenant(tenant, normalizedPhone));
      const sourceLabel = parsedLead.source || 'Webhook Lead';
      const triggerKeyword = `Webhook: ${sourceLabel}`;

      // Avoid duplicate lead entries / duplicate greeting for existing leads.
      if (existingContact?.isLead === 'true') {
        if (parsedLead.name || parsedLead.email || parsedLead.labStatus || parsedLead.launchTimeline) {
          await withRetry(() => storage.createMessage({
            phoneNumber: existingContact.phoneNumber,
            content: [
              `Lead Update (${sourceLabel})`,
              parsedLead.name ? `Name: ${parsedLead.name}` : '',
              parsedLead.email ? `Email: ${parsedLead.email}` : '',
              parsedLead.labStatus ? `Status: ${parsedLead.labStatus}` : '',
              parsedLead.launchTimeline ? `Launch Timeline: ${parsedLead.launchTimeline}` : '',
            ].filter(Boolean).join('\n'),
            type: 'incoming',
            status: 'received',
            organizationId: tenant.organizationId,
            userId: tenant.userId,
            metadata: {
              webhook_lead: true,
              duplicate_lead_update: true,
              source: parsedLead.source || null,
              phone_normalization: phoneInfo,
            },
          }));
        }

        return res.json({
          success: true,
          action: 'duplicate_lead_ignored',
          message: 'Lead already exists. No new lead created.',
          contact: existingContact,
          normalizedPhone,
          phoneNormalization: phoneInfo,
        });
      }

      const connectedSession = sessionManager.getLoadedSession(tenant.userId, 'default') || await sessionManager.getFirstConnectedSession(tenant.userId);
      if (!connectedSession) {
        return res.status(503).json({ success: false, error: 'No connected WhatsApp session available to send greeting' });
      }
      const chatbotService = new ChatbotService(storage, connectedSession, tenant);
      const contact = await withRetry(() => chatbotService.flagAsLead(
        normalizedPhone,
        triggerKeyword,
        parsedLead.name
      ));

      await withRetry(() => storage.createMessage({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        phoneNumber: normalizedPhone,
        content: [
          `New Lead Generated`,
          `Source: ${sourceLabel}`,
          parsedLead.name ? `Name: ${parsedLead.name}` : '',
          `Phone: ${normalizedPhone}`,
          parsedLead.email ? `Email: ${parsedLead.email}` : 'Email: Not specified',
          parsedLead.labStatus ? `Status: ${parsedLead.labStatus}` : '',
          parsedLead.launchTimeline ? `Launch Timeline: ${parsedLead.launchTimeline}` : '',
        ].filter(Boolean).join('\n'),
        type: 'incoming',
        status: 'received',
        metadata: {
          webhook_lead: true,
          source: parsedLead.source || null,
          email: parsedLead.email || null,
          lab_status: parsedLead.labStatus || null,
          launch_timeline: parsedLead.launchTimeline || null,
          phone_normalization: phoneInfo,
        },
      }));

      res.json({
        success: true,
        action: 'new_lead_created',
        contact,
        normalizedPhone,
        phoneNormalization: phoneInfo,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Lead webhook error: ${errorMessage}`);
      res.status(400).json({
        success: false,
        error: errorMessage,
      });
    }
  });

  // Get all leads (tenant-scoped)
  app.get('/api/leads', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const leads = await withRetry(() => storage.getLeadsByTenant(tenant, { limit, offset }));

      res.json({
        success: true,
        leads,
        count: leads.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get leads error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Get lead details with conversation (tenant-scoped)
  app.get('/api/leads/:phoneNumber/conversation', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { phoneNumber } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;

      const contact = await withRetry(() => storage.getContactByTenant(tenant, phoneNumber));
      const conversation = await withRetry(() => storage.getConversationHistoryByTenant(tenant, phoneNumber, limit));

      res.json({
        success: true,
        contact,
        conversation: conversation.reverse(), // Return chronologically (oldest first)
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get lead conversation error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Manually flag a number as lead
  app.post('/api/leads/flag', requireAuth, async (req, res) => {
    try {
      const validation = flagLeadSchema.safeParse(req.body);

      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: validation.error.errors[0].message,
        });
      }

      const { phoneNumber, keyword, name } = validation.data;

      // Create chatbot service instance
      const waSession = await getUserWASession(req);
      const tenant = getTenantFromRequest(req);
      const chatbotService = new ChatbotService(storage, waSession, tenant);

      // Use chatbot service to flag lead (sends greeting message automatically)
      const contact = await withRetry(() => chatbotService.flagAsLead(
        phoneNumber,
        keyword || 'Manual flag',
        name
      ));

      res.json({
        success: true,
        contact,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Flag lead error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Delete/unflag lead (tenant-scoped)
  app.delete('/api/leads/:phoneNumber', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { phoneNumber } = req.params;

      // Unflag the contact (set isLead to false)
      await withRetry(() => storage.updateContactByTenant(tenant, phoneNumber, {
        isLead: 'false',
        leadTriggerKeyword: null,
      }));

      res.json({
        success: true,
        message: 'Lead removed successfully',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Delete lead error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Toggle chatbot active status for a lead (tenant-scoped)
  app.patch('/api/leads/:phoneNumber/chatbot-status', requireAuth, async (req, res) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { phoneNumber } = req.params;
      const { active } = req.body;

      if (typeof active !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'active field must be a boolean',
        });
      }

      await withRetry(() => storage.updateContactByTenant(tenant, phoneNumber, {
        chatbotActive: active ? 'true' : 'false',
      }));

      res.json({
        success: true,
        message: `Chatbot ${active ? 'enabled' : 'paused'} for this lead`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Toggle chatbot status error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Pause / resume chatbot for a lead — called by the CRM Netlify functions.
  // Protected by the same NOTIFICATION_API_KEY used for WhatsApp notifications.
  // Body: { phoneNumber: string, active: boolean }
  // phoneNumber must be in 91XXXXXXXXXX format (digits only, no @).
  app.post('/api/demo-chatbot-pause', async (req, res) => {
    try {
      // Reuse the notification API key guard already defined below
      const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
      const expectedKey = process.env.NOTIFICATION_API_KEY || 'whatsapp-notification-secret-key';
      if (apiKey !== expectedKey) {
        return res.status(401).json({ success: false, error: 'Invalid API key' });
      }

      if (!hasExplicitTenantInRequest(req)) {
        return res.status(400).json({ success: false, error: 'organizationId and userId are required' });
      }

      const { phoneNumber, active } = req.body;
      const tenant = getTenantFromRequest(req);
      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'phoneNumber is required' });
      }

      const newState = active === true ? 'true' : 'false';
      await withRetry(() => storage.updateContactByTenant(tenant, phoneNumber, {
        chatbotActive: newState,
      }));

      log(`🎛️ demo-chatbot-pause: ${phoneNumber} → chatbotActive=${newState}`);
      res.json({
        success: true,
        message: `Chatbot ${active ? 'resumed' : 'paused'} for ${phoneNumber}`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`demo-chatbot-pause error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Send a plain WhatsApp text message — called by the CRM demo-reminder scheduler.
  // Protected by NOTIFICATION_API_KEY.  Does NOT require HR admin org lookup.
  // Body: { phoneNumber: string, message: string }
  // phoneNumber: 91XXXXXXXXXX digits-only; WhatsAppService resolves @lid or @s.whatsapp.net.
  app.post('/api/demo-reminder-send', async (req, res) => {
    try {
      const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
      const expectedKey = process.env.NOTIFICATION_API_KEY || 'whatsapp-notification-secret-key';
      if (apiKey !== expectedKey) {
        return res.status(401).json({ success: false, error: 'Invalid API key' });
      }

      const { phoneNumber, message } = req.body;
      if (!phoneNumber || !message) {
        return res.status(400).json({ success: false, error: 'phoneNumber and message are required' });
      }

      // Normalise to digits (WhatsAppService.resolveOutgoingJid will handle LID vs @s.whatsapp.net)
      let digits = String(phoneNumber).replace(/\D/g, '');
      if (digits.length === 10) digits = `91${digits}`;

      log(`📤 demo-reminder-send → ${digits}: ${String(message).substring(0, 60)}...`);
      const connectedSession = sessionManager.getAnyConnectedSession();
      if (!connectedSession) {
        return res.status(503).json({ success: false, error: 'No connected WhatsApp session available' });
      }
      await connectedSession.service.sendTextMessage(digits, String(message));

      res.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`demo-reminder-send error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // ==================== END CHATBOT & LEADS API ====================

  // ==================== HR ADMIN & HR CHATBOT API ====================

  // Get HR chatbot config
  app.get('/api/hr-chatbot/config', requireAuth, async (req, res) => {
    try {
      const config = await withRetry(() => storage.getHRChatbotConfig());

      if (!config) {
        return res.json({
          success: true,
          config: null,
          message: 'HR chatbot not configured yet',
        });
      }

      // Mask sensitive keys
      const maskedConfig = {
        ...config,
        ragAccessKey: config.ragAccessKey ? `${config.ragAccessKey.substring(0, 4)}...${config.ragAccessKey.substring(config.ragAccessKey.length - 4)}` : '',
        supabaseServiceKey: config.supabaseServiceKey ? '****' : '',
      };

      res.json({
        success: true,
        config: maskedConfig,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get HR chatbot config error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Update HR chatbot config
  app.put('/api/hr-chatbot/config', requireAuth, async (req, res) => {
    try {
      const validation = hrChatbotConfigSchema.safeParse(req.body);

      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: validation.error.errors[0].message,
        });
      }

      const config = await withRetry(() => storage.updateHRChatbotConfig({
        agentName: validation.data.agentName,
        ragBaseUrl: validation.data.ragBaseUrl,
        ragAccessKey: validation.data.ragAccessKey,
        supabaseUrl: validation.data.supabaseUrl,
        supabaseServiceKey: validation.data.supabaseServiceKey,
        contextMessageCount: validation.data.contextMessageCount,
        isActive: validation.data.isActive,
      }));

      // Mask sensitive keys in response
      const maskedConfig = {
        ...config,
        ragAccessKey: config.ragAccessKey ? `${config.ragAccessKey.substring(0, 4)}...****` : '',
        supabaseServiceKey: '****',
      };

      res.json({
        success: true,
        config: maskedConfig,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Update HR chatbot config error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Test HR chatbot connection
  app.post('/api/hr-chatbot/test', requireAuth, async (req, res) => {
    try {
      const config = await withRetry(() => storage.getHRChatbotConfig());

      if (!config) {
        return res.status(400).json({
          success: false,
          error: 'HR Chatbot not configured. Please save configuration first.',
        });
      }

      const waSession = await getUserWASession(req);
      const hrChatbotService = new HRChatbotService(storage, waSession);
      const result = await hrChatbotService.testConnection(config);

      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Test HR chatbot connection error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        message: `Test failed: ${errorMessage}`,
      });
    }
  });

  // Get all HR admins
  app.get('/api/hr-admins', requireAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const hrAdmins = await withRetry(() => storage.getHRAdmins({ limit, offset }));

      res.json({
        success: true,
        hrAdmins,
        count: hrAdmins.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get HR admins error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Register new HR admin (link WhatsApp number to Task Management user)
  app.post('/api/hr-admins', requireAuth, async (req, res) => {
    try {
      const validation = registerHRAdminSchema.safeParse(req.body);

      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: validation.error.errors[0].message,
        });
      }

      const { phoneNumber, name, organizationId, userId, organizationName } = validation.data;

      // Create HR admin
      const hrAdmin = await withRetry(() => storage.createHRAdmin({
        phoneNumber,
        name,
        organizationId,
        userId,
        organizationName,
      }));

      // Optionally send welcome message
      try {
        const waSession = await getUserWASession(req);
        const hrChatbotService = new HRChatbotService(storage, waSession);
        await hrChatbotService.sendWelcomeMessage(hrAdmin);
      } catch (welcomeError) {
        console.log(`⚠️ Failed to send welcome message to HR admin: ${welcomeError}`);
      }

      res.json({
        success: true,
        hrAdmin,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Register HR admin error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get HR admin details with conversation
  app.get('/api/hr-admins/:phoneNumber/conversation', requireAuth, async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;

      const hrAdmin = await withRetry(() => storage.getHRAdmin(phoneNumber));
      const conversation = await withRetry(() => storage.getConversationHistory(phoneNumber, limit));

      res.json({
        success: true,
        hrAdmin,
        conversation: conversation.reverse(), // Return chronologically (oldest first)
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get HR admin conversation error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Delete HR admin
  app.delete('/api/hr-admins/:phoneNumber', requireAuth, async (req, res) => {
    try {
      const { phoneNumber } = req.params;

      await withRetry(() => storage.deleteHRAdmin(phoneNumber));

      res.json({
        success: true,
        message: 'HR admin removed successfully',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Delete HR admin error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Toggle HR chatbot active status for an admin
  app.patch('/api/hr-admins/:phoneNumber/chatbot-status', requireAuth, async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const { active } = req.body;

      if (typeof active !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'active field must be a boolean',
        });
      }

      await withRetry(() => storage.updateHRAdmin(phoneNumber, {
        chatbotActive: active ? 'true' : 'false',
      }));

      res.json({
        success: true,
        message: `HR Chatbot ${active ? 'enabled' : 'paused'} for this admin`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Toggle HR chatbot status error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // ==================== END HR ADMIN API ====================

  // ==================== HIMS PATIENT API ====================

  // List all HIMS patients
  app.get('/api/hims-patients', requireAuth, async (req, res) => {
    try {
      const orgId = req.query.organizationId as string | undefined;
      const patients = orgId
        ? await withRetry(() => storage.getHIMSPatientsByOrganization(orgId))
        : await withRetry(() => storage.getAllHIMSPatients());

      res.json({ success: true, patients, count: patients.length });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get HIMS patients error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Register a new HIMS patient (link WhatsApp number to HIMS org)
  app.post('/api/hims-patients', requireAuth, async (req, res) => {
    try {
      const validation = registerHIMSPatientSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ success: false, error: validation.error.errors[0].message });
      }

      const { phoneNumber, name, organizationId, systemPrompt, triggerKeywords, greetingMessage } = validation.data;

      const patient = await withRetry(() => storage.createHIMSPatient({
        phoneNumber,
        name,
        organizationId,
        systemPrompt,
        triggerKeywords,
        greetingMessage,
      }));

      // Optionally send welcome message
      try {
        const waSession = await getUserWASession(req);
        const himsChatbotService = new HIMSChatbotService(storage, waSession);
        await himsChatbotService.sendWelcomeMessage(patient);
      } catch (welcomeError) {
        console.log(`⚠️ Failed to send HIMS welcome message: ${welcomeError}`);
      }

      res.json({ success: true, patient });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Register HIMS patient error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Get HIMS patient conversation history
  app.get('/api/hims-patients/:phoneNumber/conversation', requireAuth, async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;

      const patient = await withRetry(() => storage.getHIMSPatient(phoneNumber));
      const conversation = await withRetry(() => storage.getConversationHistory(phoneNumber, limit));

      res.json({
        success: true,
        patient,
        conversation: conversation.reverse(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Get HIMS patient conversation error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Delete HIMS patient
  app.delete('/api/hims-patients/:phoneNumber', requireAuth, async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      await withRetry(() => storage.deleteHIMSPatient(phoneNumber));
      res.json({ success: true, message: 'HIMS patient removed successfully' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Delete HIMS patient error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Toggle HIMS chatbot active status
  app.patch('/api/hims-patients/:phoneNumber/chatbot-status', requireAuth, async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const { active } = req.body;

      if (typeof active !== 'boolean') {
        return res.status(400).json({ success: false, error: 'active field must be a boolean' });
      }

      await withRetry(() => storage.updateHIMSPatient(phoneNumber, {
        chatbotActive: active ? 'true' : 'false',
      }));

      res.json({
        success: true,
        message: `HIMS Chatbot ${active ? 'enabled' : 'paused'} for this patient`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Toggle HIMS chatbot status error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Update HIMS patient details (system prompt, keywords, greeting)
  app.patch('/api/hims-patients/:phoneNumber', requireAuth, async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const { name, systemPrompt, triggerKeywords, greetingMessage } = req.body;

      const updated = await withRetry(() => storage.updateHIMSPatient(phoneNumber, {
        ...(name !== undefined && { name }),
        ...(systemPrompt !== undefined && { systemPrompt }),
        ...(triggerKeywords !== undefined && { triggerKeywords }),
        ...(greetingMessage !== undefined && { greetingMessage }),
      }));

      if (!updated) {
        return res.status(404).json({ success: false, error: 'HIMS patient not found' });
      }

      res.json({ success: true, patient: updated });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Update HIMS patient error: ${errorMessage}`);
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // ==================== END HIMS PATIENT API ====================

  // ==================== NOTIFICATION API ====================

  // Verify API key for notification endpoints
  const NOTIFICATION_API_KEY = process.env.NOTIFICATION_API_KEY || 'whatsapp-notification-secret-key';

  const verifyNotificationApiKey = (req: any, res: any): boolean => {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (apiKey !== NOTIFICATION_API_KEY) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return false;
    }
    return true;
  };

  // Check if an organization is enabled for WhatsApp notifications
  app.get('/api/org-whatsapp-enabled/:organizationId', async (req, res) => {
    try {
      if (!verifyNotificationApiKey(req, res)) return;

      const { organizationId } = req.params;
      const orgAdmins = await storage.getHRAdminsByOrganization(organizationId);

      res.json({
        success: true,
        enabled: orgAdmins && orgAdmins.length > 0,
        adminCount: orgAdmins?.length || 0,
        organizationId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Get all organizations enabled for WhatsApp
  app.get('/api/whatsapp-enabled-orgs', async (req, res) => {
    try {
      if (!verifyNotificationApiKey(req, res)) return;

      const allAdmins = await storage.getAllHRAdmins();

      // Group by organization
      const orgMap = new Map<string, { organizationId: string; adminCount: number }>();
      for (const admin of allAdmins) {
        const orgId = admin.organizationId;
        if (!orgMap.has(orgId)) {
          orgMap.set(orgId, { organizationId: orgId, adminCount: 0 });
        }
        orgMap.get(orgId)!.adminCount++;
      }

      res.json({
        success: true,
        organizations: Array.from(orgMap.values()),
        totalOrgs: orgMap.size,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Get HR admin's WhatsApp ID for a user (lookup by userId or phone)
  // This helps Task Management find the correct WhatsApp ID to send notifications
  app.get('/api/whatsapp-id-lookup', async (req, res) => {
    try {
      if (!verifyNotificationApiKey(req, res)) return;

      const { userId, organizationId, phoneNumber } = req.query;

      if (!organizationId) {
        return res.status(400).json({
          success: false,
          error: 'organizationId is required',
        });
      }

      // Get all HR admins for this org
      const orgAdmins = await storage.getHRAdminsByOrganization(organizationId as string);

      if (!orgAdmins || orgAdmins.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No HR admins found for this organization',
        });
      }

      // If userId provided, try to find matching admin
      if (userId) {
        const matchingAdmin = orgAdmins.find(admin => admin.userId === userId);
        if (matchingAdmin) {
          return res.json({
            success: true,
            whatsappId: matchingAdmin.phoneNumber,
            isLid: matchingAdmin.phoneNumber.includes('@lid') || matchingAdmin.phoneNumber.length > 15,
            adminName: matchingAdmin.name,
          });
        }
      }

      // If phoneNumber provided, check if any admin matches
      if (phoneNumber) {
        const normalizedInput = (phoneNumber as string).replace(/[^0-9]/g, '');
        const matchingAdmin = orgAdmins.find(admin => {
          const adminPhone = admin.phoneNumber.replace(/[^0-9@]/g, '').split('@')[0];
          return adminPhone === normalizedInput || adminPhone.endsWith(normalizedInput);
        });

        if (matchingAdmin) {
          return res.json({
            success: true,
            whatsappId: matchingAdmin.phoneNumber,
            isLid: matchingAdmin.phoneNumber.includes('@lid') || matchingAdmin.phoneNumber.length > 15,
            adminName: matchingAdmin.name,
          });
        }
      }

      // Return first admin as default (org-level notification)
      const defaultAdmin = orgAdmins[0];
      res.json({
        success: true,
        whatsappId: defaultAdmin.phoneNumber,
        isLid: defaultAdmin.phoneNumber.includes('@lid') || defaultAdmin.phoneNumber.length > 15,
        adminName: defaultAdmin.name,
        note: 'Default org admin (no specific user match)',
        allAdmins: orgAdmins.map(a => ({
          userId: a.userId,
          name: a.name,
          phoneNumber: a.phoneNumber
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Send notification via WhatsApp (called by Supabase edge function)
  app.post('/api/send-notification', async (req, res) => {
    try {
      // Verify API key
      if (!verifyNotificationApiKey(req, res)) return;

      const { phoneNumber, message, notificationId, title, type, organizationId } = req.body;

      if (!phoneNumber || !message) {
        return res.status(400).json({
          success: false,
          error: 'phoneNumber and message are required',
        });
      }

      // REQUIRED: Check if organization has any HR admin registered
      // Only orgs with HR admins can receive WhatsApp notifications
      if (!organizationId) {
        return res.status(400).json({
          success: false,
          error: 'organizationId is required',
        });
      }

      const orgAdmins = await storage.getHRAdminsByOrganization(organizationId);
      if (!orgAdmins || orgAdmins.length === 0) {
        log(`🚫 Org ${organizationId} not enabled for WhatsApp - no HR admins registered`);
        return res.status(403).json({
          success: false,
          error: 'Organization not enabled for WhatsApp notifications. Register an HR admin first.',
          organizationId,
        });
      }

      log(`✅ Org ${organizationId} verified - ${orgAdmins.length} HR admin(s) registered`);

      // Smart phone number normalization - handles both regular and LID formats
      // Let WhatsAppService.resolveOutgoingJid handle @lid vs @s.whatsapp.net resolution
      let normalizedPhone = phoneNumber;

      // Check if it's already a full JID (contains @)
      if (phoneNumber.includes('@')) {
        normalizedPhone = phoneNumber; // Already formatted
      } else {
        // Regular phone number - just normalize digits, let service resolve the JID
        let cleaned = phoneNumber.replace(/[^0-9]/g, '');
        if (cleaned.length === 10 && !cleaned.startsWith('91')) {
          cleaned = '91' + cleaned;
        }
        normalizedPhone = cleaned;
      }

      log(`📤 Sending notification to ${normalizedPhone}: ${message.substring(0, 50)}...`);

      // Format message with title if provided
      const formattedMessage = title
        ? `*${title}*\n\n${message}`
        : message;

      // Send via WhatsApp using user's connected session
      const waSession = await getUserWASession(req);
      await waSession.sendTextMessage(normalizedPhone, formattedMessage);

      log(`✅ Notification sent successfully (id: ${notificationId || 'N/A'})`);

      res.json({
        success: true,
        message: 'Notification sent',
        notificationId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`❌ Send notification error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Batch send notifications (for processing queue)
  app.post('/api/send-notifications-batch', async (req, res) => {
    try {
      // Verify API key
      if (!verifyNotificationApiKey(req, res)) return;

      const { notifications } = req.body;

      if (!Array.isArray(notifications) || notifications.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'notifications array is required',
        });
      }

      log(`📤 Processing batch of ${notifications.length} notifications`);

      const connectedSession = sessionManager.getAnyConnectedSession();
      if (!connectedSession) {
        return res.status(503).json({ success: false, error: 'No connected WhatsApp session available' });
      }

      const results = {
        sent: 0,
        failed: 0,
        errors: [] as { notificationId: string; error: string }[],
      };

      for (const notification of notifications) {
        try {
          const { phoneNumber, message, notificationId, title } = notification;

          if (!phoneNumber || !message) {
            results.failed++;
            results.errors.push({ notificationId, error: 'Missing phoneNumber or message' });
            continue;
          }

          // Smart phone number normalization - handles both regular and LID formats
          // Let WhatsAppService.resolveOutgoingJid handle @lid vs @s.whatsapp.net resolution
          let normalizedPhone = phoneNumber;
          if (phoneNumber.includes('@')) {
            normalizedPhone = phoneNumber; // Already formatted
          } else {
            // Regular phone number - just normalize digits, let service resolve the JID
            let cleaned = phoneNumber.replace(/[^0-9]/g, '');
            if (cleaned.length === 10 && !cleaned.startsWith('91')) {
              cleaned = '91' + cleaned;
            }
            normalizedPhone = cleaned;
          }

          const formattedMessage = title
            ? `*${title}*\n\n${message}`
            : message;

          await connectedSession.service.sendTextMessage(normalizedPhone, formattedMessage);
          results.sent++;

          // Small delay between messages to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          results.failed++;
          results.errors.push({
            notificationId: notification.notificationId,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      log(`✅ Batch complete: ${results.sent} sent, ${results.failed} failed`);

      res.json({
        success: true,
        results,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`❌ Batch notification error: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // ==================== END NOTIFICATION API ====================

  // ==================== DEMO SCHEDULER ====================

  // GET /api/demo-schedules — list all upcoming and recent demo schedules
  app.get("/api/demo-schedules", requireAuth, async (req: Request, res: Response) => {
    try {
      const rows = await db.execute(
        drizzleSql`SELECT * FROM demo_schedules ORDER BY demo_at DESC LIMIT 100`
      );
      res.json({ schedules: rows });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log(`❌ GET /api/demo-schedules error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/leads/:phoneNumber/schedule-demo — manually schedule a demo for a lead
  app.post("/api/leads/:phoneNumber/schedule-demo", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenant = getTenantFromRequest(req);
      const { phoneNumber } = req.params;
      const { demoDate, demoTime, meetingLink, contactName } = req.body as {
        demoDate: string;  // YYYY-MM-DD
        demoTime: string;  // HH:MM (IST)
        meetingLink: string;
        contactName?: string;
      };

      if (!demoDate || !demoTime || !meetingLink) {
        return res.status(400).json({ error: "demoDate, demoTime, and meetingLink are required" });
      }
      if (!meetingLink.startsWith("http")) {
        return res.status(400).json({ error: "meetingLink must be a valid URL" });
      }

      // Parse as IST (UTC+05:30) to avoid timezone shift
      const timePart = demoTime.includes(":") && demoTime.split(":").length === 2
        ? `${demoTime}:00`
        : demoTime;
      const demoAt = new Date(`${demoDate}T${timePart}+05:30`);
      if (isNaN(demoAt.getTime())) {
        return res.status(400).json({ error: "Invalid date/time format. Use YYYY-MM-DD and HH:MM" });
      }
      if (demoAt.getTime() <= Date.now()) {
        return res.status(400).json({ error: "Demo time must be in the future" });
      }

      // Normalize phone (strip leading + or spaces)
      const cleanPhone = phoneNumber.replace(/\D/g, "");

      await db.execute(
        drizzleSql`INSERT INTO demo_schedules (organization_id, user_id, phone_number, contact_name, meeting_link, demo_at)
          VALUES (${tenant.organizationId}, ${tenant.userId}, ${cleanPhone}, ${contactName || null}, ${meetingLink}, ${demoAt.toISOString()})`
      );

      // Pause chatbot for this lead so they can interact freely around demo time
      try {
        await storage.updateContactByTenant(tenant, cleanPhone, { chatbotActive: "false" });
        log(`⏸ Chatbot paused for ${cleanPhone} (demo scheduled)`);
      } catch (e: any) {
        log(`⚠️ Could not pause chatbot for ${cleanPhone}: ${e.message}`);
      }

      log(`📅 Demo scheduled: ${cleanPhone} at ${demoAt.toISOString()}`);
      try {
        const waSession = await getUserWASession(req);
        await sendNotificationForEvent(tenant, waSession, "demo_scheduled", {
          title: "📅 Demo Scheduled",
          lines: [
            contactName ? `👤 Name: ${contactName}` : "",
            `📱 Phone: ${cleanPhone}`,
            `🕒 Demo Time: ${demoAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
            `🔗 Link: ${meetingLink}`,
          ],
        });
      } catch (notificationError: any) {
        log(`Failed to send demo notification for ${cleanPhone}: ${notificationError.message}`);
      }

      res.json({ success: true, demoAt: demoAt.toISOString() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log(`❌ POST schedule-demo error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ==================== END DEMO SCHEDULER ====================

  // Demo reminder scheduler — runs every 60 seconds
  function startDemoReminderScheduler() {
    const buildMessage = (type: "30min" | "15min" | "5min", meetingLink: string, name: string | null) => {
      const greeting = name ? `Hi ${name}! ` : "";
      if (type === "30min") return `${greeting}⏰ *Reminder:* Your AnPro LIMS demo starts in *30 minutes*.\n\nJoin here 👇\n${meetingLink}`;
      if (type === "15min") return `${greeting}⏰ *Reminder:* Your AnPro LIMS demo is in *15 minutes*!\n\nJoin here 👇\n${meetingLink}`;
      return `${greeting}🚀 *Your AnPro demo starts in 5 minutes!*\n\nJoin now 👇\n${meetingLink}`;
    };

    setInterval(async () => {
      try {
        const now = new Date();
        const window40 = new Date(now.getTime() + 40 * 60 * 1000);
        const rows: any[] = await db.execute(
          drizzleSql`SELECT * FROM demo_schedules
            WHERE demo_at >= ${now.toISOString()}
              AND demo_at <= ${window40.toISOString()}
              AND remind_5_sent_at IS NULL`
        );

        for (const s of rows) {
          const demoAt = new Date(s.demo_at);
          const minsLeft = (demoAt.getTime() - now.getTime()) / 60000;
          // Pass digits only — WhatsAppService.resolveOutgoingJid handles LID resolution
          const phoneDigits = String(s.phone_number).replace(/\D/g, "");

          // Get any connected session for sending reminders
          const connectedSession = sessionManager.getAnyConnectedSession();
          if (!connectedSession) {
            log('⚠️ Demo reminder: No connected WhatsApp session available, skipping');
            break;
          }
          const waService = connectedSession.service;

          // 30-min reminder window: 25–35 mins remaining
          if (!s.remind_30_sent_at && minsLeft >= 25 && minsLeft <= 35) {
            try {
              await waService.sendTextMessage(phoneDigits, buildMessage("30min", s.meeting_link, s.contact_name));
              await db.execute(drizzleSql`UPDATE demo_schedules SET remind_30_sent_at = NOW() WHERE id = ${s.id}`);
              log(`✅ Demo 30-min reminder → ${s.phone_number}`);
            } catch (e: any) { log(`⚠️ 30-min reminder failed for ${s.phone_number}: ${e.message}`); }
          }

          // 15-min reminder window: 10–20 mins remaining
          if (!s.remind_15_sent_at && minsLeft >= 10 && minsLeft <= 20) {
            try {
              await waService.sendTextMessage(phoneDigits, buildMessage("15min", s.meeting_link, s.contact_name));
              await db.execute(drizzleSql`UPDATE demo_schedules SET remind_15_sent_at = NOW() WHERE id = ${s.id}`);
              log(`✅ Demo 15-min reminder → ${s.phone_number}`);
            } catch (e: any) { log(`⚠️ 15-min reminder failed for ${s.phone_number}: ${e.message}`); }
          }

          // 5-min reminder window: 0–10 mins remaining
          if (!s.remind_5_sent_at && minsLeft >= 0 && minsLeft <= 10) {
            try {
              await waService.sendTextMessage(phoneDigits, buildMessage("5min", s.meeting_link, s.contact_name));
              await db.execute(drizzleSql`UPDATE demo_schedules SET remind_5_sent_at = NOW() WHERE id = ${s.id}`);
              log(`✅ Demo 5-min reminder → ${s.phone_number}`);
            } catch (e: any) { log(`⚠️ 5-min reminder failed for ${s.phone_number}: ${e.message}`); }
          }
        }
      } catch (e: any) {
        log(`⚠️ Demo reminder scheduler error: ${e.message}`);
      }
    }, 60 * 1000);

    log("📅 Demo reminder scheduler started (60s interval)");
  }

  startDemoReminderScheduler();

  // Cleanup old files periodically
  setInterval(async () => {
    await fileService.cleanupOldFiles(24); // Clean files older than 24 hours
  }, 60 * 60 * 1000); // Run every hour

  return httpServer;
}

