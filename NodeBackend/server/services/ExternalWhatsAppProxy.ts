/**
 * ExternalWhatsAppProxy
 *
 * Drop-in replacement for the local WhatsApp sender that proxies WhatsApp
 * operations through the proven working app. This proxy deliberately uses only
 * the working app endpoints backed by MultiUserWhatsAppService.
 */

import { EventEmitter } from 'events';

export interface WhatsAppStatus {
  isConnected: boolean;
  isAuthenticated: boolean;
  lastSeen: Date | null;
  sessionInfo: any;
}

type QRPayload = {
  qr: string;
  qrCode: string;
  rawQR: string;
  timestamp: number;
};

export class ExternalWhatsAppProxy extends EventEmitter {
  private status: WhatsAppStatus = {
    isConnected: false,
    isAuthenticated: false,
    lastSeen: null,
    sessionInfo: null,
  };

  private currentQR: QRPayload | null = null;
  private baseUrl: string;
  private apiKey: string;
  private userId: string;
  private sessionId: string | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(_sessionDir?: string, userId?: string, baseUrlOverride?: string) {
    super();
    this.userId = userId || 'default';
    this.baseUrl = (baseUrlOverride || process.env.EXTERNAL_WA_API_URL || '').replace(/\/+$/, '');
    this.apiKey = process.env.EXTERNAL_WA_API_KEY || 'whatsapp-lims-api-key-2024';
  }

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

    const options: RequestInit = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const json = await response.json();

    if (!response.ok) {
      const errorMessage = json?.message || json?.error || `HTTP ${response.status}`;
      throw new Error(`External WA API error: ${errorMessage}`);
    }

    return json;
  }

  private getNestedData<T = any>(response: any): T {
    return (response?.data ?? response) as T;
  }

  private extractSessionRecord(statusResponse: any): any | null {
    const data = this.getNestedData<any>(statusResponse);
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    return sessions[0] || null;
  }

  private applyConnectedState(sessionInfo?: any): void {
    this.status.isConnected = true;
    this.status.isAuthenticated = true;
    this.status.lastSeen = new Date();
    this.status.sessionInfo = sessionInfo || null;
    this.currentQR = null;
    this.sessionId = sessionInfo?.sessionId || this.sessionId;
  }

  private buildQrImageUrl(rawQr: string): string {
    return `https://quickchart.io/qr?size=512&margin=4&ecLevel=M&text=${encodeURIComponent(rawQr)}`;
  }

  private applyDisconnectedState(sessionInfo?: any): void {
    this.status.isConnected = false;
    this.status.isAuthenticated = Boolean(sessionInfo?.isAuthenticated);
    this.status.sessionInfo = sessionInfo || null;
  }

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
      console.log(`[ExtProxy] User ${this.userId} synced to external app`);
    } catch (error: any) {
      console.warn(`[ExtProxy] User sync failed (non-fatal): ${error.message}`);
    }
  }

  async initialize(): Promise<void> {
    try {
      console.log(`[ExtProxy] Connecting user ${this.userId} via external app at ${this.baseUrl}`);
      await this.syncUser();

      // Use the working app's user-scoped connect endpoint.
      const connectRes = await this.request('POST', `/api/users/${this.userId}/whatsapp/connect`);
      const connectData = this.getNestedData<any>(connectRes);

      if (connectData?.qrCode) {
        const rawQR = connectData.qrCode;
        const qr = connectData.qrCodeUrl || this.buildQrImageUrl(rawQR);
        this.currentQR = { qr, qrCode: qr, rawQR, timestamp: Date.now() };
        this.emit('qr-code', { qr, qrCode: qr, rawQR });
      }

      const statusRes = await this.request('GET', `/api/users/${this.userId}/whatsapp/status`);
      const sessionInfo = this.extractSessionRecord(statusRes);

      if (sessionInfo?.isConnected || sessionInfo?.isAuthenticated) {
        console.log(`[ExtProxy] User ${this.userId} already authenticated`);
        this.applyConnectedState(sessionInfo);
        this.emit('whatsapp-authenticated', { status: this.status });
        this.startHealthPolling();
        return;
      }

      this.applyDisconnectedState(sessionInfo);
      this.startQRPolling();
    } catch (error: any) {
      console.error('[ExtProxy] Initialize failed:', error.message);
      this.emit('whatsapp-auth-failure', { error: error.message });
    }
  }

  private startQRPolling(): void {
    this.stopPolling();

    let attempts = 0;
    const maxAttempts = 30;

    this.pollingTimer = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts) {
        console.log(`[ExtProxy] QR polling timed out for user ${this.userId}`);
        this.stopPolling();
        this.emit('whatsapp-auth-failure', { error: 'QR scan timed out' });
        return;
      }

      try {
        const [pulseRes, statusRes] = await Promise.all([
          this.request('POST', '/api/external/sessions/pulse', { userId: this.userId }),
          this.request('GET', `/api/users/${this.userId}/whatsapp/status`),
        ]);

        const pulse = this.getNestedData<any>(pulseRes);
        const sessionInfo = this.extractSessionRecord(statusRes);

        if (pulse?.alive && pulse?.isAuthenticated) {
          console.log(`[ExtProxy] User ${this.userId} authenticated via external app`);
          this.applyConnectedState(sessionInfo);
          this.stopPolling();
          this.emit('whatsapp-authenticated', { status: this.status });
          this.startHealthPolling();
          return;
        }

        // Best-effort QR refresh using the working app's refresh endpoint.
        if (!this.currentQR && attempts % 5 === 0) {
          try {
            const refreshRes = await this.request('POST', `/api/users/${this.userId}/whatsapp/refresh-qr`);
            const refreshData = this.getNestedData<any>(refreshRes);
            if (refreshData?.qrCode) {
              const rawQR = refreshData.qrCode;
              const qr = refreshData.qrCodeUrl || this.buildQrImageUrl(rawQR);
              this.currentQR = { qr, qrCode: qr, rawQR, timestamp: Date.now() };
              this.emit('qr-code', { qr, qrCode: qr, rawQR });
            }
          } catch {
            // Ignore refresh failures while polling.
          }
        }
      } catch (error: any) {
        console.warn(`[ExtProxy] Poll error: ${error.message}`);
      }
    }, 2000);
  }

  private startHealthPolling(): void {
    this.stopPolling();

    this.pollingTimer = setInterval(async () => {
      try {
        const [pulseRes, statusRes] = await Promise.all([
          this.request('POST', '/api/external/sessions/pulse', { userId: this.userId }),
          this.request('GET', `/api/users/${this.userId}/whatsapp/status`),
        ]);

        const pulse = this.getNestedData<any>(pulseRes);
        const sessionInfo = this.extractSessionRecord(statusRes);
        const wasConnected = this.status.isConnected;

        this.status.isConnected = Boolean(pulse?.alive && pulse?.isAuthenticated);
        this.status.isAuthenticated = Boolean(pulse?.isAuthenticated);
        this.status.sessionInfo = sessionInfo || null;
        if (this.status.isConnected) {
          this.status.lastSeen = new Date();
        }

        if (wasConnected && !this.status.isConnected) {
          console.warn(`[ExtProxy] User ${this.userId} lost connection on external app`);
          this.emit('whatsapp-auth-failure', { error: 'External session disconnected' });
        }
      } catch {
        // Ignore transient network errors and retry on next interval.
      }
    }, 30000);
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  async sendTextMessage(phoneNumber: string, message: string): Promise<any> {
    const response = await this.request('POST', '/api/external/messages/send-user', {
      userId: this.userId,
      phoneNumber: this.formatOutgoingPhoneNumber(phoneNumber),
      message,
    });

    const data = this.getNestedData<any>(response);
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

  async sendMediaMessage(phoneNumber: string, filePath: string, caption?: string): Promise<any> {
    const fs = await import('fs');
    const path = await import('path');

    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      const response = await this.request('POST', '/api/external/reports/send-url', {
        userId: this.userId,
        phoneNumber: this.formatOutgoingPhoneNumber(phoneNumber),
        fileUrl: filePath,
        caption: caption || '',
      });
      const data = this.getNestedData<any>(response);
      this.status.lastSeen = new Date();
      return { id: data.messageId, to: phoneNumber, hasMedia: true, caption, timestamp: Date.now() };
    }

    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    if (this.sessionId) {
      const form = new FormData();
      form.append('sessionId', this.sessionId);
      form.append('phoneNumber', this.formatOutgoingPhoneNumber(phoneNumber));
      form.append('content', caption || '');
      form.append('file', new Blob([new Uint8Array(fileBuffer)]), fileName);

      const response = await fetch(`${this.baseUrl}/api/external/reports/send`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: form,
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(`External WA API error: ${json?.message || response.status}`);
      }
      const data = this.getNestedData<any>(json);
      this.status.lastSeen = new Date();
      return { id: data.messageId, to: phoneNumber, hasMedia: true, caption, timestamp: Date.now() };
    }

    throw new Error('No external session available for file upload');
  }

  async sendMessageWithButtons(
    phoneNumber: string,
    message: string,
    buttons: Array<{ text: string; url?: string; phoneNumber?: string }>,
    includeStopButton = false,
  ): Promise<any> {
    let fullMessage = message + '\n\n';
    for (const button of buttons) {
      if (button.url) fullMessage += `Link ${button.text}: ${button.url}\n`;
      else if (button.phoneNumber) fullMessage += `Call ${button.text}: ${button.phoneNumber}\n`;
      else fullMessage += `${button.text}\n`;
    }
    if (includeStopButton) {
      fullMessage += '\nTo stop receiving messages, reply STOP\n';
    }
    return this.sendTextMessage(phoneNumber, fullMessage.trim());
  }

  async listGroups(): Promise<Array<{ id: string; subject: string; participantsCount: number }>> {
    console.warn('[ExtProxy] listGroups not available via external API');
    return [];
  }

  async scrapeGroupNumbers(_groupId: string): Promise<Array<{ phone: string; jid: string; name: string }>> {
    console.warn('[ExtProxy] scrapeGroupNumbers not available via external API');
    return [];
  }

  async generateQRCode(): Promise<void> {
    this.status.isConnected = false;
    this.status.isAuthenticated = false;
    this.currentQR = null;
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    console.log(`[ExtProxy] Disconnecting user ${this.userId}`);
    this.stopPolling();

    try {
      await this.request('POST', '/api/external/sessions/disconnect', {
        userId: this.userId,
      });
    } catch (error: any) {
      console.warn(`[ExtProxy] Disconnect error: ${error.message}`);
    }

    this.status.isConnected = false;
    this.status.isAuthenticated = false;
    this.currentQR = null;
    this.sessionId = null;
    this.emit('whatsapp-auth-failure', { error: 'Disconnected' });
  }

  getCurrentQR(): QRPayload | null {
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
    this.sessionId = null;
  }

  async clearSignalSessions(): Promise<{ cleared: number; kept: number }> {
    return { cleared: 0, kept: 0 };
  }

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
