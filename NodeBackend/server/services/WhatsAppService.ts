import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  downloadMediaMessage,
  proto,
  WAMessageKey,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { storage } from '../storage';

export interface WhatsAppStatus {
  isConnected: boolean;
  isAuthenticated: boolean;
  lastSeen: Date | null;
  sessionInfo: any;
}

export class WhatsAppService extends EventEmitter {
  private socket: WASocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly maxReconnectAttempts = 5;
  private reconnectAttempts = 0;
  private isPairing = false;
  private userRequestedDisconnect = false;
  private connectionPhase: 'disconnected' | 'connecting' | 'connected' | 'pairing' | 'restarting' = 'disconnected';
  private recentJidByPhone = new Map<string, { jid: string; updatedAt: number }>();
  private status: WhatsAppStatus = {
    isConnected: false,
    isAuthenticated: false,
    lastSeen: null,
    sessionInfo: null,
  };
  private authPath: string;
  private currentQR: { qr: string; timestamp: number } | null = null;
  private userId: string;
  private browserIdentity = 'LIMS';

  constructor(sessionDir?: string, userId?: string) {
    super();
    this.userId = userId || 'default';
    const baseDir = process.env.AUTH_BASE_DIR || path.join(process.cwd(), 'auth');
    const normalizedSessionDir = sessionDir
      ? sessionDir.replace(/^server[\\/]+sessions[\\/]+/i, '')
      : this.userId;
    this.authPath = path.join(baseDir, normalizedSessionDir);
  }

  async initialize(): Promise<void> {
    try {
      this.userRequestedDisconnect = false;
      this.connectionPhase = 'connecting';
      console.log(`[WhatsAppService] Initializing for ${this.userId} using auth "${this.authPath}"`);

      if (this.socket) {
        try {
          this.socket.end(undefined);
        } catch {}
        this.socket = null;
      }

      fs.mkdirSync(this.authPath, { recursive: true });
      await this.validateAuthState(this.authPath);
      await this.loadBrowserIdentity();

      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`[WhatsAppService] Using WA v${version.join('.')}, isLatest=${isLatest} authPath="${this.authPath}"`);

      this.socket = await this.createSocket(state, version, saveCreds);
    } catch (error: any) {
      console.error('[WhatsAppService] Init failed:', error);
      this.emit('whatsapp-auth-failure', { error: error?.message || 'Initialization failed' });
    }
  }

  private async createSocket(
    authState: Awaited<ReturnType<typeof useMultiFileAuthState>>['state'],
    version: any,
    saveCreds: () => Promise<void>,
  ): Promise<WASocket> {
    const userHash = this.userId.substring(0, 8);
    const uniqueBrowser: [string, string, string] = [`${this.browserIdentity}-${userHash}`, 'Chrome', '10.0'];

    const socket = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      browser: uniqueBrowser,
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
        console.log(`Saved auth credentials for ${this.userId} to ${this.authPath}`);
      } catch (error) {
        console.error(`Failed to save auth credentials for ${this.userId}:`, error);
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
        console.error(`[WhatsAppService] Message handling error for ${this.userId}:`, error);
      }
    });

    return socket;
  }

  private async handleConnectionUpdate(update: any): Promise<void> {
    const { connection, lastDisconnect, qr } = update;
    const statusCode =
      (lastDisconnect?.error as any)?.output?.statusCode ??
      (lastDisconnect?.error as any)?.status ??
      0;

    if (qr) {
      this.isPairing = true;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qr)}`;
      this.currentQR = { qr: qrUrl, timestamp: Date.now() };
      this.emit('qr-code', { qr: qrUrl, rawQR: qr });
      console.log(`[WhatsAppService] QR generated for ${this.userId}`);
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
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      console.log('✅ Connected via Baileys!');
      this.emit('whatsapp-authenticated', { status: this.status });
      return;
    }

    if (connection === 'connecting') {
      console.log('🔄 Baileys connecting...');
      return;
    }

    if (connection !== 'close') {
      return;
    }

    console.log('❌ Baileys connection closed');
    console.log(`🔍 Disconnect reason: ${statusCode} (${DisconnectReason[statusCode] || 'unknown'})`);

    this.status.isConnected = false;
    this.status.isAuthenticated = false;

    const loggedOut = statusCode === DisconnectReason.loggedOut;
    const restartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
    const connectionLost = statusCode === DisconnectReason.connectionLost;
    const timedOut = statusCode === DisconnectReason.timedOut;
    const serverTerminated = statusCode === 428;
    const connectionReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;
    const badSession = statusCode === DisconnectReason.badSession || statusCode === 500;
    const shouldReconnect = !loggedOut && !connectionReplaced &&
      (restartRequired || connectionLost || timedOut || serverTerminated || badSession || statusCode === 0);

    if (shouldReconnect) {
      this.reconnectAttempts++;

      let delayMs: number;
      if (restartRequired && this.isPairing && this.reconnectAttempts <= 3) {
        delayMs = 500;
      } else if (badSession) {
        delayMs = Math.min(10000 * Math.pow(1.5, Math.max(this.reconnectAttempts - 1, 0)), 180000);
      } else if (statusCode === 0) {
        delayMs = Math.min(30000 * Math.pow(1.8, Math.max(this.reconnectAttempts - 1, 0)), 600000);
      } else if (restartRequired) {
        delayMs = 8000;
      } else if (connectionLost || timedOut) {
        delayMs = Math.min(15000 * Math.pow(1.5, Math.max(this.reconnectAttempts - 1, 0)), 300000);
      } else if (serverTerminated) {
        delayMs = Math.min(20000 * Math.pow(1.6, Math.max(this.reconnectAttempts - 1, 0)), 360000);
      } else {
        delayMs = 30000;
      }

      const jitter = restartRequired && this.isPairing ? 0 : Math.random() * 3000;
      const finalDelayMs = Math.round(delayMs + jitter);
      console.log(`[WhatsAppService] Reconnecting with preserved auth in ${Math.round(finalDelayMs / 1000)}s (code=${statusCode}, attempt=${this.reconnectAttempts})`);

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.initialize();
      }, finalDelayMs);
      return;
    }

    this.currentQR = null;
    this.isPairing = false;

    if (loggedOut || connectionReplaced) {
      console.log('[WhatsAppService] Logged out or connection replaced - clearing auth state');
      await this.clearAuthState();
    }

    this.emit('whatsapp-auth-failure', { error: 'Logged out or disconnected' });
  }

  private async handleMessagesUpsert(payload: { messages?: any[] }): Promise<void> {
    const msg = payload?.messages?.[0];
    if (!msg?.message) return;

    const from = msg.key.remoteJid;

    // Skip group messages and broadcast — chatbot/autoresponse should only handle private DMs
    if (from?.endsWith('@g.us') || from?.includes('status@broadcast')) return;

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
      } catch (error) {
        console.error(`[WhatsAppService] Failed to download audio from ${from}:`, error);
      }

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
    console.log(`[WhatsAppService] sendTextMessage target="${phoneNumber}" resolvedJid="${jid}" length=${message.length}`);
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
    const participants = meta.participants || [];

    return participants.map((participant: any) => {
      const pnJid = participant.jid || '';
      const rawId = participant.id || '';
      const pnDigits = pnJid.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
      const idDigits = rawId.endsWith('@lid')
        ? ''
        : rawId.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');

      return {
        phone: pnDigits || idDigits,
        jid: pnJid || rawId,
        name: participant.notify || participant.verifiedName || participant.name || '',
      };
    }).filter((item) => item.phone.length > 0);
  }

  async sendMessageWithButtons(
    phoneNumber: string,
    message: string,
    buttons: Array<{ text: string; url?: string; phoneNumber?: string }>,
    includeStopButton = false,
  ): Promise<any> {
    if (!this.socket || !this.status.isConnected) {
      throw new Error('WhatsApp not connected');
    }

    let fullMessage = message + '\n\n';
    for (const btn of buttons) {
      if (btn.url) {
        fullMessage += `🔗 ${btn.text}: ${btn.url}\n`;
      } else if (btn.phoneNumber) {
        fullMessage += `📞 ${btn.text}: ${btn.phoneNumber}\n`;
      } else {
        fullMessage += `✅ ${btn.text}\n`;
      }
    }

    if (includeStopButton) {
      fullMessage += '\n━━━━━━━━━━━━━━━━━━━━\n';
      fullMessage += '🚫 *To stop receiving messages*\n';
      fullMessage += 'Reply with: *STOP*\n';
    }

    return this.sendTextMessage(phoneNumber, fullMessage.trim());
  }

  async sendMediaMessage(phoneNumber: string, filePath: string, caption?: string): Promise<any> {
    if (!this.socket || !this.status.isConnected) {
      throw new Error('WhatsApp not connected');
    }

    const jid = await this.resolveOutgoingJid(phoneNumber);
    console.log(`[WhatsAppService] sendMediaMessage target="${phoneNumber}" resolvedJid="${jid}" file="${path.basename(filePath)}"`);

    const fileBuffer = fs.readFileSync(filePath);
    const fileExtension = path.extname(filePath).toLowerCase();

    let messageContent: any = {};
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(fileExtension)) {
      messageContent = { image: fileBuffer, caption };
    } else if (['.mp3', '.ogg', '.wav', '.m4a', '.aac'].includes(fileExtension)) {
      const audioMimeTypeMap: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
      };
      const isOggOpus = fileExtension === '.ogg';
      messageContent = {
        audio: fileBuffer,
        mimetype: audioMimeTypeMap[fileExtension] || 'audio/mpeg',
        ptt: isOggOpus,
      };
    } else if (['.pdf', '.doc', '.docx', '.txt'].includes(fileExtension)) {
      messageContent = { document: fileBuffer, fileName: path.basename(filePath), caption };
    } else {
      messageContent = { document: fileBuffer, fileName: path.basename(filePath), caption };
    }

    const result = await this.socket.sendMessage(jid, messageContent);

    this.status.lastSeen = new Date();
    this.emit('message-sent', {
      messageId: result?.key?.id,
      to: jid,
      timestamp: Date.now(),
    });

    return {
      id: result?.key?.id,
      to: jid,
      hasMedia: true,
      caption,
      timestamp: Date.now(),
    };
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

  async disconnect(): Promise<void> {
    this.userRequestedDisconnect = true;
    if (this.socket) {
      try {
        await this.socket.logout();
      } catch {}
    }

    await this.cleanup();
    await this.clearAuthState();
    this.emit('whatsapp-auth-failure', { error: 'Disconnected' });
  }

  getCurrentQR(): { qr: string; timestamp: number } | null {
    return this.currentQR;
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status };
  }

  private async resolveOutgoingJid(phoneNumber: string): Promise<string> {
    if (phoneNumber.includes('@')) {
      return phoneNumber;
    }

    const digits = this.formatPhoneNumber(phoneNumber);
    const knownJid = this.recentJidByPhone.get(digits)?.jid;
    if (knownJid) {
      return knownJid;
    }

    const storedJid = await this.findStoredJidForPhone(digits);
    if (storedJid) {
      this.recentJidByPhone.set(digits, { jid: storedJid, updatedAt: Date.now() });
      return storedJid;
    }

    return `${digits}@s.whatsapp.net`;
  }

  private resolveIncomingPhoneNumber(from?: string | null, senderPn?: string | null): string {
    const fromValue = from || '';
    const senderValue = senderPn || '';

    const senderDigits = senderValue.replace(/\D/g, '');
    if (senderDigits.length >= 10) {
      return senderDigits;
    }

    const fromDigits = fromValue.replace(/@s\.whatsapp\.net$|@lid$/i, '').replace(/\D/g, '');
    if (fromDigits.length > 0) {
      return fromDigits;
    }

    return fromValue;
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
    if (!digits) {
      return;
    }

    this.recentJidByPhone.set(digits, {
      jid: from,
      updatedAt: Date.now(),
    });
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
    } catch (error) {
      console.warn('[WhatsAppService] Failed to load stored JID for phone:', phoneNumber, error);
    }

    return null;
  }

  async cleanup(): Promise<void> {
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
    this.connectionPhase = 'disconnected';
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
    } catch (error) {
      console.warn(`[WhatsAppService] Failed to load browser identity for ${this.userId}:`, error);
    }

    this.browserIdentity = 'LIMS';
  }

  private async clearAuthState(): Promise<void> {
    try {
      if (fs.existsSync(this.authPath)) {
        fs.rmSync(this.authPath, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('[WhatsAppService] Failed to clear auth state:', error);
    }
  }

  private async validateAuthState(authPath: string): Promise<boolean> {
    try {
      if (!fs.existsSync(authPath)) {
        return true;
      }

      const { state } = await useMultiFileAuthState(authPath);
      const creds = state.creds;
      if (!creds?.noiseKey || !creds?.signedIdentityKey || !creds?.signedPreKey) {
        console.log(`[WhatsAppService] Invalid auth state detected at "${authPath}" - recreating`);
        fs.rmSync(authPath, { recursive: true, force: true });
        fs.mkdirSync(authPath, { recursive: true });
        return false;
      }

      return true;
    } catch (error) {
      console.warn(`[WhatsAppService] Auth validation failed at "${authPath}", recreating`, error);
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
      }
      fs.mkdirSync(authPath, { recursive: true });
      return false;
    }
  }

  async clearSignalSessions(): Promise<{ cleared: number; kept: number }> {
    let cleared = 0;
    let kept = 0;

    try {
      if (!fs.existsSync(this.authPath)) {
        return { cleared, kept };
      }

      const keepPrefixes = ['creds', 'app-state-sync-key', 'app-state-sync-version'];
      const files = fs.readdirSync(this.authPath);

      for (const file of files) {
        const shouldKeep = keepPrefixes.some((prefix) => file.startsWith(prefix));
        if (shouldKeep) {
          kept++;
        } else {
          fs.unlinkSync(path.join(this.authPath, file));
          cleared++;
        }
      }

      if (this.socket) {
        this.socket.end(undefined);
        this.socket = null;
      }

      this.status.isConnected = false;
      this.status.isAuthenticated = false;
      await this.initialize();
    } catch (error) {
      console.error('[WhatsAppService] Failed to clear signal sessions:', error);
    }

    return { cleared, kept };
  }
}

export const whatsAppService = new WhatsAppService();
