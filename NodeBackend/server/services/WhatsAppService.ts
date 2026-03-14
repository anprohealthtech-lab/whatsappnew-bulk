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
  private recentJidByPhone = new Map<string, { jid: string; updatedAt: number }>();
  private reconnectAttempts = 0;
  private isPairing = false;
  private status: WhatsAppStatus = {
    isConnected: false,
    isAuthenticated: false,
    lastSeen: null,
    sessionInfo: null,
  };
  private authPath: string;
  private currentQR: { qr: string; timestamp: number } | null = null;
  private badSessionRetryCount: number = 0;
  private static readonly MAX_BAD_SESSION_RETRIES = 3;
  private userId: string;

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
      console.log('🚀 Starting Baileys WhatsApp - no Chrome needed!');
      console.log(`� Auth state: file-based at "${this.authPath}"`);

      // Clean up any existing socket first
      if (this.socket) {
        this.socket.end(undefined);
        this.socket = null;
      }

      // Ensure auth directory exists and validate the saved auth state before use.
      fs.mkdirSync(this.authPath, { recursive: true });
      await this.validateAuthState(this.authPath);

      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`[WhatsAppService] Using WA v${version.join('.')}, isLatest=${isLatest} authPath="${this.authPath}"`);
      const userHash = this.userId.substring(0, 8);
      const uniqueBrowser: [string, string, string] = [`LIMS-${userHash}`, 'Chrome', '10.0'];

      this.socket = makeWASocket({
        version,
        auth: state,
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
        printQRInTerminal: false,
        browser: uniqueBrowser,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        fireInitQueries: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        qrTimeout: 60000,
        retryRequestDelayMs: 3000,
        maxMsgRetryCount: 3,
        transactionOpts: { maxCommitRetries: 3, delayBetweenTriesMs: 3000 },
        mobile: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid: string) => jid.includes('status@broadcast'),
        patchMessageBeforeSending: (msg: any) => msg,
        getMessage: async (_key: WAMessageKey): Promise<proto.IMessage | undefined> => {
          return undefined;
        },
      });

      this.socket.ev.on('creds.update', async () => {
        try {
          await saveCreds();
          console.log(`Saved auth credentials for ${this.userId} to ${this.authPath}`);
        } catch (error) {
          console.error(`Failed to save auth credentials for ${this.userId}:`, error);
        }
      });

      this.socket.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('📱 Baileys QR received!');
          this.isPairing = true;
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qr)}`;
          this.currentQR = { qr: qrUrl, timestamp: Date.now() };
          this.emit('qr-code', { qr: qrUrl, rawQR: qr });
          console.log('🎯 Baileys QR emitted to frontend');
        }

        if (connection === 'open') {
          console.log('✅ Connected via Baileys!');
          this.status.isConnected = true;
          this.status.isAuthenticated = true;
          this.status.lastSeen = new Date();
          this.currentQR = null;
          this.badSessionRetryCount = 0;
          this.reconnectAttempts = 0;
          this.isPairing = false;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.emit('whatsapp-authenticated', { status: this.status });
        } else if (connection === 'close') {
          console.log('❌ Baileys connection closed');
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
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
            (restartRequired || connectionLost || timedOut || serverTerminated || badSession || statusCode === 0 || statusCode === undefined);

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
            console.log(`[WhatsAppService] Reconnecting with preserved auth in ${Math.round(finalDelayMs / 1000)}s (code=${statusCode ?? 'unknown'}, attempt=${this.reconnectAttempts})`);
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
            }
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this.initialize();
            }, finalDelayMs);
            return;
          }

          if (loggedOut || connectionReplaced) {
            console.log('[WhatsAppService] Logged out or connection replaced - clearing auth state');
            await this.clearAuthState();
            this.currentQR = null;
            this.reconnectAttempts = 0;
            this.isPairing = false;
            this.emit('whatsapp-auth-failure', { error: 'Logged out or disconnected' });
            return;
          }

        } else if (connection === 'connecting') {
          console.log('🔄 Baileys connecting...');
        }
      });

      // Listen for incoming messages (quick reply buttons, text, audio, etc.)
      this.socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const senderPn = (msg.key as any)?.senderPn as string | undefined;
        // Prefer senderPn for LID chats so lead lookup matches real phone numbers (e.g. 91xxxxxxxxxx).
        const phoneNumber = this.resolveIncomingPhoneNumber(from, senderPn);
        this.rememberRecentJid(phoneNumber, from);
        const isFromMe = msg.key.fromMe;

        // Only process incoming messages (not sent by us)
        if (isFromMe) return;

        // Handle interactive quick reply responses
        if (msg.message.interactiveResponseMessage) {
          const res = msg.message.interactiveResponseMessage.nativeFlowResponseMessage;
          const buttonId = res?.paramsJson ? JSON.parse(res.paramsJson)?.id : null;

          console.log('📱 Quick Reply Button Clicked:', buttonId, 'from', from);

          // Emit event for button click handling
          this.emit('button-clicked', {
            buttonId,
            from,
            phoneNumber,
            senderPn,
            timestamp: Date.now(),
          });
          return;
        }

        // Handle voice notes / audio messages (ptt = push to talk)
        if (msg.message.audioMessage) {
          const audioMsg = msg.message.audioMessage;
          const isVoiceNote = audioMsg.ptt === true; // ptt = push-to-talk (voice note)

          console.log(`🎤 ${isVoiceNote ? 'Voice note' : 'Audio'} from ${from} (phoneNumber: ${phoneNumber})`);

          // Download the audio file
          let audioBuffer: Buffer | null = null;
          let audioBase64: string | null = null;
          try {
            console.log(`📥 Downloading audio from ${from}...`);
            audioBuffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
            audioBase64 = audioBuffer.toString('base64');
            console.log(`✅ Audio downloaded: ${audioBuffer.length} bytes, mimetype: ${audioMsg.mimetype}`);
          } catch (downloadError) {
            console.error(`❌ Failed to download audio:`, downloadError);
          }

          // Emit incoming message event with audio data
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
            audioData: audioBase64,  // Base64 encoded audio for Anthropic
            audioBuffer: audioBuffer, // Raw buffer if needed
          });
          return;
        }

        // Handle image messages
        if (msg.message.imageMessage) {
          console.log(`📷 Image from ${from} (phoneNumber: ${phoneNumber})`);

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

        // Handle document messages
        if (msg.message.documentMessage) {
          console.log(`📄 Document from ${from} (phoneNumber: ${phoneNumber})`);

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

        // Handle video messages
        if (msg.message.videoMessage) {
          console.log(`🎬 Video from ${from} (phoneNumber: ${phoneNumber})`);

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

        // Handle text-based messages
        const messageText = msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        if (messageText) {
          console.log(`📨 Incoming message from ${phoneNumber}: ${messageText}`);

          // Emit incoming message event
          this.emit('incoming-message', {
            phoneNumber,
            content: messageText,
            from,
            senderPn,
            timestamp: Date.now(),
            messageType: 'text',
          });

          // Handle STOP command
          if (messageText.trim().toUpperCase() === 'STOP') {
            console.log('📱 STOP message received from:', phoneNumber);

            // Emit event for STOP request
            this.emit('button-clicked', {
              buttonId: 'STOP_MESSAGES',
              from,
              phoneNumber,
              senderPn,
              timestamp: Date.now(),
            });
          }
        }
      });

    } catch (error: any) {
      console.error('❌ Baileys init failed:', error);
      this.emit('whatsapp-auth-failure', { error: error?.message });
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
      // Baileys Contact has: id (lid or jid), lid (@lid format), jid (@s.whatsapp.net format)
      // Prefer participant.jid (phone-based) for real phone numbers
      const pnJid = participant.jid || '';  // e.g. "919901234567@s.whatsapp.net"
      const lidJid = participant.lid || ''; // e.g. "261129817338018@lid"
      const rawId = participant.id || '';   // could be either format

      // Extract phone digits from the @s.whatsapp.net JID
      const pnDigits = pnJid.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
      // If no pn JID, try extracting from id (only useful when id is @s.whatsapp.net format)
      const idDigits = rawId.endsWith('@lid')
        ? '' // LID digits are not phone numbers
        : rawId.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');

      const phone = pnDigits || idDigits;
      const bestJid = pnJid || rawId;
      // Push name (notify) or verifiedName from the participant metadata
      const name = participant.notify || participant.verifiedName || participant.name || '';

      return { phone, jid: bestJid, name };
    }).filter((item) => item.phone.length > 0);
  }

  async sendMessageWithButtons(
    phoneNumber: string,
    message: string,
    buttons: Array<{ text: string; url?: string; phoneNumber?: string }>,
    includeStopButton = false
  ): Promise<any> {
    if (!this.socket || !this.status.isConnected) {
      throw new Error('WhatsApp not connected');
    }

    // Baileys v6.x doesn't fully support new interactive message format yet
    // Using text fallback with clear formatting for better compatibility
    let fullMessage = message + '\n\n';

    // Add buttons as clickable links
    for (const btn of buttons) {
      if (btn.url) {
        fullMessage += `🔗 ${btn.text}: ${btn.url}\n`;
      } else if (btn.phoneNumber) {
        fullMessage += `📞 ${btn.text}: ${btn.phoneNumber}\n`;
      } else {
        fullMessage += `✅ ${btn.text}\n`;
      }
    }

    // Add stop message option
    if (includeStopButton) {
      fullMessage += '\n━━━━━━━━━━━━━━━━━━━━\n';
      fullMessage += '🚫 *To stop receiving messages*\n';
      fullMessage += 'Reply with: *STOP*\n';
    }

    // Use regular text message - URLs are auto-clickable in WhatsApp
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
      messageContent = { image: fileBuffer, caption: caption };
    } else if (['.mp3', '.ogg', '.wav', '.m4a', '.aac'].includes(fileExtension)) {
      const audioMimeTypeMap: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
      };

      // Only OGG Opus can be sent as voice note (ptt: true).
      // MP3/WAV/M4A/AAC are sent as regular audio so WhatsApp can play them.
      const isOggOpus = fileExtension === '.ogg';
      messageContent = {
        audio: fileBuffer,
        mimetype: audioMimeTypeMap[fileExtension] || 'audio/mpeg',
        ptt: isOggOpus,
      };
      console.log(`[WhatsAppService] Sending audio ${isOggOpus ? 'voice note' : 'file'} to ${jid} (${path.basename(filePath)}, ${messageContent.mimetype}, ptt=${isOggOpus})`);
    } else if (['.pdf', '.doc', '.docx', '.txt'].includes(fileExtension)) {
      messageContent = { document: fileBuffer, fileName: path.basename(filePath), caption: caption };
    } else {
      messageContent = { document: fileBuffer, fileName: path.basename(filePath), caption: caption };
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
      caption: caption,
      timestamp: Date.now(),
    };
  }

  async generateQRCode(): Promise<void> {
    console.log('🔄 QR generation requested');

    // Always disconnect and clean up before generating new QR
    // This ensures old connections don't interfere
    if (this.socket) {
      console.log('🔌 Disconnecting existing connection before generating QR...');
      try {
        await this.socket.logout();
      } catch (error) {
        console.log('⚠️ Error during logout (ignoring):', error instanceof Error ? error.message : 'Unknown');
      }
    }

    // Clean up existing connection and clear auth state
    await this.cleanup();
    await this.clearAuthState();

    console.log('🔄 Starting fresh connection for QR generation...');
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    console.log('🔌 Disconnecting WhatsApp...');

    if (this.socket) {
      try {
        // Logout properly to clear auth state
        await this.socket.logout();
      } catch (error) {
        console.log('⚠️ Error during logout:', error instanceof Error ? error.message : 'Unknown error');
      }
    }

    await this.cleanup();

    // Clear file-based auth state
    await this.clearAuthState();

    this.emit('whatsapp-auth-failure', { error: 'Disconnected' });
  }

  getCurrentQR(): { qr: string; timestamp: number } | null {
    return this.currentQR;
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status };
  }

  /**
   * Resolve the JID to use for outgoing messages.
   * Preserve full JIDs when callers already know the exact recipient.
   */
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

    // senderPn carries the actual phone number in many @lid conversations.
    const senderDigits = senderValue.replace(/\D/g, '');
    if (senderDigits.length >= 10) {
      return senderDigits;
    }

    // Fallback to remoteJid parsing.
    const fromDigits = fromValue.replace(/@s\.whatsapp\.net$|@lid$/i, '').replace(/\D/g, '');
    if (fromDigits.length > 0) {
      return fromDigits;
    }

    return fromValue;
  }

  private formatPhoneNumber(phoneNumber: string): string {
    // Remove all non-digit characters
    let cleaned = phoneNumber.replace(/\D/g, '');

    // If number doesn't start with country code and is 10 digits, assume India (+91)
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
      console.log('🧹 Cleaning up Baileys connection...');
      this.socket.end(undefined);
      this.socket = null;
    }

    this.status = {
      isConnected: false,
      isAuthenticated: false,
      lastSeen: null,
      sessionInfo: null,
    };

    this.currentQR = null;
  }

  private async clearAuthState(): Promise<void> {
    try {
      console.log(`🗑️ Clearing auth state at "${this.authPath}"...`);
      if (fs.existsSync(this.authPath)) {
        fs.rmSync(this.authPath, { recursive: true, force: true });
        console.log('✅ Auth state directory removed');
      } else {
        console.log('ℹ️ Auth state directory does not exist, nothing to clear');
      }
    } catch (error) {
      console.error('⚠️ Failed to clear auth state:', error);
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

  /**
   * Clear stale Signal protocol sessions while preserving QR auth credentials.
   * Removes session/pre-key/sender-key files but keeps creds.json + app-state-sync-key files.
   * After clearing, the connection is re-initialized to rebuild fresh sessions.
   */
  async clearSignalSessions(): Promise<{ cleared: number; kept: number }> {
    let cleared = 0;
    let kept = 0;

    try {
      if (!fs.existsSync(this.authPath)) {
        console.log('ℹ️ No auth directory to clean');
        return { cleared, kept };
      }

      const keepPrefixes = ['creds', 'app-state-sync-key', 'app-state-sync-version'];
      const files = fs.readdirSync(this.authPath);

      for (const file of files) {
        const shouldKeep = keepPrefixes.some(prefix => file.startsWith(prefix));
        if (shouldKeep) {
          kept++;
        } else {
          fs.unlinkSync(path.join(this.authPath, file));
          cleared++;
        }
      }

      console.log(`🧹 Signal session cleanup: cleared ${cleared} files, kept ${kept}`);

      // Disconnect and re-initialize to rebuild fresh sessions
      if (this.socket) {
        this.socket.end(undefined);
        this.socket = null;
      }
      this.status.isConnected = false;
      this.status.isAuthenticated = false;

      // Re-initialize with clean sessions
      await this.initialize();

    } catch (error) {
      console.error('⚠️ Failed to clear signal sessions:', error);
    }

    return { cleared, kept };
  }
}

export const whatsAppService = new WhatsAppService();

