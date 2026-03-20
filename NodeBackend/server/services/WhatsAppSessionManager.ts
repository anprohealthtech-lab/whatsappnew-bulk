import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
  WASocket,
  downloadMediaMessage,
  proto,
  WAMessageKey,
} from '@whiskeysockets/baileys';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { storage } from '../storage';
import { whatsappSessions } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { log } from '../utils';
import type { WhatsAppSession } from '@shared/schema';
import { ExternalWhatsAppProxy } from './ExternalWhatsAppProxy';
import { clearDbAuthState, useDbAuthState } from './useDbAuthState';

export interface WhatsAppStatus {
  isConnected: boolean;
  isAuthenticated: boolean;
  lastSeen: Date | null;
  sessionInfo: any;
}

export interface WAServiceInstance {
  on(event: string, listener: (data: any) => void): this;
  initialize(): Promise<void>;
  sendTextMessage(phoneNumber: string, message: string): Promise<any>;
  sendMediaMessage(phoneNumber: string, filePath: string, caption?: string, fileName?: string): Promise<any>;
  listGroups(): Promise<Array<{ id: string; subject: string; participantsCount: number }>>;
  scrapeGroupNumbers(groupId: string): Promise<Array<{ phone: string; jid: string; name: string }>>;
  generateQRCode(): Promise<void>;
  getCurrentQR(): { qr: string; qrCode?: string; rawQR?: string; timestamp: number } | null;
  getStatus(): WhatsAppStatus;
  cleanup(): Promise<void>;
}

const useExternalProxy = !!process.env.EXTERNAL_WA_API_URL;

class ManagedBaileysSession extends EventEmitter implements WAServiceInstance {
  private socket: WASocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly maxReconnectAttempts = 5;
  private reconnectAttempts = 0;
  private isPairing = false;
  private userRequestedDisconnect = false;
  private phase: 'disconnected' | 'connecting' | 'connected' | 'pairing' | 'restarting' = 'disconnected';
  private readonly recentJidByPhone = new Map<string, { jid: string; updatedAt: number }>();
  private status: WhatsAppStatus = {
    isConnected: false,
    isAuthenticated: false,
    lastSeen: null,
    sessionInfo: null,
  };
  private currentQR: { qr: string; qrCode?: string; rawQR?: string; timestamp: number } | null = null;
  private browserIdentity = 'LIMS';
  private waVersion: number[] | null = null;
  private waIsLatest = true;
  private readonly dbSessionId: string;

  constructor(
    private readonly userId: string,
    private readonly sessionName: string,
    private readonly authPath: string,
  ) {
    super();
    this.dbSessionId = `${userId}::${sessionName}`;
  }

  async initialize(): Promise<void> {
    try {
      this.userRequestedDisconnect = false;
      this.phase = 'connecting';
      log(`[WA] Initializing session ${this.userId}/${this.sessionName} with auth "${this.authPath}"`);

      if (this.socket) {
        try {
          this.socket.end(undefined);
        } catch {}
        this.socket = null;
      }

      await this.loadBrowserIdentity();

      const { state, saveCreds } = await useDbAuthState(this.dbSessionId);
      const { version, isLatest } = await fetchLatestBaileysVersion();
      this.waVersion = version;
      this.waIsLatest = isLatest;
      log(`[WA] Using WA v${version.join('.')} isLatest=${isLatest} for ${this.userId}/${this.sessionName} via DB auth`);

      this.socket = this.createSocket(state, version, saveCreds);
      this.emit('whatsapp-status', this.getStatus());
    } catch (error: any) {
      log(`[WA] Initialization failed for ${this.userId}/${this.sessionName}: ${error?.message || error}`);
      this.phase = 'disconnected';
      this.status.isConnected = false;
      this.status.isAuthenticated = false;
      this.emit('whatsapp-auth-failure', { error: error?.message || 'Initialization failed' });
      this.emit('whatsapp-status', this.getStatus());
    }
  }

  private createSocket(
    authState: Awaited<ReturnType<typeof useDbAuthState>>['state'],
    version: any,
    saveCreds: () => Promise<void>,
  ): WASocket {
    const userHash = this.userId.substring(0, 8);
    const browser: [string, string, string] = [`${this.browserIdentity}-${userHash}`, 'Chrome', '10.0'];

    const socket = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      browser,
      generateHighQualityLinkPreview: false,
      logger: {
        level: 'silent',
        fatal: () => {},
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
        child: () => ({
          level: 'silent',
          fatal: () => {},
          error: () => {},
          warn: () => {},
          info: () => {},
          debug: () => {},
          trace: () => {},
        }),
      } as any,
      getMessage: async (_key: WAMessageKey): Promise<proto.IMessage | undefined> => undefined,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      qrTimeout: 60000,
      retryRequestDelayMs: 3000,
      maxMsgRetryCount: 3,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      fireInitQueries: true,
      transactionOpts: {
        maxCommitRetries: 3,
        delayBetweenTriesMs: 3000,
      },
      mobile: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: (jid: string) => jid.includes('status@broadcast'),
      patchMessageBeforeSending: (msg: any) => msg,
    });

    socket.ev.on('connection.update', async (update: any) => {
      await this.handleConnectionUpdate(update);
    });

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        log(`[WA] Saved auth for ${this.userId}/${this.sessionName} to ${this.authPath}`);
      } catch (error: any) {
        log(`[WA] Failed saving auth for ${this.userId}/${this.sessionName}: ${error?.message || error}`);
      }
    });

    socket.ev.on('messages.upsert', async (payload: any) => {
      try {
        await this.handleMessagesUpsert(payload);
      } catch (error: any) {
        if (
          error?.message?.includes('PreKey') ||
          error?.message?.includes('decrypt') ||
          error?.message?.includes('No session found')
        ) {
          return;
        }
        log(`[WA] Message handling error for ${this.userId}/${this.sessionName}: ${error?.message || error}`);
      }
    });

    return socket;
  }

  private async handleConnectionUpdate(update: any): Promise<void> {
    const { connection, lastDisconnect, qr } = update;
    const code =
      (lastDisconnect?.error as any)?.output?.statusCode ??
      (lastDisconnect?.error as any)?.status ??
      0;

    if (qr) {
      this.isPairing = true;
      this.phase = 'pairing';
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qr)}`;
      this.currentQR = { qr: qrUrl, qrCode: qrUrl, rawQR: qr, timestamp: Date.now() };
      this.emit('qr-code', { qr: qrUrl, qrCode: qrUrl, rawQR: qr });
      this.emit('whatsapp-status', this.getStatus());
      return;
    }

    if (connection === 'open') {
      this.status.isConnected = true;
      this.status.isAuthenticated = true;
      this.status.lastSeen = new Date();
      this.status.sessionInfo = this.socket?.user || null;
      this.currentQR = null;
      this.reconnectAttempts = 0;
      this.isPairing = false;
      this.phase = 'connected';

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.emit('whatsapp-authenticated', { status: this.status });
      this.emit('whatsapp-status', this.getStatus());
      return;
    }

    if (connection === 'connecting') {
      this.phase = 'connecting';
      this.emit('whatsapp-status', this.getStatus());
      return;
    }

    if (connection !== 'close') {
      return;
    }

    this.status.isConnected = false;
    this.status.isAuthenticated = false;
    this.phase = 'disconnected';
    this.emit('whatsapp-status', this.getStatus());

    if (this.userRequestedDisconnect) {
      this.emit('disconnected', { shouldReconnect: false, reason: 'user_requested_disconnect' });
      return;
    }

    const loggedOut = code === DisconnectReason.loggedOut;
    const restartRequired = code === DisconnectReason.restartRequired || code === 515;
    const connectionLost = code === DisconnectReason.connectionLost;
    const timedOut = code === DisconnectReason.timedOut;
    const serverTerminated = code === 428;
    const connectionReplaced = code === DisconnectReason.connectionReplaced || code === 440;
    const badSession = code === DisconnectReason.badSession || code === 500;
    const shouldReconnect = !loggedOut && !connectionReplaced &&
      (restartRequired || connectionLost || timedOut || serverTerminated || badSession || code === 0);

    this.emit('disconnected', { shouldReconnect, reason: code });

    if (shouldReconnect) {
      const nextAttempt = this.reconnectAttempts + 1;
      if (nextAttempt > this.maxReconnectAttempts) {
        this.emit('whatsapp-auth-failure', { error: `Max reconnect attempts reached (${code})` });
        return;
      }

      let baseDelay: number;
      if (restartRequired && this.isPairing && nextAttempt <= 3) {
        baseDelay = 500;
      } else if (badSession) {
        baseDelay = Math.min(10000 * Math.pow(1.5, nextAttempt - 1), 180000);
      } else if (code === 0) {
        baseDelay = Math.min(30000 * Math.pow(1.8, nextAttempt - 1), 600000);
      } else if (restartRequired) {
        baseDelay = 8000;
      } else if (connectionLost || timedOut) {
        baseDelay = Math.min(15000 * Math.pow(1.5, nextAttempt - 1), 300000);
      } else if (serverTerminated) {
        baseDelay = Math.min(20000 * Math.pow(1.6, nextAttempt - 1), 360000);
      } else {
        baseDelay = 30000;
      }

      const jitter = restartRequired && this.isPairing ? 0 : Math.random() * 3000;
      const delay = Math.round(baseDelay + jitter);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.reconnectInPlace();
      }, delay);
      return;
    }

    this.currentQR = null;
    this.isPairing = false;

    if (loggedOut || connectionReplaced) {
      await this.clearAuthState();
    }

    this.emit('whatsapp-auth-failure', { error: 'Logged out or disconnected' });
  }

  private async reconnectInPlace(): Promise<void> {
    if (this.phase === 'connecting' || this.phase === 'restarting' || this.phase === 'connected') {
      return;
    }

    try {
      this.phase = 'restarting';
      this.reconnectAttempts++;

      if (this.socket) {
        try {
          this.socket.end(undefined);
        } catch {}
        this.socket = null;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
      await this.loadBrowserIdentity();
      const { state, saveCreds } = await useDbAuthState(this.dbSessionId);
      const { version } = await fetchLatestBaileysVersion();
      this.socket = this.createSocket(state, version, saveCreds);
    } catch (error: any) {
      this.phase = 'disconnected';
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.emit('whatsapp-auth-failure', { error: error?.message || 'Reconnect failed' });
        return;
      }
      const backoffDelay = Math.min(60000 * Math.pow(2, this.reconnectAttempts - 1), 300000);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.reconnectInPlace();
      }, backoffDelay);
    }
  }

  private async handleMessagesUpsert(payload: { messages?: any[] }): Promise<void> {
    const msg = payload?.messages?.[0];
    if (!msg?.message) return;

    const from = msg.key.remoteJid;
    const senderPn = (msg.key as any)?.senderPn as string | undefined;
    const phoneNumber = this.resolveIncomingPhoneNumber(from, senderPn);
    this.rememberRecentJid(phoneNumber, from);

    if (msg.key.fromMe) return;

    if (msg.message.interactiveResponseMessage) {
      const res = msg.message.interactiveResponseMessage.nativeFlowResponseMessage;
      const buttonId = res?.paramsJson ? JSON.parse(res.paramsJson)?.id : null;
      this.emit('button-clicked', {
        buttonId,
        from,
        phoneNumber,
        senderPn,
        timestamp: Date.now(),
      });
      return;
    }

    if (msg.message.audioMessage) {
      const audioMsg = msg.message.audioMessage;
      const isVoiceNote = audioMsg.ptt === true;
      let audioBuffer: Buffer | null = null;
      let audioBase64: string | null = null;

      try {
        audioBuffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
        audioBase64 = audioBuffer.toString('base64');
      } catch {}

      this.emit('incoming-message', {
        phoneNumber,
        content: isVoiceNote ? '[Voice Note]' : '[Audio Message]',
        from,
        senderPn,
        timestamp: Date.now(),
        messageType: isVoiceNote ? 'voice_note' : 'audio',
        mediaInfo: {
          mimetype: audioMsg.mimetype || 'audio/ogg',
          seconds: audioMsg.seconds,
          fileLength: audioMsg.fileLength,
        },
        audioData: audioBase64,
        audioBuffer,
      });
      return;
    }

    if (msg.message.imageMessage) {
      this.emit('incoming-message', {
        phoneNumber,
        content: msg.message.imageMessage.caption || '[Image]',
        from,
        senderPn,
        timestamp: Date.now(),
        messageType: 'image',
      });
      return;
    }

    if (msg.message.documentMessage) {
      this.emit('incoming-message', {
        phoneNumber,
        content: `[Document: ${msg.message.documentMessage.fileName || 'file'}]`,
        from,
        senderPn,
        timestamp: Date.now(),
        messageType: 'document',
      });
      return;
    }

    if (msg.message.videoMessage) {
      this.emit('incoming-message', {
        phoneNumber,
        content: msg.message.videoMessage.caption || '[Video]',
        from,
        senderPn,
        timestamp: Date.now(),
        messageType: 'video',
      });
      return;
    }

    const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!messageText) return;

    this.emit('incoming-message', {
      phoneNumber,
      content: messageText,
      from,
      senderPn,
      timestamp: Date.now(),
      messageType: 'text',
    });

    if (messageText.trim().toUpperCase() === 'STOP') {
      this.emit('button-clicked', {
        buttonId: 'STOP_MESSAGES',
        from,
        phoneNumber,
        senderPn,
        timestamp: Date.now(),
      });
    }
  }

  async sendTextMessage(phoneNumber: string, message: string): Promise<any> {
    if (!this.socket || !this.status.isConnected) {
      throw new Error('WhatsApp not connected');
    }

    const jid = await this.resolveOutgoingJid(phoneNumber);
    log(`[WA] sendTextMessage ${this.userId}/${this.sessionName} target="${phoneNumber}" resolvedJid="${jid}"`);
    const result = await this.socket.sendMessage(jid, { text: message });

    this.status.lastSeen = new Date();
    this.emit('message-sent', {
      messageId: result?.key?.id,
      to: jid,
      timestamp: Date.now(),
    });

    return {
      id: result?.key?.id,
      to: jid,
      body: message,
      timestamp: Date.now(),
    };
  }

  async sendMediaMessage(phoneNumber: string, filePath: string, caption?: string, fileName?: string): Promise<any> {
    if (!this.socket || !this.status.isConnected) {
      throw new Error('WhatsApp not connected');
    }

    const jid = await this.resolveOutgoingJid(phoneNumber);
    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    let payload: any;

    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      payload = { image: fileBuffer, caption };
    } else if (['.mp3', '.ogg', '.wav', '.m4a', '.aac'].includes(ext)) {
      const mimeMap: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
      };
      payload = {
        audio: fileBuffer,
        mimetype: mimeMap[ext] || 'audio/mpeg',
        ptt: ext === '.ogg',
      };
    } else {
      payload = { document: fileBuffer, fileName: fileName || path.basename(filePath), caption };
    }

    const result = await this.socket.sendMessage(jid, payload);
    this.status.lastSeen = new Date();
    this.emit('message-sent', {
      messageId: result?.key?.id,
      to: jid,
      timestamp: Date.now(),
    });

    return {
      id: result?.key?.id,
      to: jid,
      caption,
      timestamp: Date.now(),
    };
  }

  async listGroups(): Promise<Array<{ id: string; subject: string; participantsCount: number }>> {
    if (!this.socket || !this.status.isConnected) {
      throw new Error('WhatsApp not connected');
    }

    const chats = await this.socket.groupFetchAllParticipating();
    return Object.values(chats).map((group: any) => ({
      id: group.id,
      subject: group.subject || 'Untitled Group',
      participantsCount: Array.isArray(group.participants) ? group.participants.length : 0,
    }));
  }

  async scrapeGroupNumbers(groupId: string): Promise<Array<{ phone: string; jid: string; name: string }>> {
    if (!this.socket || !this.status.isConnected) {
      throw new Error('WhatsApp not connected');
    }

    const meta = await this.socket.groupMetadata(groupId);
    return (meta.participants || []).map((participant: any) => {
      const pnJid = participant.jid || '';
      const rawId = participant.id || '';
      const pnDigits = pnJid.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
      const idDigits = rawId.endsWith('@lid') ? '' : rawId.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
      return {
        phone: pnDigits || idDigits,
        jid: pnJid || rawId,
        name: participant.notify || participant.verifiedName || participant.name || '',
      };
    }).filter((item: any) => item.phone.length > 0);
  }

  async generateQRCode(): Promise<void> {
    if (this.socket) {
      try {
        await this.socket.logout();
      } catch {}
    }
    await this.cleanup();
    await this.clearAuthState();
    await this.initialize();
  }

  getCurrentQR(): { qr: string; qrCode?: string; rawQR?: string; timestamp: number } | null {
    return this.currentQR;
  }

  getStatus(): WhatsAppStatus & { waVersion?: number[]; waIsLatest?: boolean } {
    return { ...this.status, waVersion: this.waVersion ?? undefined, waIsLatest: this.waIsLatest };
  }

  async cleanup(): Promise<void> {
    this.userRequestedDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch {}
      this.socket = null;
    }

    this.status = {
      isConnected: false,
      isAuthenticated: false,
      lastSeen: null,
      sessionInfo: null,
    };
    this.currentQR = null;
    this.isPairing = false;
    this.phase = 'disconnected';
  }

  private async resolveOutgoingJid(phoneNumber: string): Promise<string> {
    if (phoneNumber.includes('@')) {
      return phoneNumber;
    }

    const digits = this.formatPhoneNumber(phoneNumber);
    const known = this.recentJidByPhone.get(digits)?.jid;
    if (known) {
      return known;
    }

    const stored = await this.findStoredJidForPhone(digits);
    if (stored) {
      this.recentJidByPhone.set(digits, { jid: stored, updatedAt: Date.now() });
      return stored;
    }

    return `${digits}@s.whatsapp.net`;
  }

  private resolveIncomingPhoneNumber(from?: string | null, senderPn?: string | null): string {
    const senderDigits = (senderPn || '').replace(/\D/g, '');
    if (senderDigits.length >= 10) {
      return senderDigits;
    }
    const fromDigits = (from || '').replace(/@s\.whatsapp\.net$|@lid$/i, '').replace(/\D/g, '');
    return fromDigits || from || '';
  }

  private formatPhoneNumber(phoneNumber: string): string {
    let cleaned = phoneNumber.replace(/\D/g, '');
    if (!cleaned.startsWith('91') && cleaned.length === 10) {
      cleaned = '91' + cleaned;
    }
    return cleaned;
  }

  private rememberRecentJid(phoneNumber: string, from?: string | null): void {
    if (!from || !from.includes('@') || from.endsWith('@g.us') || from.includes('status@broadcast')) {
      return;
    }

    const digits = this.formatPhoneNumber(phoneNumber);
    if (!digits) return;
    this.recentJidByPhone.set(digits, { jid: from, updatedAt: Date.now() });
  }

  private async findStoredJidForPhone(phoneNumber: string): Promise<string | null> {
    try {
      const recentMessages = await storage.getMessages({
        phoneNumber,
        type: 'incoming',
        limit: 20,
      });

      for (const message of recentMessages) {
        const metadata = message.metadata as Record<string, unknown> | null;
        const from = typeof metadata?.from === 'string' ? metadata.from : null;
        if (from && from.includes('@') && !from.endsWith('@g.us') && !from.includes('status@broadcast')) {
          return from;
        }
      }
    } catch {}

    return null;
  }

  private async clearAuthState(): Promise<void> {
    try {
      await clearDbAuthState(this.dbSessionId);
      if (fs.existsSync(this.authPath)) {
        fs.rmSync(this.authPath, { recursive: true, force: true });
      }
    } catch {}
  }

  private async loadBrowserIdentity(): Promise<void> {
    try {
      const user = await storage.getUser(this.userId);
      if (user) {
        const clinic = (user as any).clinic_name || 'LIMS';
        const name = (user as any).name || this.userId;
        const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'LIMS';
        this.browserIdentity = `${sanitize(clinic)}-${sanitize(name)}`;
        return;
      }
    } catch {}

    this.browserIdentity = 'LIMS';
  }
}

export class WhatsAppSessionManager {
  private sessions = new Map<string, WAServiceInstance>();
  private sessionEventHandlers: Array<{ event: string; handler: (userId: string, sessionName: string, data: any) => void }> = [];
  private resolvedExternalBaseUrl: string | null | undefined;

  private key(userId: string, sessionName = 'default'): string {
    return `${userId}::${sessionName}`;
  }

  onSessionEvent(event: string, handler: (userId: string, sessionName: string, data: any) => void) {
    this.sessionEventHandlers.push({ event, handler });
    this.sessions.forEach((service, key) => {
      const [uid, sName] = key.split('::');
      service.on(event, (data: any) => handler(uid, sName, data));
    });
  }

  async getSession(userId: string, sessionName = 'default'): Promise<WAServiceInstance> {
    const k = this.key(userId, sessionName);
    if (this.sessions.has(k)) {
      return this.sessions.get(k)!;
    }

    const sessionDir = `server/sessions/user_${userId}/${sessionName}`;
    const authPath = path.join(process.env.AUTH_BASE_DIR || path.join(process.cwd(), 'auth'), sessionDir.replace(/^server[\\/]+sessions[\\/]+/i, ''));
    const externalBaseUrl = await this.resolveExternalBaseUrl();
    const service: WAServiceInstance = externalBaseUrl
      ? new ExternalWhatsAppProxy(sessionDir, userId, externalBaseUrl)
      : new ManagedBaileysSession(userId, sessionName, authPath);

    if (externalBaseUrl) {
      log(`[WA] Using working-app proxy for ${userId}/${sessionName} via ${externalBaseUrl}`);
    }

    service.on('whatsapp-authenticated', async (data: any) => {
      await this.updateSessionStatus(userId, sessionName, 'connected', (data?.status?.sessionInfo as any)?.id?.split(':')[0]);
    });
    service.on('whatsapp-auth-failure', async () => {
      await this.updateSessionStatus(userId, sessionName, 'disconnected');
    });
    service.on('qr-code', async () => {
      await this.updateSessionStatus(userId, sessionName, 'qr_pending');
    });
    service.on('disconnected', async () => {
      await this.updateSessionStatus(userId, sessionName, 'disconnected');
    });

    this.sessions.set(k, service);

    for (const { event, handler } of this.sessionEventHandlers) {
      service.on(event, (data: any) => handler(userId, sessionName, data));
    }

    await this.ensureSessionRecord(userId, sessionName);
    return service;
  }

  getLoadedSession(userId: string, sessionName = 'default'): WAServiceInstance | undefined {
    return this.sessions.get(this.key(userId, sessionName));
  }

  emitExternalSessionEvent(userId: string, sessionName: string, event: string, data: any) {
    const service = this.getLoadedSession(userId, sessionName);
    if (service) {
      service.emit(event, data);
      return;
    }

    for (const registration of this.sessionEventHandlers) {
      if (registration.event === event) {
        registration.handler(userId, sessionName, data);
      }
    }
  }

  async getFirstConnectedSession(userId: string): Promise<WAServiceInstance | null> {
    const loaded = Array.from(this.sessions.entries())
      .find(([key, service]) => key.startsWith(`${userId}::`) && service.getStatus().isConnected);
    if (loaded) {
      return loaded[1];
    }

    const sessions = await this.listSessions(userId);
    const connected = sessions.find((s) => s.status === 'connected');
    if (!connected) return null;
    const service = await this.getSession(userId, connected.sessionName);
    if (!service.getStatus().isConnected) {
      await service.initialize();
    }
    return service;
  }

  getAnyConnectedSession(): { userId: string; sessionName: string; service: WAServiceInstance } | null {
    for (const [key, service] of this.sessions.entries()) {
      if (service.getStatus().isConnected) {
        const [userId, sessionName] = key.split('::');
        return { userId, sessionName, service };
      }
    }
    return null;
  }

  getAllLoadedSessions(): Array<{ userId: string; sessionName: string; service: WAServiceInstance }> {
    const result: Array<{ userId: string; sessionName: string; service: WAServiceInstance }> = [];
    this.sessions.forEach((service, key) => {
      const [userId, sessionName] = key.split('::');
      result.push({ userId, sessionName, service });
    });
    return result;
  }

  async listSessions(userId: string): Promise<WhatsAppSession[]> {
    return db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId));
  }

  async removeSession(userId: string, sessionName = 'default'): Promise<void> {
    const k = this.key(userId, sessionName);
    const service = this.sessions.get(k);
    if (service) {
      await service.cleanup();
      this.sessions.delete(k);
    }
    await this.updateSessionStatus(userId, sessionName, 'disconnected');
  }

  async restoreConnectedSessions(): Promise<void> {
    try {
      const connectedSessions = await db.select().from(whatsappSessions)
        .where(eq(whatsappSessions.status, 'connected'));

      log(`Restoring ${connectedSessions.length} WhatsApp session(s)...`);
      for (const sess of connectedSessions) {
        try {
          const service = await this.getSession(sess.userId, sess.sessionName);
          await service.initialize();
          log(`Restored session for user ${sess.userId} (${sess.sessionName})`);
        } catch (err) {
          log(`Failed to restore session for user ${sess.userId}: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
      }
    } catch (err) {
      log(`Session restore skipped: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }

  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    this.sessions.forEach((service) => {
      promises.push(service.cleanup());
    });
    await Promise.allSettled(promises);
    this.sessions.clear();
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  private async resolveExternalBaseUrl(): Promise<string | null> {
    if (this.resolvedExternalBaseUrl !== undefined) {
      return this.resolvedExternalBaseUrl;
    }

    const explicit = (process.env.EXTERNAL_WA_API_URL || '').trim().replace(/\/+$/, '');
    if (explicit) {
      this.resolvedExternalBaseUrl = explicit;
      return explicit;
    }

    if (!useExternalProxy) {
      const candidates = ['http://127.0.0.1:3001', 'http://localhost:3001'];
      for (const candidate of candidates) {
        try {
          const response = await fetch(`${candidate}/api/users/whatsapp/summary`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });

          if (!response.ok) {
            continue;
          }

          const json = await response.json().catch(() => null);
          if (json && typeof json === 'object' && json.success === true) {
            this.resolvedExternalBaseUrl = candidate;
            return candidate;
          }
        } catch {
          // ignore and try the next candidate
        }
      }
    }

    return null;
  }

  private async ensureSessionRecord(userId: string, sessionName: string): Promise<void> {
    try {
      const existing = await db.select().from(whatsappSessions)
        .where(and(
          eq(whatsappSessions.userId, userId),
          eq(whatsappSessions.sessionName, sessionName),
        )).limit(1);

      if (existing.length === 0) {
        await db.insert(whatsappSessions).values({
          userId,
          sessionName,
          status: 'disconnected',
        });
      }
    } catch {}
  }

  private async updateSessionStatus(userId: string, sessionName: string, status: string, phoneNumber?: string): Promise<void> {
    try {
      await db.update(whatsappSessions).set({
        status,
        phoneNumber: phoneNumber || undefined,
        lastConnectedAt: status === 'connected' ? new Date() : undefined,
        updatedAt: new Date(),
      }).where(and(
        eq(whatsappSessions.userId, userId),
        eq(whatsappSessions.sessionName, sessionName),
      ));
    } catch {}
  }
}

export const sessionManager = new WhatsAppSessionManager();
