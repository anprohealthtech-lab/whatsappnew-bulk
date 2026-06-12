import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  voiceAgents,
  voiceFlows,
  voiceProfiles,
  voiceProviderCredentials,
  voiceCampaigns,
  voiceCampaignContacts,
  voiceCallSessions,
  voiceGatewayDevices,
  voiceUsage,
} from "@shared/schema";

type Tenant = { organizationId: string; userId: string };

const TOKEN_SECRET =
  process.env.VOICE_SESSION_TOKEN_SECRET ||
  process.env.VOICE_AGENT_SHARED_SECRET ||
  process.env.PLATFORM_AGENT_SECRET ||
  "";

export class VoiceTenantService {
  async listCredentials(tenant: Tenant) {
    const rows = await db.select().from(voiceProviderCredentials).where(and(
      eq(voiceProviderCredentials.organizationId, tenant.organizationId),
      eq(voiceProviderCredentials.userId, tenant.userId),
    )).orderBy(desc(voiceProviderCredentials.createdAt));
    return rows.map(({ encryptedSecret: _secret, ...row }) => ({ ...row, hasSecret: true }));
  }

  async createCredential(tenant: Tenant, input: {
    provider: string;
    credentialType: string;
    name: string;
    secret: string;
    accountId?: string;
    settings?: Record<string, unknown>;
  }) {
    const [row] = await db.insert(voiceProviderCredentials).values({
      ...tenant,
      provider: input.provider,
      credentialType: input.credentialType,
      name: input.name,
      encryptedSecret: encryptSecret(input.secret),
      accountId: input.accountId || null,
      settings: input.settings || {},
      status: "active",
      updatedAt: new Date(),
    }).returning();
    const { encryptedSecret: _secret, ...safe } = row;
    return { ...safe, hasSecret: true };
  }

  async rotateCredential(tenant: Tenant, id: string, input: {
    secret: string;
    settings?: Record<string, unknown>;
  }) {
    const [row] = await db.update(voiceProviderCredentials).set({
      encryptedSecret: encryptSecret(input.secret),
      ...(input.settings ? { settings: input.settings } : {}),
      status: "active",
      updatedAt: new Date(),
    }).where(and(
      eq(voiceProviderCredentials.id, id),
      eq(voiceProviderCredentials.organizationId, tenant.organizationId),
      eq(voiceProviderCredentials.userId, tenant.userId),
    )).returning();
    if (!row) throw new Error("Voice credential not found");
    return { id: row.id, hasSecret: true };
  }

  async listProfiles(tenant: Tenant) {
    return db.select().from(voiceProfiles).where(and(
      eq(voiceProfiles.organizationId, tenant.organizationId),
      eq(voiceProfiles.userId, tenant.userId),
    )).orderBy(desc(voiceProfiles.createdAt));
  }

  async createProfile(tenant: Tenant, input: {
    credentialId: string;
    name: string;
    provider: string;
    referenceId?: string;
    model?: string;
    language?: string;
    audioFormat?: string;
    settings?: Record<string, unknown>;
  }) {
    await this.requireOwnedCredential(tenant, input.credentialId, "tts");
    const [row] = await db.insert(voiceProfiles).values({
      ...tenant,
      credentialId: input.credentialId,
      name: input.name,
      provider: input.provider,
      referenceId: input.referenceId || null,
      model: input.model || null,
      language: input.language || null,
      audioFormat: input.audioFormat || "pcm",
      settings: input.settings || { sampleRate: 16000 },
      status: "active",
      updatedAt: new Date(),
    }).returning();
    return row;
  }

  async listAgents(tenant: Tenant) {
    return db.select().from(voiceAgents).where(and(
      eq(voiceAgents.organizationId, tenant.organizationId),
      eq(voiceAgents.userId, tenant.userId),
    )).orderBy(desc(voiceAgents.createdAt));
  }

  async createAgent(tenant: Tenant, input: {
    name: string;
    systemPrompt?: string;
    languageMode?: string;
    responseMode?: string;
    defaultFlowKey?: string;
    ragAgentId?: string;
    sttCredentialId?: string;
    voiceProfileId?: string;
  }) {
    if (input.sttCredentialId) await this.requireOwnedCredential(tenant, input.sttCredentialId, "stt");
    if (input.voiceProfileId) await this.requireOwnedProfile(tenant, input.voiceProfileId);
    const [row] = await db.insert(voiceAgents).values({
      ...tenant,
      name: input.name,
      status: "active",
      systemPrompt: input.systemPrompt || null,
      languageMode: input.languageMode || "match_speaker",
      responseMode: input.responseMode || "voice",
      defaultFlowKey: input.defaultFlowKey || null,
      ragAgentId: input.ragAgentId || null,
      sttCredentialId: input.sttCredentialId || null,
      voiceProfileId: input.voiceProfileId || null,
      updatedAt: new Date(),
    }).returning();
    return row;
  }

  async listFlows(tenant: Tenant) {
    return db.select().from(voiceFlows).where(and(
      eq(voiceFlows.organizationId, tenant.organizationId),
      eq(voiceFlows.userId, tenant.userId),
    )).orderBy(desc(voiceFlows.createdAt));
  }

  async createFlowDraft(tenant: Tenant, input: {
    voiceAgentId?: string;
    flowKey: string;
    name: string;
    description?: string;
    definition: any;
    voiceProfileId?: string;
  }) {
    validateFlowDefinition(input.definition);
    if (input.voiceAgentId) await this.requireOwnedAgent(tenant, input.voiceAgentId);
    if (input.voiceProfileId) await this.requireOwnedProfile(tenant, input.voiceProfileId);
    const existing = await this.listFlows(tenant);
    const version = Math.max(
      0,
      ...existing.filter((flow) => flow.flowKey === input.flowKey).map((flow) => flow.version),
    ) + 1;
    const [row] = await db.insert(voiceFlows).values({
      ...tenant,
      voiceAgentId: input.voiceAgentId || null,
      flowKey: input.flowKey,
      name: input.name,
      description: input.description || null,
      version,
      status: "draft",
      startNode: input.definition.startNode,
      definition: input.definition,
      voiceProfileId: input.voiceProfileId || null,
      updatedAt: new Date(),
    }).returning();
    return row;
  }

  async publishFlow(tenant: Tenant, id: string) {
    const [row] = await db.update(voiceFlows).set({
      status: "published",
      publishedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(voiceFlows.id, id),
      eq(voiceFlows.organizationId, tenant.organizationId),
      eq(voiceFlows.userId, tenant.userId),
      eq(voiceFlows.status, "draft"),
    )).returning();
    if (!row) throw new Error("Draft voice flow not found");
    return row;
  }

  async createSessionToken(tenant: Tenant, input: {
    voiceAgentId: string;
    flowKey?: string;
    flowVersion?: number;
    voiceProfileId?: string;
    channel?: "browser" | "twilio";
  }) {
    if (!TOKEN_SECRET) throw new Error("VOICE_SESSION_TOKEN_SECRET is not configured");
    const agent = await this.requireOwnedAgent(tenant, input.voiceAgentId);
    return jwt.sign({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      voiceAgentId: agent.id,
      flowId: input.flowKey || agent.defaultFlowKey,
      flowVersion: input.flowVersion,
      voiceProfileId: input.voiceProfileId || agent.voiceProfileId,
      channel: input.channel || "browser",
      type: "voice_session",
    }, TOKEN_SECRET, { expiresIn: "10m", issuer: "anpro-main-app", audience: "voice-agent-service" });
  }

  async listCampaigns(tenant: Tenant) {
    return db.select().from(voiceCampaigns).where(and(
      eq(voiceCampaigns.organizationId, tenant.organizationId),
      eq(voiceCampaigns.userId, tenant.userId),
    )).orderBy(desc(voiceCampaigns.createdAt));
  }

  async createCampaign(tenant: Tenant, input: {
    name: string; voiceAgentId: string; flowId: string; gatewayDeviceId?: string;
    maxAttempts?: number; retryDelayMinutes?: number;
  }) {
    await this.requireOwnedAgent(tenant, input.voiceAgentId);
    const [flow] = await db.select().from(voiceFlows).where(and(
      eq(voiceFlows.id, input.flowId), eq(voiceFlows.organizationId, tenant.organizationId),
      eq(voiceFlows.userId, tenant.userId), eq(voiceFlows.status, "published"),
    )).limit(1);
    if (!flow) throw new Error("Published tenant flow not found");
    const [row] = await db.insert(voiceCampaigns).values({
      ...tenant, name: input.name, voiceAgentId: input.voiceAgentId, flowId: input.flowId,
      gatewayDeviceId: input.gatewayDeviceId || null, maxAttempts: input.maxAttempts || 1,
      retryDelayMinutes: input.retryDelayMinutes || 30, status: "draft", updatedAt: new Date(),
    }).returning();
    return row;
  }

  async addCampaignContacts(tenant: Tenant, campaignId: string, contacts: Array<{ name?: string; phoneNumber: string; variables?: Record<string, unknown> }>) {
    await this.requireOwnedCampaign(tenant, campaignId);
    if (!contacts.length) return [];
    return db.insert(voiceCampaignContacts).values(contacts.map((contact) => ({
      ...tenant, campaignId, name: contact.name || null, phoneNumber: contact.phoneNumber,
      variables: contact.variables || {}, consentStatus: "confirmed", status: "queued",
      nextAttemptAt: new Date(), updatedAt: new Date(),
    }))).returning();
  }

  async startCampaign(tenant: Tenant, campaignId: string) {
    const [row] = await db.update(voiceCampaigns).set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(voiceCampaigns.id, campaignId), eq(voiceCampaigns.organizationId, tenant.organizationId), eq(voiceCampaigns.userId, tenant.userId)))
      .returning();
    if (!row) throw new Error("Voice campaign not found");
    return row;
  }

  async pauseCampaign(tenant: Tenant, campaignId: string) {
    const [row] = await db.update(voiceCampaigns).set({ status: "paused", updatedAt: new Date() })
      .where(and(eq(voiceCampaigns.id, campaignId), eq(voiceCampaigns.organizationId, tenant.organizationId), eq(voiceCampaigns.userId, tenant.userId)))
      .returning();
    if (!row) throw new Error("Voice campaign not found");
    return row;
  }

  async listCalls(tenant: Tenant, limit = 100) {
    return db.select().from(voiceCallSessions).where(and(
      eq(voiceCallSessions.organizationId, tenant.organizationId),
      eq(voiceCallSessions.userId, tenant.userId),
    )).orderBy(desc(voiceCallSessions.createdAt)).limit(limit);
  }

  async usageSummary(tenant: Tenant) {
    return db.select({
      metric: voiceUsage.metric, unit: voiceUsage.unit,
      quantity: sql<number>`sum(${voiceUsage.quantity})`,
    }).from(voiceUsage).where(and(
      eq(voiceUsage.organizationId, tenant.organizationId),
      eq(voiceUsage.userId, tenant.userId),
    )).groupBy(voiceUsage.metric, voiceUsage.unit);
  }

  async enrollGateway(tenant: Tenant, input: { name: string; deviceType: "windows" | "android"; phoneNumber?: string; capabilities?: Record<string, unknown> }) {
    const token = crypto.randomBytes(32).toString("base64url");
    const pairingCode = crypto.randomBytes(4).toString("hex").toUpperCase();
    const [row] = await db.insert(voiceGatewayDevices).values({
      ...tenant, name: input.name, deviceType: input.deviceType, phoneNumber: input.phoneNumber || null,
      capabilities: input.capabilities || {}, pairingCode, deviceTokenHash: hashToken(token),
      status: "offline", updatedAt: new Date(),
    }).returning();
    return { ...row, deviceToken: token };
  }

  async listGateways(tenant: Tenant) {
    const rows = await db.select().from(voiceGatewayDevices).where(and(
      eq(voiceGatewayDevices.organizationId, tenant.organizationId), eq(voiceGatewayDevices.userId, tenant.userId),
    )).orderBy(desc(voiceGatewayDevices.createdAt));
    return rows.map(({ deviceTokenHash: _hash, pairingCode: _pair, ...row }) => row);
  }

  async authenticateGateway(deviceId: string, token: string) {
    const [device] = await db.select().from(voiceGatewayDevices).where(eq(voiceGatewayDevices.id, deviceId)).limit(1);
    if (!device?.deviceTokenHash || !safeEqual(device.deviceTokenHash, hashToken(token))) throw new Error("Invalid gateway credentials");
    return device;
  }

  async gatewayHeartbeat(deviceId: string, token: string, capabilities?: Record<string, unknown>) {
    const device = await this.authenticateGateway(deviceId, token);
    const [row] = await db.update(voiceGatewayDevices).set({
      status: "online", lastHeartbeatAt: new Date(), updatedAt: new Date(),
      ...(capabilities ? { capabilities } : {}),
    }).where(eq(voiceGatewayDevices.id, device.id)).returning();
    return row;
  }

  async leaseGatewayJob(deviceId: string, token: string) {
    const device = await this.authenticateGateway(deviceId, token);
    const [campaign] = await db.select().from(voiceCampaigns).where(and(
      eq(voiceCampaigns.organizationId, device.organizationId), eq(voiceCampaigns.userId, device.userId),
      eq(voiceCampaigns.status, "running"), eq(voiceCampaigns.gatewayDeviceId, device.id),
    )).orderBy(voiceCampaigns.startedAt).limit(1);
    if (!campaign) return null;
    const [contact] = await db.select().from(voiceCampaignContacts).where(and(
      eq(voiceCampaignContacts.campaignId, campaign.id), eq(voiceCampaignContacts.status, "queued"),
      lte(voiceCampaignContacts.nextAttemptAt, new Date()),
    )).orderBy(voiceCampaignContacts.createdAt).limit(1);
    if (!contact) return null;
    await db.update(voiceCampaignContacts).set({ status: "leased", attempts: contact.attempts + 1, updatedAt: new Date() })
      .where(and(eq(voiceCampaignContacts.id, contact.id), eq(voiceCampaignContacts.status, "queued")));
    const [session] = await db.insert(voiceCallSessions).values({
      organizationId: device.organizationId, userId: device.userId, campaignId: campaign.id,
      contactId: contact.id, voiceAgentId: campaign.voiceAgentId, flowId: campaign.flowId,
      gatewayDeviceId: device.id, phoneNumber: contact.phoneNumber, status: "leased", updatedAt: new Date(),
    }).returning();
    const flow = await db.select().from(voiceFlows).where(eq(voiceFlows.id, campaign.flowId)).limit(1);
    const sessionToken = await this.createSessionToken(
      { organizationId: device.organizationId, userId: device.userId },
      { voiceAgentId: campaign.voiceAgentId, flowKey: flow[0]?.flowKey, flowVersion: flow[0]?.version, channel: "browser" },
    );
    return { session, campaign, contact, sessionToken };
  }

  async getGatewayActiveDialJob(deviceId: string, token: string) {
    const device = await this.authenticateGateway(deviceId, token);
    const [session] = await db.select().from(voiceCallSessions).where(and(
      eq(voiceCallSessions.gatewayDeviceId, device.id),
      inArray(voiceCallSessions.status, ["leased", "dialing", "ringing", "connected"]),
    )).orderBy(desc(voiceCallSessions.createdAt)).limit(1);
    if (!session?.contactId) return null;
    const [contact] = await db.select().from(voiceCampaignContacts)
      .where(eq(voiceCampaignContacts.id, session.contactId)).limit(1);
    return contact ? { session, contact } : null;
  }

  async getGatewaySession(deviceId: string, token: string, sessionId: string) {
    const device = await this.authenticateGateway(deviceId, token);
    const [session] = await db.select().from(voiceCallSessions).where(and(
      eq(voiceCallSessions.id, sessionId),
      eq(voiceCallSessions.gatewayDeviceId, device.id),
      eq(voiceCallSessions.organizationId, device.organizationId),
      eq(voiceCallSessions.userId, device.userId),
    )).limit(1);
    if (!session) throw new Error("Gateway call session not found");
    return session;
  }

  async recordGatewayEvent(deviceId: string, token: string, sessionId: string, input: {
    type: string; text?: string; speaker?: string; outcome?: string; errorMessage?: string;
    durationSeconds?: number; usage?: Array<{ metric: string; quantity: number; unit: string; provider?: string }>;
  }) {
    const device = await this.authenticateGateway(deviceId, token);
    const [session] = await db.select().from(voiceCallSessions).where(and(
      eq(voiceCallSessions.id, sessionId), eq(voiceCallSessions.gatewayDeviceId, device.id),
      eq(voiceCallSessions.organizationId, device.organizationId), eq(voiceCallSessions.userId, device.userId),
    )).limit(1);
    if (!session) throw new Error("Gateway call session not found");
    const now = new Date();
    const transcript = Array.isArray(session.transcript) ? [...session.transcript as any[]] : [];
    if (input.text) transcript.push({ at: now.toISOString(), speaker: input.speaker || "system", text: input.text });
    const statusMap: Record<string, string> = { dialing: "dialing", ringing: "ringing", connected: "connected", ended: "completed", failed: "failed" };
    const status = statusMap[input.type] || session.status;
    const [updated] = await db.update(voiceCallSessions).set({
      status, transcript, outcome: input.outcome || session.outcome, errorMessage: input.errorMessage || session.errorMessage,
      durationSeconds: input.durationSeconds ?? session.durationSeconds,
      ...(input.type === "dialing" ? { startedAt: now } : {}),
      ...(input.type === "connected" ? { connectedAt: now } : {}),
      ...(["ended", "failed"].includes(input.type) ? { endedAt: now } : {}),
      updatedAt: now,
    }).where(eq(voiceCallSessions.id, session.id)).returning();
    if (input.usage?.length) await db.insert(voiceUsage).values(input.usage.map((usage) => ({
      organizationId: device.organizationId, userId: device.userId, callSessionId: session.id,
      ...usage, metadata: {},
    })));
    if (["ended", "failed"].includes(input.type) && session.contactId) {
      await db.update(voiceCampaignContacts).set({
        status: input.type === "ended" ? "completed" : "failed", lastOutcome: input.outcome || input.type, updatedAt: now,
      }).where(eq(voiceCampaignContacts.id, session.contactId));
    }
    return updated;
  }

  private async requireOwnedCampaign(tenant: Tenant, id: string) {
    const [row] = await db.select().from(voiceCampaigns).where(and(
      eq(voiceCampaigns.id, id), eq(voiceCampaigns.organizationId, tenant.organizationId), eq(voiceCampaigns.userId, tenant.userId),
    )).limit(1);
    if (!row) throw new Error("Tenant voice campaign not found");
    return row;
  }

  private async requireOwnedCredential(tenant: Tenant, id: string, type: string) {
    const [row] = await db.select().from(voiceProviderCredentials).where(and(
      eq(voiceProviderCredentials.id, id),
      eq(voiceProviderCredentials.organizationId, tenant.organizationId),
      eq(voiceProviderCredentials.userId, tenant.userId),
      eq(voiceProviderCredentials.credentialType, type),
    )).limit(1);
    if (!row) throw new Error(`Tenant ${type.toUpperCase()} credential not found`);
    return row;
  }

  private async requireOwnedProfile(tenant: Tenant, id: string) {
    const [row] = await db.select().from(voiceProfiles).where(and(
      eq(voiceProfiles.id, id),
      eq(voiceProfiles.organizationId, tenant.organizationId),
      eq(voiceProfiles.userId, tenant.userId),
    )).limit(1);
    if (!row) throw new Error("Tenant voice profile not found");
    return row;
  }

  private async requireOwnedAgent(tenant: Tenant, id: string) {
    const [row] = await db.select().from(voiceAgents).where(and(
      eq(voiceAgents.id, id),
      eq(voiceAgents.organizationId, tenant.organizationId),
      eq(voiceAgents.userId, tenant.userId),
    )).limit(1);
    if (!row) throw new Error("Tenant voice agent not found");
    return row;
  }
}

function encryptSecret(value: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function getEncryptionKey(): Buffer {
  const value = process.env.VOICE_CREDENTIAL_ENCRYPTION_KEY || "";
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error("VOICE_CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64 or 64-character hex");
  }
  return decoded;
}

function validateFlowDefinition(definition: any) {
  if (!definition || typeof definition !== "object" || !definition.startNode || !definition.nodes) {
    throw new Error("Flow definition requires startNode and nodes");
  }
  if (!definition.nodes[definition.startNode]) {
    throw new Error("Flow startNode does not exist in nodes");
  }
}

export const voiceTenantService = new VoiceTenantService();

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
