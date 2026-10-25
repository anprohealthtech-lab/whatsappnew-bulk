/**
 * Answers a WhatsApp keyword request for a downloadable patient guide.
 *
 * The MediTrust BP awareness reels ask viewers to send "PDF" to get a home
 * blood-pressure checklist. A wa.me link with prefilled text puts the keyword
 * in the person's compose box, so the match is reliable and no one types an
 * unknown number by hand.
 *
 * Why this is not `AutoResponseService`: that service is global (it reads every
 * tenant's `auto_responses` rows) and its instance is never handed a WhatsApp
 * session, so it has silently matched nothing for a long time. Repairing it
 * would wake up every dormant row in that table for every tenant at once. This
 * service stays scoped to one organization, one guide and one keyword list.
 *
 * Env:
 *   GUIDE_REPLY_MODE=off|log|send   off (default) = inert; log = record the
 *                                   request and let the existing bot answer as
 *                                   it does today (manual fulfilment); send =
 *                                   reply with the guide and stop there
 *   GUIDE_REPLY_ORG=<organization_id>   the only tenant it acts for
 *   GUIDE_REPLY_USER=<user_id>          or scope by the session owner instead,
 *                                       which is the id the runtime logs print
 *                                       as "Incoming text for <user>/<session>".
 *                                       At least one of the two is required
 *   GUIDE_REPLY_KEYWORDS=PDF,पीडीएफ     optional, comma separated
 *   GUIDE_REPLY_NAME=bp_home_checklist  optional label stored on the row
 *   GUIDE_REPLY_URL=https://...         the approved, publicly downloadable file
 *   GUIDE_REPLY_AS_DOCUMENT=true        send the file as a WhatsApp attachment
 *                                       (default when the URL ends .pdf and the
 *                                       session is Cloud API); false = link only
 *   GUIDE_REPLY_FILENAME=...pdf         the name the recipient sees
 *   GUIDE_REPLY_TEXT=...                optional full override of the reply
 *   GUIDE_REPLY_COOLDOWN_HOURS=24       one automatic reply per number per guide
 *
 * `send` refuses to run without GUIDE_REPLY_URL (or GUIDE_REPLY_TEXT), so the
 * offer cannot go live before the guide is approved and hosted.
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db';
import { guideRequests } from '@shared/schema';
import { log } from '../utils';
import type { WAServiceInstance } from './WhatsAppSessionManager';

export type GuideReplyMode = 'off' | 'log' | 'send';

export interface GuideTenant {
  organizationId: string;
  userId: string;
}

function mode(): GuideReplyMode {
  const raw = (process.env.GUIDE_REPLY_MODE || 'off').trim().toLowerCase();
  return raw === 'log' || raw === 'send' ? raw : 'off';
}

function keywords(): string[] {
  const raw = process.env.GUIDE_REPLY_KEYWORDS || 'PDF';
  return raw.split(',').map((k) => k.trim()).filter(Boolean);
}

function guideName(): string {
  return process.env.GUIDE_REPLY_NAME || 'bp_home_checklist';
}

function cooldownMs(): number {
  const hours = parseFloat(process.env.GUIDE_REPLY_COOLDOWN_HOURS || '24');
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

function scopeOrg(): string {
  return (process.env.GUIDE_REPLY_ORG || '').trim();
}

function scopeUser(): string {
  return (process.env.GUIDE_REPLY_USER || '').trim();
}

/** The whole feature is off unless a mode and a scope are both configured. */
export function guideRepliesConfigured(): boolean {
  return mode() !== 'off' && (!!scopeOrg() || !!scopeUser());
}

// A patient writing "send my report pdf" wants their own lab report, not a
// health guide. Those messages must reach the normal bot and the staff inbox,
// so any of these words disqualifies the match however short the message is.
const NOT_A_GUIDE_REQUEST = [
  'REPORT', 'REPORTS', 'RESULT', 'RESULTS', 'BILL', 'BILLS', 'INVOICE',
  'RECEIPT', 'PRESCRIPTION', 'RX', 'XRAY', 'X-RAY',
];

/**
 * A whole-word keyword in a short message: "PDF", "pdf please" and "send PDF"
 * match; "pdfs", a long sentence, and anything naming a patient's own
 * paperwork do not.
 */
function matchedKeyword(text: string): string | null {
  const body = (text || '').trim();
  if (!body || body.length > 60) return null;
  // Strip surrounding punctuation so "PDF!" and "(pdf)" still count. Latin plus
  // Devanagari, which covers the keywords offered. No /u flag — this project's
  // tsconfig targets ES5.
  const edges = /^[^0-9A-Zऀ-ॿ]+|[^0-9A-Zऀ-ॿ]+$/g;
  const tokens = body.toUpperCase().split(/\s+/).map((t) => t.replace(edges, '')).filter(Boolean);
  if (tokens.length > 4) return null;
  if (tokens.some((t) => NOT_A_GUIDE_REQUEST.indexOf(t) !== -1)) return null;
  for (const keyword of keywords()) {
    if (tokens.includes(keyword.toUpperCase())) return keyword.toUpperCase();
  }
  return null;
}

const SAFETY = [
  'This is general health education, not a diagnosis. Keep taking any medicine your doctor has prescribed, exactly as prescribed.',
  'To see a doctor: call or WhatsApp 063582 40913.',
];

function guideUrl(): string {
  return (process.env.GUIDE_REPLY_URL || '').trim();
}

/** The message when the guide travels as a link. */
function replyText(): string | null {
  const override = (process.env.GUIDE_REPLY_TEXT || '').trim();
  if (override) return override;
  const url = guideUrl();
  if (!url) return null;
  return [
    'Here is your home blood-pressure checklist and 7-day record from MediTrust Clinics:',
    url,
    '',
    ...SAFETY,
  ].join('\n');
}

/**
 * The caption when the guide travels as an attachment. No URL in it: the file is
 * right there. WhatsApp caps a document caption at 1024 characters.
 */
function documentCaption(): string {
  const override = (process.env.GUIDE_REPLY_TEXT || '').trim();
  const body = override || [
    'Here is your home blood-pressure checklist and 7-day record from MediTrust Clinics.',
    '',
    ...SAFETY,
  ].join('\n');
  return body.slice(0, 1024);
}

function documentFileName(): string {
  const configured = (process.env.GUIDE_REPLY_FILENAME || '').trim();
  if (configured) return configured;
  const tail = guideUrl().split('?')[0].split('/').pop() || '';
  return tail.toLowerCase().endsWith('.pdf') ? tail : 'MediTrust_Home_BP_Checklist.pdf';
}

/** A real attachment beats a link, so it is the default whenever the URL is a PDF. */
function sendAsDocument(): boolean {
  if ((process.env.GUIDE_REPLY_AS_DOCUMENT || '').trim().toLowerCase() === 'false') return false;
  return guideUrl().split('?')[0].toLowerCase().endsWith('.pdf');
}

/** Baileys sessions have no link-send; only the Cloud API session does. */
type DocumentSender = {
  sendDocumentByLink?(phone: string, link: string, fileName: string, caption?: string): Promise<any>;
};

export class GuideRequestService {
  constructor(private readonly tenant: GuideTenant, private readonly session: WAServiceInstance) {}

  /**
   * Returns true when this message was a guide request and has been dealt with,
   * so the caller should not pass it on to the chatbot or auto-responses.
   */
  async handle(phoneNumber: string, text: string, replyTo?: string): Promise<boolean> {
    if (!guideRepliesConfigured()) return false;
    // Whichever scope is configured must match. Both set means both must match.
    if (scopeOrg() && this.tenant.organizationId !== scopeOrg()) return false;
    if (scopeUser() && this.tenant.userId !== scopeUser()) return false;

    const keyword = matchedKeyword(text);
    if (!keyword) return false;

    const guide = guideName();
    const sending = mode() === 'send';
    const body = sending ? replyText() : null;

    if (sending && !body) {
      log('[GuideRequest] GUIDE_REPLY_MODE=send but no GUIDE_REPLY_URL/TEXT is set; recording the request only');
    }

    // Already answered recently: record nothing new and stay quiet, so a second
    // "PDF" cannot be used to make the number send repeatedly.
    const since = new Date(Date.now() - cooldownMs());
    const [recent] = await db.select({ id: guideRequests.id, status: guideRequests.status })
      .from(guideRequests)
      .where(and(
        eq(guideRequests.organizationId, this.tenant.organizationId),
        eq(guideRequests.phoneNumber, phoneNumber),
        eq(guideRequests.guide, guide),
        eq(guideRequests.status, 'sent'),
        gte(guideRequests.requestedAt, since),
      ))
      .orderBy(desc(guideRequests.requestedAt))
      .limit(1);

    if (recent) {
      log(`[GuideRequest] ${phoneNumber} already received ${guide} within the cooldown; not resending`);
      return true;
    }

    const [row] = await db.insert(guideRequests).values({
      organizationId: this.tenant.organizationId,
      userId: this.tenant.userId,
      phoneNumber,
      guide,
      keyword,
      channel: 'whatsapp',
      status: 'received',
    }).returning();

    if (!sending || !body) {
      await db.update(guideRequests).set({ status: 'logged' }).where(eq(guideRequests.id, row.id));
      log(`[GuideRequest] ${guide} requested by ${phoneNumber} (keyword ${keyword}) — recorded for manual fulfilment`);
      // False on purpose: the request is recorded, but this service is not
      // answering it, so the message must still reach the bot that answers this
      // number today. Swallowing it here would leave the sender with silence.
      return false;
    }

    const target = replyTo || phoneNumber;
    const sender = this.session as unknown as DocumentSender;
    try {
      let how = 'link';
      if (sendAsDocument() && typeof sender.sendDocumentByLink === 'function') {
        // The attachment is the first choice. If Meta will not fetch the URL,
        // the link still answers the person — silence would be the worst
        // outcome, because this handler has already taken the message away
        // from the bot that would otherwise have replied.
        try {
          await sender.sendDocumentByLink(target, guideUrl(), documentFileName(), documentCaption());
          how = `attachment ${documentFileName()}`;
        } catch (docError) {
          const why = docError instanceof Error ? docError.message : String(docError);
          log(`[GuideRequest] Attachment send failed (${why}); falling back to the link`);
          await this.session.sendTextMessage(target, body);
        }
      } else {
        await this.session.sendTextMessage(target, body);
      }
      await db.update(guideRequests).set({ status: 'sent', sentAt: new Date() }).where(eq(guideRequests.id, row.id));
      log(`[GuideRequest] Sent ${guide} to ${phoneNumber} as ${how}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await db.update(guideRequests).set({ status: 'failed', errorReason: reason.slice(0, 500) })
        .where(eq(guideRequests.id, row.id));
      log(`[GuideRequest] Could not send ${guide} to ${phoneNumber}: ${reason}`);
    }
    return true;
  }
}
