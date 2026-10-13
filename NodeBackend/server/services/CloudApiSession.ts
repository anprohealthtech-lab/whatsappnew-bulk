/**
 * CloudApiSession — a WhatsApp transport backed by Meta's official WhatsApp
 * Cloud API (Graph API), implementing the same `WAServiceInstance` interface
 * as the Baileys session so every downstream service (lead chatbot, drips,
 * campaigns, HR/HIMS bots, notifications) works unchanged.
 *
 * Differences from Baileys:
 *  - No socket, no QR. The session is "connected" as long as the access token
 *    is valid for the phone number id.
 *  - Inbound messages are not pulled; Meta pushes them to the webhook route
 *    (`server/cloudApiRoutes.ts`), which calls `handleWebhookValue()` here.
 *    That method emits the same `incoming-message` / `button-clicked` events
 *    the Baileys session emits.
 *  - Free-form sends only reach a user within 24 h of their last inbound
 *    message. Outside that window an approved template must be used
 *    (`sendTemplateMessage()`).
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { log } from '../utils';
import type { WAServiceInstance, WhatsAppStatus } from './WhatsAppSessionManager';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_INBOUND_MEDIA_BYTES = parseInt(process.env.META_MAX_INBOUND_MEDIA_BYTES || String(25 * 1024 * 1024));
const SEEN_MESSAGE_IDS_MAX = 5000;

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.3gp': 'video/3gpp',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.amr': 'audio/amr', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip',
};

export interface CloudApiSessionConfig {
  userId: string;
  sessionName: string;
  phoneNumberId: string;
  wabaId?: string | null;
  accessToken: string;
  /** Display number in digits (e.g. 916358240913). Filled from Meta on initialize() if missing. */
  phoneNumber?: string | null;
}

export interface TemplateParam {
  type?: 'text';
  text: string;
}

export class GraphApiError extends Error {
  constructor(message: string, public readonly code?: number, public readonly subcode?: number, public readonly httpStatus?: number) {
    super(message);
    this.name = 'GraphApiError';
  }
}

export class CloudApiSession extends EventEmitter implements WAServiceInstance {
  /** Public on purpose: ChatbotService reads `whatsappService.status.isConnected` directly. */
  public status: WhatsAppStatus = {
    isConnected: false,
    isAuthenticated: false,
    lastSeen: null,
    sessionInfo: null,
  };

  public readonly provider = 'cloud_api' as const;
  readonly userId: string;
  readonly sessionName: string;
  readonly phoneNumberId: string;
  readonly wabaId: string | null;
  private accessToken: string;
  private phoneNumber: string | null;
  private verifiedName: string | null = null;
  private lastInboundAt = new Map<string, number>();
  private seenMessageIds = new Set<string>();

  constructor(config: CloudApiSessionConfig) {
    super();
    this.userId = config.userId;
    this.sessionName = config.sessionName;
    this.phoneNumberId = config.phoneNumberId;
    this.wabaId = config.wabaId || null;
    this.accessToken = config.accessToken;
    this.phoneNumber = config.phoneNumber ? CloudApiSession.digits(config.phoneNumber) : null;
  }

  // ------------------------------------------------------------ lifecycle

  async initialize(): Promise<void> {
    try {
      const info = await this.graph('GET', `/${this.phoneNumberId}`, {
        fields: 'display_phone_number,verified_name,quality_rating,platform_type,status',
      });
      this.phoneNumber = CloudApiSession.digits(info.display_phone_number || this.phoneNumber || '');
      this.verifiedName = info.verified_name || null;
      this.status = {
        isConnected: true,
        isAuthenticated: true,
        lastSeen: new Date(),
        sessionInfo: this.buildSessionInfo(info),
      };
      log(`[CloudAPI] Session ${this.userId}/${this.sessionName} ready on +${this.phoneNumber} (${this.verifiedName || 'no name'}, quality ${info.quality_rating || '?'})`);
      this.emit('whatsapp-authenticated', { status: this.status });
      this.emit('whatsapp-status', this.getStatus());
      this.emit('session-history', { event: 'connected', phoneNumber: this.phoneNumber, metadata: { provider: 'cloud_api' } });
    } catch (error) {
      this.status = { ...this.status, isConnected: false, isAuthenticated: false };
      const msg = error instanceof Error ? error.message : String(error);
      log(`[CloudAPI] Session ${this.userId}/${this.sessionName} failed to initialize: ${msg}`);
      this.emit('whatsapp-auth-failure', { reason: msg });
      this.emit('whatsapp-status', this.getStatus());
      this.emit('session-history', { event: 'auth_failure', reason: msg, metadata: { provider: 'cloud_api' } });
      throw error;
    }
  }

  private buildSessionInfo(info: any) {
    // Mirrors Baileys' `socket.user` shape closely enough for the code that
    // derives the owner identity (`id.split(':')[0]`, name).
    return {
      id: `${this.phoneNumber}:0@s.whatsapp.net`,
      name: this.verifiedName || info?.verified_name || 'WhatsApp Business',
      phoneNumber: this.phoneNumber,
      phoneNumberId: this.phoneNumberId,
      wabaId: this.wabaId,
      provider: 'cloud_api',
      qualityRating: info?.quality_rating,
    };
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status };
  }

  isAuthenticatedSelfChat(jid?: string | null): boolean {
    if (!jid || !this.phoneNumber) return false;
    return CloudApiSession.digits(jid) === this.phoneNumber;
  }

  getCurrentQR() {
    return null;
  }

  async generateQRCode(): Promise<void> {
    throw new Error('Cloud API sessions are linked through Meta, not by QR code');
  }

  async listGroups() {
    return [];
  }

  async scrapeGroupNumbers(_groupId: string) {
    return [];
  }

  async disconnect(): Promise<void> {
    this.status = { ...this.status, isConnected: false, isAuthenticated: false };
    this.emit('disconnected', { shouldReconnect: false, reason: 'manual' });
    this.emit('whatsapp-status', this.getStatus());
  }

  async cleanup(): Promise<void> {
    this.removeAllListeners();
  }

  updateAccessToken(token: string) {
    this.accessToken = token;
  }

  // ------------------------------------------------------------ outbound

  async sendTextMessage(phoneNumber: string, message: string): Promise<any> {
    const to = this.resolveRecipient(phoneNumber);
    this.warnIfOutsideWindow(to);
    const result = await this.graph('POST', `/${this.phoneNumberId}/messages`, undefined, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: message },
    });
    const id = result?.messages?.[0]?.id;
    this.status.lastSeen = new Date();
    return { id, to, body: message, timestamp: Date.now() };
  }

  async sendMediaMessage(phoneNumber: string, filePath: string, caption?: string, fileName?: string): Promise<any> {
    const to = this.resolveRecipient(phoneNumber);
    this.warnIfOutsideWindow(to);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Media file not found: ${filePath}`);
    }
    const ext = path.extname(fileName || filePath).toLowerCase();
    const mimetype = MIME_BY_EXT[ext] || 'application/octet-stream';
    const kind = mimetype.startsWith('image/') ? 'image'
      : mimetype.startsWith('video/') ? 'video'
      : mimetype.startsWith('audio/') ? 'audio'
      : 'document';

    const mediaId = await this.uploadMedia(filePath, mimetype, fileName);

    const media: Record<string, any> = { id: mediaId };
    if (kind === 'document') media.filename = fileName || path.basename(filePath);
    if (caption && kind !== 'audio') media.caption = caption;

    const result = await this.graph('POST', `/${this.phoneNumberId}/messages`, undefined, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: kind,
      [kind]: media,
    });
    // Audio can't carry a caption; send it as a follow-up text so nothing is lost.
    if (caption && kind === 'audio') {
      await this.sendTextMessage(to, caption);
    }
    this.status.lastSeen = new Date();
    return { id: result?.messages?.[0]?.id, to, caption, timestamp: Date.now() };
  }

  /**
   * Send a pre-approved template. `params` fill {{1}}, {{2}}, ... of the body
   * in order. Works outside the 24-hour window (paid per message).
   */
  async sendTemplateMessage(
    phoneNumber: string,
    templateName: string,
    language = 'en',
    params: Array<string | TemplateParam> = [],
    options?: { headerParams?: Array<string | TemplateParam>; buttonParams?: Array<{ index: number; subType: 'url' | 'quick_reply'; text: string }> },
  ): Promise<any> {
    const to = this.resolveRecipient(phoneNumber);
    const toParams = (list: Array<string | TemplateParam>) =>
      list.map((p) => (typeof p === 'string' ? { type: 'text', text: p } : { type: 'text', text: p.text }));

    const components: any[] = [];
    if (options?.headerParams?.length) {
      components.push({ type: 'header', parameters: toParams(options.headerParams) });
    }
    if (params.length) {
      components.push({ type: 'body', parameters: toParams(params) });
    }
    for (const b of options?.buttonParams || []) {
      components.push({
        type: 'button',
        sub_type: b.subType,
        index: String(b.index),
        parameters: [{ type: b.subType === 'url' ? 'text' : 'payload', [b.subType === 'url' ? 'text' : 'payload']: b.text }],
      });
    }

    const result = await this.graph('POST', `/${this.phoneNumberId}/messages`, undefined, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: templateName, language: { code: language }, ...(components.length ? { components } : {}) },
    });
    this.status.lastSeen = new Date();
    return { id: result?.messages?.[0]?.id, to, template: templateName, timestamp: Date.now() };
  }

  async markAsRead(messageId: string): Promise<void> {
    try {
      await this.graph('POST', `/${this.phoneNumberId}/messages`, undefined, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
    } catch (error) {
      log(`[CloudAPI] markAsRead failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async listTemplates(): Promise<any[]> {
    if (!this.wabaId) throw new Error('This session has no WhatsApp Business Account id configured');
    const result = await this.graph('GET', `/${this.wabaId}/message_templates`, {
      fields: 'name,status,category,language,components,rejected_reason',
      limit: '100',
    });
    return result?.data || [];
  }

  /** True when the user has messaged us within the last 24 h (free-form replies allowed). */
  isWithinServiceWindow(phoneNumber: string): boolean {
    const last = this.lastInboundAt.get(this.resolveRecipient(phoneNumber));
    return !!last && Date.now() - last < SERVICE_WINDOW_MS;
  }

  noteInbound(phoneNumber: string, at = Date.now()) {
    this.lastInboundAt.set(CloudApiSession.digits(phoneNumber), at);
  }

  private warnIfOutsideWindow(to: string) {
    if (!this.isWithinServiceWindow(to)) {
      log(`[CloudAPI] Sending free-form message to ${to} with no inbound in the last 24 h — Meta will drop it unless the user wrote first. Use a template for cold sends.`);
    }
  }

  // ------------------------------------------------------------ inbound

  /**
   * Called by the webhook route with one `entry[].changes[].value` object
   * whose `field` is "messages". Emits the same events as the Baileys session.
   */
  async handleWebhookValue(value: any): Promise<void> {
    const contacts: any[] = Array.isArray(value?.contacts) ? value.contacts : [];
    const profileName = (waId: string) => contacts.find((c) => c?.wa_id === waId)?.profile?.name;

    for (const status of value?.statuses || []) {
      if (status?.status === 'failed') {
        const err = status.errors?.[0];
        log(`[CloudAPI] Message ${status.id} to ${status.recipient_id} FAILED: ${err?.code || ''} ${err?.title || ''} ${err?.message || ''} ${err?.error_data?.details || ''}`);
      }
      this.emit('message-status', {
        messageId: status?.id,
        recipient: status?.recipient_id,
        status: status?.status,
        timestamp: Number(status?.timestamp || 0) * 1000,
        errors: status?.errors,
        conversation: status?.conversation,
        pricing: status?.pricing,
      });
    }

    for (const msg of value?.messages || []) {
      try {
        await this.handleInboundMessage(msg, profileName(msg?.from));
      } catch (error) {
        log(`[CloudAPI] Failed to handle inbound ${msg?.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private async handleInboundMessage(msg: any, profileName?: string): Promise<void> {
    const messageId: string | undefined = msg?.id;
    if (messageId) {
      if (this.seenMessageIds.has(messageId)) return; // Meta retries deliveries
      this.seenMessageIds.add(messageId);
      if (this.seenMessageIds.size > SEEN_MESSAGE_IDS_MAX) {
        const first = this.seenMessageIds.values().next().value;
        if (first) this.seenMessageIds.delete(first);
      }
    }

    const phoneNumber = CloudApiSession.digits(msg?.from || '');
    if (!phoneNumber) return;
    const timestamp = msg?.timestamp ? Number(msg.timestamp) * 1000 : Date.now();
    this.noteInbound(phoneNumber, timestamp);
    this.status.lastSeen = new Date();

    // Keep `from` in JID form so existing code that strips "@s.whatsapp.net"
    // keeps working; `replyTo` is what sendTextMessage() receives back.
    const from = `${phoneNumber}@s.whatsapp.net`;
    const base = {
      phoneNumber,
      from,
      replyTo: from,
      senderPn: phoneNumber,
      pushName: profileName,
      sourceMessageId: messageId,
      timestamp: Date.now(),
      receivedAt: timestamp,
    };

    const type: string = msg?.type || 'unknown';

    if (type === 'text') {
      const text: string = msg.text?.body || '';
      if (!text) return;
      log(`[CloudAPI] Incoming text for ${this.userId}/${this.sessionName} from ${phoneNumber}: ${text}`);
      this.emit('incoming-message', { ...base, content: text, messageType: 'text' });
      if (text.trim().toUpperCase() === 'STOP') {
        this.emit('button-clicked', { ...base, buttonId: 'STOP_MESSAGES' });
      }
      return;
    }

    if (type === 'interactive' || type === 'button') {
      const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
      const buttonId = reply?.id || msg.button?.payload || msg.button?.text;
      const title = reply?.title || msg.button?.text || '';
      if (!buttonId) return;
      log(`[CloudAPI] Button/list reply from ${phoneNumber}: ${buttonId}`);
      this.emit('button-clicked', { ...base, buttonId, title });
      return;
    }

    if (type === 'image' || type === 'document' || type === 'video' || type === 'audio' || type === 'sticker') {
      const media = msg[type] || {};
      const isVoice = type === 'audio' && media.voice === true;
      const messageType = type === 'sticker' ? 'image' : isVoice ? 'voice_note' : type;
      let mediaBuffer: Buffer | null = null;
      let mediaBase64: string | null = null;
      try {
        mediaBuffer = await this.downloadMedia(media.id);
        mediaBase64 = mediaBuffer.toString('base64');
      } catch (error) {
        log(`[CloudAPI] Failed to download ${type} ${media.id}: ${error instanceof Error ? error.message : error}`);
      }
      const placeholder = type === 'document' ? `[Document: ${media.filename || 'file'}]`
        : type === 'video' ? '[Video]'
        : type === 'audio' ? (isVoice ? '[Voice Note]' : '[Audio Message]')
        : '[Image]';
      const content = media.caption || placeholder;
      log(`[CloudAPI] Incoming ${messageType} for ${this.userId}/${this.sessionName} from ${phoneNumber}: ${content}`);
      const payload: any = {
        ...base,
        content,
        messageType,
        mediaInfo: {
          mimetype: media.mime_type,
          caption: media.caption,
          fileName: media.filename,
          title: media.filename,
          fileLength: mediaBuffer?.length,
          sha256: media.sha256,
          mediaId: media.id,
        },
        mediaData: mediaBase64,
        mediaBuffer,
      };
      if (type === 'audio') {
        payload.audioData = mediaBase64;
        payload.audioBuffer = mediaBuffer;
      }
      this.emit('incoming-message', payload);
      return;
    }

    if (type === 'location') {
      const loc = msg.location || {};
      const content = `[Location] ${loc.name || ''} ${loc.address || ''} (${loc.latitude}, ${loc.longitude})`.replace(/\s+/g, ' ').trim();
      this.emit('incoming-message', { ...base, content, messageType: 'text', location: loc });
      return;
    }

    if (type === 'contacts') {
      const names = (msg.contacts || []).map((c: any) => c?.name?.formatted_name).filter(Boolean).join(', ');
      this.emit('incoming-message', { ...base, content: `[Contact] ${names}`, messageType: 'text', contacts: msg.contacts });
      return;
    }

    if (type === 'reaction' || type === 'unsupported' || type === 'system') {
      return;
    }

    log(`[CloudAPI] Ignoring inbound of type ${type} from ${phoneNumber}`);
  }

  // ------------------------------------------------------------ media

  private async uploadMedia(filePath: string, mimetype: string, fileName?: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimetype);
    const bytes = fs.readFileSync(filePath);
    form.append('file', new Blob([bytes], { type: mimetype }), fileName || path.basename(filePath));
    const response = await fetch(`${GRAPH_BASE}/${this.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
    });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok || !json?.id) {
      throw CloudApiSession.toError(json, response.status);
    }
    return json.id as string;
  }

  private async downloadMedia(mediaId: string): Promise<Buffer> {
    if (!mediaId) throw new Error('No media id');
    const meta = await this.graph('GET', `/${mediaId}`, { fields: 'url,mime_type,file_size' });
    if (meta?.file_size && Number(meta.file_size) > MAX_INBOUND_MEDIA_BYTES) {
      throw new Error(`Media too large (${meta.file_size} bytes)`);
    }
    const response = await fetch(meta.url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!response.ok) throw new Error(`Media download HTTP ${response.status}`);
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_INBOUND_MEDIA_BYTES) throw new Error(`Media too large (${buf.length} bytes)`);
    return buf;
  }

  // ------------------------------------------------------------ helpers

  private async graph(method: 'GET' | 'POST' | 'DELETE', pathname: string, query?: Record<string, string>, body?: any): Promise<any> {
    const url = new URL(`${GRAPH_BASE}${pathname}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok || json?.error) {
      throw CloudApiSession.toError(json, response.status);
    }
    return json;
  }

  private static toError(json: any, httpStatus: number): GraphApiError {
    const e = json?.error || {};
    const detail = e.error_data?.details ? ` — ${e.error_data.details}` : '';
    const msg = `${e.message || `HTTP ${httpStatus}`}${detail}` + (e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : '');
    return new GraphApiError(msg, e.code, e.error_subcode, httpStatus);
  }

  /** Accepts digits, "+91…", or a JID; returns E.164 digits without "+". */
  private resolveRecipient(input: string): string {
    const raw = String(input || '').trim();
    if (raw.endsWith('@lid')) {
      throw new Error(`Cloud API cannot address LID recipients (${raw})`);
    }
    let d = CloudApiSession.digits(raw.split('@')[0]);
    if (d.length === 10) d = `91${d}`; // same default as the Baileys session
    if (d.length < 8) throw new Error(`Invalid recipient phone number: ${input}`);
    return d;
  }

  static digits(value: string): string {
    return String(value || '').replace(/\D/g, '');
  }
}
