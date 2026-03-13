import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
  WASocket,
  downloadMediaMessage,
  proto,
  WAMessageKey,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { useDbAuthState, clearDbAuthState } from './useDbAuthState';

export interface WhatsAppStatus {
  isConnected: boolean;
  isAuthenticated: boolean;
  lastSeen: Date | null;
  sessionInfo: any;
}

export class WhatsAppService extends EventEmitter {
  private socket: WASocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private status: WhatsAppStatus = {
    isConnected: false,
    isAuthenticated: false,
    lastSeen: null,
    sessionInfo: null,
  };
  private authPath: string;
  private dbSessionId: string;
  private currentQR: string | null = null;
  private badSessionRetryCount: number = 0;
  private static readonly MAX_BAD_SESSION_RETRIES = 3;
  private userId: string;

  constructor(sessionDir?: string, userId?: string) {
    super();
    this.userId = userId || 'default';
    // DB session ID for auth state persistence
    this.dbSessionId = sessionDir
      ? `${sessionDir}`
      : `default_session`;
    // Keep authPath for media file operations only (not for auth state)
    this.authPath = sessionDir
      ? path.join(process.cwd(), sessionDir, 'baileys_auth')
      : path.join(process.cwd(), 'server/sessions/baileys_auth');
  }

  async initialize(): Promise<void> {
    try {
      console.log('🚀 Starting Baileys WhatsApp - no Chrome needed!');
      console.log(`📦 Auth state: DB session "${this.dbSessionId}"`);

      // Clean up any existing socket first
      if (this.socket) {
        this.socket.end(undefined);
        this.socket = null;
      }

      const { state, saveCreds } = await useDbAuthState(this.dbSessionId);
      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: [`WhatsApp-${this.userId}`, 'Chrome', '10.0'],
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

      this.socket.ev.on('creds.update', saveCreds);

      this.socket.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('📱 Baileys QR received!');
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qr)}`;
          this.currentQR = qrUrl;
          this.emit('qr-code', { qr: qrUrl, rawQR: qr });
          console.log('🎯 Baileys QR emitted to frontend');
        }

        if (connection === 'open') {
          console.log('✅ Connected via Baileys!');
          this.status.isConnected = true;
          this.status.isAuthenticated = true;
          this.status.lastSeen = new Date();
          this.currentQR = null;
          this.badSessionRetryCount = 0; // Reset on successful connection
          this.emit('whatsapp-authenticated', { status: this.status });
        } else if (connection === 'close') {
          console.log('❌ Baileys connection closed');
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          console.log(`🔍 Disconnect reason: ${statusCode} (${DisconnectReason[statusCode] || 'unknown'})`);

          this.status.isConnected = false;
          this.status.isAuthenticated = false;

          // Only reconnect for network issues, not for logout or manual disconnect
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const isBadSession = statusCode === DisconnectReason.badSession;
          const shouldReconnect = !isLoggedOut && !isBadSession && statusCode !== undefined;

          if (shouldReconnect) {
            console.log('🔄 Reconnecting in 30 seconds...');
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
            }
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this.initialize();
            }, 30000); // 30 seconds delay
          } else if (isBadSession) {
            this.badSessionRetryCount++;
            console.log(`⚠️ Bad session detected (attempt ${this.badSessionRetryCount}/${WhatsAppService.MAX_BAD_SESSION_RETRIES})`);

            if (this.badSessionRetryCount >= WhatsAppService.MAX_BAD_SESSION_RETRIES) {
              // Only clear auth after multiple consecutive failures
              console.log('🗑️ Max bad-session retries reached — clearing auth state for fresh QR...');
              await this.clearAuthState();
              this.currentQR = null;
              this.badSessionRetryCount = 0;
              this.emit('whatsapp-auth-failure', { error: 'Bad session, re-pair required' });
              if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
              }
              this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                console.log('🔄 Re-initializing after badSession cleanup...');
                this.initialize();
              }, 5000);
            } else {
              // Reconnect with existing credentials — session is likely still valid
              console.log('🔄 Reconnecting with existing credentials (stream error is often transient)...');
              if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
              }
              this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.initialize();
              }, 10000); // 10 seconds delay
            }
          } else {
            console.log('🚪 Logged out or connection closed - clearing auth and need new QR scan');
            await this.clearAuthState();
            this.currentQR = null;
            this.emit('whatsapp-auth-failure', { error: 'Logged out or disconnected' });
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

    const jid = this.resolveOutgoingJid(phoneNumber);
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

    const jid = this.resolveOutgoingJid(phoneNumber);
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

    // Clear auth state from DB
    try {
      const count = await clearDbAuthState(this.dbSessionId);
      console.log(`🧹 Cleared ${count} auth keys from DB for session "${this.dbSessionId}"`);
    } catch (error) {
      console.log('⚠️ Error clearing DB auth state:', error instanceof Error ? error.message : 'Unknown error');
    }

    this.emit('whatsapp-auth-failure', { error: 'Disconnected' });
  }

  getCurrentQR(): string | null {
    return this.currentQR;
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status };
  }

  /**
   * Resolve the JID to use for outgoing messages.
   * Always uses @s.whatsapp.net — never @lid for outgoing.
   */
  private resolveOutgoingJid(phoneNumber: string): string {
    if (phoneNumber.includes('@')) {
      if (phoneNumber.endsWith('@lid')) {
        const digits = phoneNumber.replace(/@lid$/i, '').replace(/\D/g, '');
        return `${digits}@s.whatsapp.net`;
      }
      return phoneNumber;
    }
    const digits = this.formatPhoneNumber(phoneNumber);
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
      console.log('🗑️ Clearing old auth state from DB...');
      const count = await clearDbAuthState(this.dbSessionId);
      console.log(`✅ Auth state cleared: ${count} keys removed for session "${this.dbSessionId}"`);
    } catch (error) {
      console.error('⚠️ Failed to clear auth state:', error);
    }
  }

  /**
   * Clear stale Signal protocol sessions while preserving QR auth credentials.
   * Removes session/pre-key/sender-key entries from DB but keeps creds + app-state-sync-key.
   * After clearing, the connection is re-initialized to rebuild fresh sessions.
   */
  async clearSignalSessions(): Promise<{ cleared: number; kept: number }> {
    let cleared = 0;
    let kept = 0;

    try {
      // Import DB helpers inline to avoid circular deps at module level
      const { db } = await import('../db');
      const { baileysAuthKeys } = await import('@shared/schema');
      const { eq, and } = await import('drizzle-orm');

      const rows = await db
        .select()
        .from(baileysAuthKeys)
        .where(eq(baileysAuthKeys.sessionId, this.dbSessionId));

      const keepCategories = ['creds', 'app-state-sync-key', 'app-state-sync-version'];

      for (const row of rows) {
        if (keepCategories.includes(row.category)) {
          kept++;
        } else {
          await db.delete(baileysAuthKeys).where(eq(baileysAuthKeys.id, row.id));
          cleared++;
        }
      }

      console.log(`🧹 Signal session cleanup: cleared ${cleared} DB keys, kept ${kept}`);

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
