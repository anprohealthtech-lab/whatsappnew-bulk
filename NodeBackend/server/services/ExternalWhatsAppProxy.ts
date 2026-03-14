/**
 * ExternalWhatsAppProxy
 * 
 * Drop-in replacement for WhatsAppService that proxies all WhatsApp operations
 * through the WHATSAPP-PERSISTENT external app's API. This is used when
 * EXTERNAL_WA_API_URL env var is set, routing QR, connect, send, and disconnect
 * through the working app while keeping everything else (campaigns, chatbot, UI) local.
 * 
 * Env vars:
 *   EXTERNAL_WA_API_URL  – base URL of the persistent app (e.g. https://whatsapp-app.ondigitalocean.app)
 *   EXTERNAL_WA_API_KEY  – API key for x-api-key header (default: whatsapp-lims-api-key-2024)
 */

import { EventEmitter } from 'events';

export interface WhatsAppStatus {
  isConnected: boolean;
  isAuthenticated: boolean;
  lastSeen: Date | null;
  sessionInfo: any;
}

export class ExternalWhatsAppProxy extends EventEmitter {
  private status: WhatsAppStatus = {
    isConnected: false,
    isAuthenticated: false,
    lastSeen: null,
    sessionInfo: null,
  };
  private currentQR: { qr: string; timestamp: number } | null = null;
  private baseUrl: string;
  private apiKey: string;
  private userId: string;
  private sessionId: string | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(_sessionDir?: string, userId?: string) {
    super();
    this.userId = userId || 'default';
    this.baseUrl = (process.env.EXTERNAL_WA_API_URL || '').replace(/\/+$/, '');
    this.apiKey = process.env.EXTERNAL_WA_API_KEY || 'whatsapp-lims-api-key-2024';
  }

  // ─── HTTP helper ──────────────────────────────────────────────

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, any>,
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const json = await res.json();

    if (!res.ok) {
      const errMsg = json?.message || json?.error || `HTTP ${res.status}`;
      throw new Error(`External WA API error: ${errMsg}`);
    }
    return json;
  }

  // ─── Sync user to external app ────────────────────────────────

  private async syncUser(): Promise<void> {
    try {
      await this.request('POST', '/api/external/users/sync', {
        id: this.userId,
        email: `user-${this.userId}@placeholder.local`,
        username: `user-${this.userId}`,
        role: 'user',
        is_active: true,
        whatsapp_enabled: true,
      });
      console.log(`🔗 [ExtProxy] User ${this.userId} synced to external app`);
    } catch (err: any) {
      console.warn(`⚠️ [ExtProxy] User sync failed (non-fatal): ${err.message}`);
    }
  }

  // ─── Initialize (connect + get QR) ───────────────────────────

  async initialize(): Promise<void> {
    try {
      console.log(`🚀 [ExtProxy] Connecting user ${this.userId} via external app at ${this.baseUrl}`);

      // 1. Sync user
      await this.syncUser();

      // 2. Create session
      const createRes = await this.request('POST', '/api/external/sessions/create', {
        userId: this.userId,
        organizationId: this.userId,
        strategy: 'always_on',
        userInfo: {
          username: `user-${this.userId}`,
          role: 'user',
        },
      });

      const data = createRes.data || createRes;
      this.sessionId = data.sessionId;

      if (data.isAuthenticated) {
        console.log(`✅ [ExtProxy] User ${this.userId} already authenticated`);
        this.status.isConnected = true;
        this.status.isAuthenticated = true;
        this.status.lastSeen = new Date();
        this.currentQR = null;
        this.emit('whatsapp-authenticated', { status: this.status });
        this.startHealthPolling();
        return;
      }

      if (data.qrCode) {
        const qrUrl = data.qrCodeUrl || data.qrCode;
        this.currentQR = { qr: qrUrl, timestamp: Date.now() };
        this.emit('qr-code', { qr: qrUrl, rawQR: data.qrCode });
        console.log(`📱 [ExtProxy] QR code received for user ${this.userId}`);
      }

      // 3. Start polling for auth status
      this.startQRPolling();
    } catch (error: any) {
      console.error(`❌ [ExtProxy] Initialize failed:`, error.message);
      this.emit('whatsapp-auth-failure', { error: error.message });
    }
  }

  // ─── QR polling until authenticated ───────────────────────────

  private startQRPolling(): void {
    this.stopPolling();

    let attempts = 0;
    const maxAttempts = 30; // ~60 seconds at 2s interval

    this.pollingTimer = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts) {
        console.log(`⏱️ [ExtProxy] QR polling timed out for user ${this.userId}`);
        this.stopPolling();
        this.emit('whatsapp-auth-failure', { error: 'QR scan timed out' });
        return;
      }

      try {
        const pulse = await this.request('POST', '/api/external/sessions/pulse', {
          userId: this.userId,
        });

        if (pulse.isAuthenticated && pulse.alive) {
          console.log(`✅ [ExtProxy] User ${this.userId} authenticated via external app`);
          this.status.isConnected = true;
          this.status.isAuthenticated = true;
          this.status.lastSeen = new Date();
          this.currentQR = null;
          this.stopPolling();
          this.emit('whatsapp-authenticated', { status: this.status });
          this.startHealthPolling();
          return;
        }

        // Check for fresh QR
        if (this.sessionId) {
          try {
            const qrRes = await this.request('GET', `/api/external/sessions/${this.sessionId}/qr`);
            const qrData = qrRes.data || qrRes;
            if (qrData.isAuthenticated) {
              this.status.isConnected = true;
              this.status.isAuthenticated = true;
              this.status.lastSeen = new Date();
              this.currentQR = null;
              this.stopPolling();
              this.emit('whatsapp-authenticated', { status: this.status });
              this.startHealthPolling();
              return;
            }
            if (qrData.qrCode) {
              const qrUrl = qrData.qrCodeUrl || qrData.qrCode;
              if (this.currentQR?.qr !== qrUrl) {
                this.currentQR = { qr: qrUrl, timestamp: Date.now() };
                this.emit('qr-code', { qr: qrUrl, rawQR: qrData.qrCode });
              }
            }
          } catch {
            // QR endpoint may fail if session not ready yet — ignore
          }
        }
      } catch (err: any) {
        console.warn(`⚠️ [ExtProxy] Poll error: ${err.message}`);
      }
    }, 2000);
  }

  // ─── Health polling (after authenticated) ─────────────────────

  private startHealthPolling(): void {
    this.stopPolling();

    this.pollingTimer = setInterval(async () => {
      try {
        const pulse = await this.request('POST', '/api/external/sessions/pulse', {
          userId: this.userId,
        });

        const wasConnected = this.status.isConnected;
        this.status.isConnected = pulse.alive && pulse.isAuthenticated;
        this.status.isAuthenticated = pulse.isAuthenticated;
        if (this.status.isConnected) {
          this.status.lastSeen = new Date();
        }

        // Detect disconnect
        if (wasConnected && !this.status.isConnected) {
          console.warn(`⚠️ [ExtProxy] User ${this.userId} lost connection on external app`);
          this.emit('whatsapp-auth-failure', { error: 'External session disconnected' });
        }
      } catch {
        // Network error — don't change status, will retry next interval
      }
    }, 30000); // every 30 seconds
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  // ─── Send text message ────────────────────────────────────────

  async sendTextMessage(phoneNumber: string, message: string): Promise<any> {
    const res = await this.request('POST', '/api/external/messages/send-user', {
      userId: this.userId,
      phoneNumber: this.formatOutgoingPhoneNumber(phoneNumber),
      message,
    });

    const data = res.data || res;
    this.status.lastSeen = new Date();

    this.emit('message-sent', {
      messageId: data.messageId,
      to: phoneNumber,
      timestamp: Date.now(),
    });

    return {
      id: data.messageId,
      to: phoneNumber,
      body: message,
      timestamp: Date.now(),
    };
  }

  // ─── Send media / document ────────────────────────────────────

  async sendMediaMessage(phoneNumber: string, filePath: string, caption?: string): Promise<any> {
    // Use the URL-based endpoint if filePath looks like a URL; otherwise read the file
    // and use multipart. For simplicity with the external API, we'll use send-url if possible.

    const fs = await import('fs');
    const path = await import('path');

    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      const res = await this.request('POST', '/api/external/reports/send-url', {
        userId: this.userId,
        phoneNumber: this.formatOutgoingPhoneNumber(phoneNumber),
        fileUrl: filePath,
        caption: caption || '',
      });
      const data = res.data || res;
      this.status.lastSeen = new Date();
      return { id: data.messageId, to: phoneNumber, hasMedia: true, caption, timestamp: Date.now() };
    }

    // Local file: read and send as multipart form-data
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const formData = new FormData();
    formData.append('userId', this.userId);
    formData.append('phoneNumber', this.formatOutgoingPhoneNumber(phoneNumber));
    formData.append('content', caption || '');
    // We need a sessionId for the multipart report endpoint. 
    // The user-based send-url is simpler, so let's convert local file to a simulated URL approach.
    // Actually, the /api/external/reports/send endpoint expects sessionId which we may not have.
    // Let's use a different approach: send as text with the file uploaded through our own persistent storage.

    // Simplest approach: use the user-based URL endpoint with a data URI is not supported.
    // Instead, we'll directly call the session-based endpoint with our sessionId.
    if (this.sessionId) {
      const url = `${this.baseUrl}/api/external/reports/send`;
      const form = new FormData();
      form.append('sessionId', this.sessionId);
      form.append('phoneNumber', this.formatOutgoingPhoneNumber(phoneNumber));
      form.append('content', caption || '');
      form.append('file', new Blob([new Uint8Array(fileBuffer)]), fileName);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: form,
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(`External WA API error: ${json?.message || response.status}`);
      }
      const data = json.data || json;
      this.status.lastSeen = new Date();
      return { id: data.messageId, to: phoneNumber, hasMedia: true, caption, timestamp: Date.now() };
    }

    throw new Error('No external session available for file upload');
  }

  // ─── Send message with buttons (text fallback) ────────────────

  async sendMessageWithButtons(
    phoneNumber: string,
    message: string,
    buttons: Array<{ text: string; url?: string; phoneNumber?: string }>,
    includeStopButton = false,
  ): Promise<any> {
    // Build text fallback (same as original WhatsAppService)
    let fullMessage = message + '\n\n';
    for (const btn of buttons) {
      if (btn.url) fullMessage += `🔗 ${btn.text}: ${btn.url}\n`;
      else if (btn.phoneNumber) fullMessage += `📞 ${btn.text}: ${btn.phoneNumber}\n`;
      else fullMessage += `✅ ${btn.text}\n`;
    }
    if (includeStopButton) {
      fullMessage += '\n━━━━━━━━━━━━━━━━━━━━\n🚫 *To stop receiving messages*\nReply with: *STOP*\n';
    }
    return this.sendTextMessage(phoneNumber, fullMessage.trim());
  }

  // ─── Groups (not supported via external — return empty) ───────

  async listGroups(): Promise<Array<{ id: string; subject: string; participantsCount: number }>> {
    console.warn('[ExtProxy] listGroups not available via external API');
    return [];
  }

  async scrapeGroupNumbers(_groupId: string): Promise<Array<{ phone: string; jid: string; name: string }>> {
    console.warn('[ExtProxy] scrapeGroupNumbers not available via external API');
    return [];
  }

  // ─── QR / Status / Disconnect ─────────────────────────────────

  async generateQRCode(): Promise<void> {
    console.log('🔄 [ExtProxy] QR generation requested — re-initializing');
    this.status.isConnected = false;
    this.status.isAuthenticated = false;
    this.currentQR = null;
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    console.log(`🔌 [ExtProxy] Disconnecting user ${this.userId}`);
    this.stopPolling();

    if (this.sessionId) {
      try {
        await this.request('DELETE', `/api/external/sessions/${this.sessionId}`);
      } catch (err: any) {
        console.warn(`⚠️ [ExtProxy] Disconnect error: ${err.message}`);
      }
    }

    this.status.isConnected = false;
    this.status.isAuthenticated = false;
    this.currentQR = null;
    this.sessionId = null;
    this.emit('whatsapp-auth-failure', { error: 'Disconnected' });
  }

  getCurrentQR(): { qr: string; timestamp: number } | null {
    return this.currentQR;
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status };
  }

  async cleanup(): Promise<void> {
    this.stopPolling();
    this.status = {
      isConnected: false,
      isAuthenticated: false,
      lastSeen: null,
      sessionInfo: null,
    };
    this.currentQR = null;
  }

  // Stubs for compatibility with WhatsAppService interface
  async clearSignalSessions(): Promise<{ cleared: number; kept: number }> {
    return { cleared: 0, kept: 0 };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private formatOutgoingPhoneNumber(phoneNumber: string): string {
    if (phoneNumber.includes('@')) {
      return phoneNumber;
    }

    let cleaned = phoneNumber.replace(/\D/g, '');
    if (!cleaned.startsWith('91') && cleaned.length === 10) {
      cleaned = '91' + cleaned;
    }
    return cleaned;
  }
}
