import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
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
  private currentQR: string | null = null;
  private badSessionRetryCount: number = 0;
  private static readonly MAX_BAD_SESSION_RETRIES = 3;
  private userId: string;

  /**
   * LID JID Cache: maps phone digits → actual JID (preferring @lid over @s.whatsapp.net).
   * Populated from every incoming message so outbound messages use the correct encryption session.
   * Persisted to disk alongside auth state to survive restarts.
   */
  private lidJidCache = new Map<string, string>();

  private get lidCachePath(): string {
    return path.join(this.authPath, 'lid-cache.json');
  }

  constructor(sessionDir?: string, userId?: string) {
    super();
    this.userId = userId || 'default';
    this.authPath = sessionDir
      ? path.join(process.cwd(), sessionDir, 'baileys_auth')
      : path.join(process.cwd(), 'server/sessions/baileys_auth');
    if (!fs.existsSync(this.authPath)) {
      fs.mkdirSync(this.authPath, { recursive: true });
    }
  }

  async initialize(): Promise<void> {
    try {
      console.log('🚀 Starting Baileys WhatsApp - no Chrome needed!');

      // Clean up any existing socket first
      if (this.socket) {
        this.socket.end(undefined);
        this.socket = null;
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
      const { version } = await fetchLatestBaileysVersion();

      // Load persisted LID cache from disk
      this.loadLidCache();

      // Wrap signal keys with in-memory cache for faster encryption key lookups
      // This prevents "waiting for this message" caused by missing/slow signal keys
      const logger = pino({ level: 'silent' });

      this.socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        printQRInTerminal: false,
        // Unique browser fingerprint per user to avoid session conflicts
        browser: [`WhatsApp-${this.userId}`, 'Chrome', '10.0'],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        // Add retry configuration
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        // Return undefined so Baileys skips the retry-encrypt path.
        // Returning cached message data causes Baileys to re-encrypt for every
        // linked device, triggering "Closing stale open session" loops.
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

      // Listen for contact updates to build phone ↔ LID mapping
      this.socket.ev.on('contacts.upsert', (contacts: any[]) => {
        for (const contact of contacts) {
          // contact.id might be @lid or @s.whatsapp.net
          // contact.lid is the @lid JID (if available)
          // contact.jid is @s.whatsapp.net (if available, sometimes only on groups)
          // contact.notify / contact.name are display names
          const lid = contact.lid || (contact.id?.endsWith?.('@lid') ? contact.id : '');
          const pnJid = contact.jid || (contact.id?.endsWith?.('@s.whatsapp.net') ? contact.id : '');
          const phone = pnJid ? pnJid.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '') : '';

          if (phone && lid) {
            this.cacheJid(phone, lid);
          }
        }
      });

      // Also listen for contacts.update (partial updates)
      this.socket.ev.on('contacts.update', (updates: any[]) => {
        for (const update of updates) {
          const lid = update.lid || (update.id?.endsWith?.('@lid') ? update.id : '');
          const pnJid = update.jid || (update.id?.endsWith?.('@s.whatsapp.net') ? update.id : '');
          const phone = pnJid ? pnJid.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '') : '';

          if (phone && lid) {
            this.cacheJid(phone, lid);
          }
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

        // Cache the sender's LID JID for outbound resolution
        // When senderPn is available, we know the real phone → cache phone→LID
        // When senderPn is missing and from is @lid, cache LID digits→LID (for reply flow)
        if (from && from.endsWith('@lid')) {
          if (senderPn) {
            // Best case: we know the real phone number for this LID
            const pnDigits = senderPn.replace(/\D/g, '');
            if (pnDigits.length >= 10) {
              this.cacheJid(pnDigits, from);
            }
          }
          // Always cache LID digits → LID JID for reply routing
          this.cacheJid(phoneNumber, from);
        }

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

      // Cache the LID → phone mapping for outbound message resolution
      if (phone && lidJid) {
        this.cacheJid(phone, lidJid);
      }
      if (phone && pnJid) {
        // Also register the pn JID (cacheJid will prefer @lid if already cached)
        this.cacheJid(phone, pnJid);
      }

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

    // Clear auth files to force fresh QR generation
    try {
      const fsPromises = fs.promises;
      if (fs.existsSync(this.authPath)) {
        await fsPromises.rm(this.authPath, { recursive: true, force: true });
        fs.mkdirSync(this.authPath, { recursive: true });
        console.log('🧹 Authentication files cleared');
      }
    } catch (error) {
      console.log('⚠️ Error clearing auth files:', error instanceof Error ? error.message : 'Unknown error');
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
   * Checks the LID cache first; falls back to @s.whatsapp.net for unknown contacts.
   */
  private resolveOutgoingJid(phoneNumber: string): string {
    // Already a full JID — return as-is (but force @s.whatsapp.net for @lid JIDs)
    if (phoneNumber.includes('@')) {
      if (phoneNumber.endsWith('@lid')) {
        // LID JIDs cause Signal session mismatches on outgoing — strip and use @s.whatsapp.net
        const digits = phoneNumber.replace(/@lid$/i, '').replace(/\D/g, '');
        return `${digits}@s.whatsapp.net`;
      }
      return phoneNumber;
    }

    const digits = this.formatPhoneNumber(phoneNumber);
    // Always use @s.whatsapp.net — the LID cache fights against Baileys'
    // internal session routing and causes "Closing stale open session" loops.
    return `${digits}@s.whatsapp.net`;
  }

  /**
   * Cache a phone number → JID mapping. Only stores @lid JIDs.
   * Caching @s.whatsapp.net is pointless — it's the default fallback.
   */
  private cacheJid(phoneDigits: string, jid: string): void {
    const digits = this.formatPhoneNumber(phoneDigits);

    // Only cache @lid JIDs — @s.whatsapp.net is already the fallback
    if (!jid.endsWith('@lid')) {
      return;
    }

    const existing = this.lidJidCache.get(digits);
    if (!existing || existing !== jid) {
      console.log(`[LID] 📥 Cached ${digits} → ${jid}${existing ? ` (was: ${existing})` : ''}`);
      this.lidJidCache.set(digits, jid);
      this.saveLidCache();
    }
  }

  /**
   * Public method for external code to register JID mappings.
   */
  registerJid(phoneDigits: string, jid: string): void {
    this.cacheJid(phoneDigits, jid);
  }

  /** Persist LID cache to disk so it survives server restarts */
  private saveLidCache(): void {
    try {
      const data = Object.fromEntries(this.lidJidCache);
      fs.writeFileSync(this.lidCachePath, JSON.stringify(data), 'utf-8');
    } catch { /* non-fatal */ }
  }

  /** Load persisted LID cache from disk */
  private loadLidCache(): void {
    try {
      if (fs.existsSync(this.lidCachePath)) {
        const data = JSON.parse(fs.readFileSync(this.lidCachePath, 'utf-8'));
        let loaded = 0;
        let skipped = 0;
        for (const [k, v] of Object.entries(data)) {
          // Only load @lid entries — purge stale @s.whatsapp.net from old cache
          if ((v as string).endsWith('@lid')) {
            this.lidJidCache.set(k, v as string);
            loaded++;
          } else {
            skipped++;
          }
        }
        console.log(`[LID] 📂 Loaded ${loaded} @lid mappings from disk${skipped ? ` (purged ${skipped} @s.whatsapp.net entries)` : ''}`);
        // Re-save to purge stale entries from the file
        if (skipped > 0) this.saveLidCache();
      }
    } catch (err) {
      console.warn('[LID] ⚠️ Could not load LID cache:', err);
    }
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
      console.log('🗑️ Clearing old auth state...');
      if (fs.existsSync(this.authPath)) {
        const files = fs.readdirSync(this.authPath);
        for (const file of files) {
          fs.unlinkSync(path.join(this.authPath, file));
        }
        console.log('✅ Auth state cleared successfully');
      }
    } catch (error) {
      console.error('⚠️ Failed to clear auth state:', error);
    }
  }

  /**
   * Clear stale Signal protocol sessions while preserving QR auth credentials.
   * Fixes "waiting for this message" caused by corrupted/stale encryption sessions.
   * After clearing, the connection is re-initialized to rebuild fresh sessions.
   */
  async clearSignalSessions(): Promise<{ cleared: number; kept: number }> {
    let cleared = 0;
    let kept = 0;

    try {
      if (!fs.existsSync(this.authPath)) {
        return { cleared: 0, kept: 0 };
      }

      const files = fs.readdirSync(this.authPath);
      // Keep: creds.json (QR auth), app-state-sync-key-* (app state), lid-cache.json (our cache)
      // Clear: session-* (Signal sessions), pre-key-* (pre-keys), sender-key-* (group keys)
      const keepPatterns = ['creds.json', 'app-state-sync-key', 'lid-cache.json'];

      for (const file of files) {
        const shouldKeep = keepPatterns.some(p => file.startsWith(p) || file === p);
        if (shouldKeep) {
          kept++;
        } else {
          fs.unlinkSync(path.join(this.authPath, file));
          cleared++;
        }
      }

      console.log(`🧹 Signal session cleanup: cleared ${cleared} files, kept ${kept} files`);

      // Also clear in-memory LID cache
      this.lidJidCache.clear();

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
