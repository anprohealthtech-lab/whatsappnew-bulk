import type { CloudDatabase, Tenant } from '../cloud/model';

export const MAX_AUTOMATIC_REPLIES_PER_CATEGORY = 2;
export const CONVERSATION_IDLE_MINUTES = 30;
export type ReplyScope = Tenant & { sessionName: string; phoneNumber: string };
export type ReplyCategory = 'identity' | 'menu' | 'fallback' | 'unsupported_media';

// Keep PN JIDs, device-qualified JIDs and formatted international numbers in
// the same bucket. LID aliases are supplied explicitly by the inbound handler.
export function recipientKey(value: string): string {
  const [local, domain] = value.split('@');
  const digits = local.split(':')[0].replace(/\D/g, '');
  return domain && domain !== 's.whatsapp.net' && domain !== 'c.us'
    ? `${digits}@${domain}` : digits;
}

function plainText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

// Deliberately recognize self-identification, not the word "assistant" on its
// own: "I am a nurse", "are you an assistant?" and booking requests are human
// messages. Quoted text and a forwarded transcript are not self-identification.
export function isAssistantIntroduction(value: string): boolean {
  return /^(?:hello[!,. ]+|hi[!,. ]+)?(?:i am|i'm) (?:the |your |an? )?(?:(?:hospital|clinic|appointment|recruitment|hr|virtual|ai|automated|personal|whatsapp|customer service|support) )*(?:assistant|chatbot|bot)\b/.test(plainText(value));
}

export function replyCategories(value: string): ReplyCategory[] {
  const text = plainText(value);
  // Concrete results must remain deliverable even if an AI appends its usual
  // menu/signature. Never cap bookings, cancellations, task results or slot lists.
  if (/\b(?:appointment|booking|reminder|task)\b.{0,50}\b(?:confirmed|booked|cancelled|canceled|rescheduled|created|updated|deleted|completed)\b/.test(text)
    || /\b(?:confirmed|booked|cancelled|canceled|rescheduled|created|updated|deleted|completed)\b.{0,50}\b(?:appointment|booking|reminder|task)\b/.test(text)
    || /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b/.test(text)) return [];

  const categories: ReplyCategory[] = [];
  if (/\b(?:my )?identity\b.{0,60}\b(?:cannot|can't|won't|will not|never)\b.{0,30}\bchang/.test(text)
    || /\b(?:cannot|can't|won't|will not)\b.{0,50}\b(?:change my identity|act as an? assistant for|be an? assistant for)/.test(text)
    || /\b(?:i am|i'm)\b.{0,100}\b(?:assistant|associated|affiliated)\b.{0,60}\bonly\b/.test(text)
    || (isAssistantIntroduction(value) && /\b(?:not associated|not affiliated|here to help|how can i (?:help|assist)|i can help you|i'm here)\b/.test(text))) {
    categories.push('identity');
  }

  const menuOptions = [
    /\bbook (?:an? )?appointments?\b/, /\b(?:check|view|show) (?:the )?available slots\b/,
    /\bcancel (?:an? |your )?appointments?\b/, /\b(?:view|show) (?:your |my |upcoming )?appointments?\b/,
    /\b(?:find|list) doctors\b/,
  ].filter(pattern => pattern.test(text)).length;
  if ((menuOptions >= 2 || /\b(?:here's|here is) (?:what i can do|how i can help)\b/.test(text))
    && /\b(?:how can i|what can i|choose|select|help you|assist you)\b/.test(text)) categories.push('menu');

  if (/\b(?:couldn't|could not|cannot|can't|unable to) (?:complete|process|answer|help with|assist with)\b/.test(text)
    || /\b(?:something went wrong|try again later|having trouble|facing an error|not fully configured|not configured)\b/.test(text)) categories.push('fallback');
  if (/\b(?:can only process text|please (?:type|send a text)|could you please type|mind typing)\b/.test(text)
    && /\b(?:voice|audio|image|video|document|media|attachment)\b/.test(text)) categories.push('unsupported_media');
  return categories;
}

export class AutomaticReplySuppressedError extends Error {
  constructor(public readonly categories: string[]) {
    super(`Automatic reply suppressed: ${categories.join(', ')}`);
    this.name = 'AutomaticReplySuppressedError';
  }
}

export class AutomaticReplyGuard {
  constructor(private database: CloudDatabase) {}

  // A locked row serializes reservations across requests AND server processes.
  // Reserve before the external send; an uncertain send consumes its budget so
  // a transport failure cannot accidentally create unlimited retries.
  async claim(scope: ReplyScope, categories: string[]): Promise<boolean> {
    return this.database.transaction(async query => {
      const params = [scope.organizationId, scope.userId, scope.sessionName, recipientKey(scope.phoneNumber)];
      await query(`INSERT INTO automatic_reply_conversations
        (organization_id,user_id,session_name,recipient) VALUES ($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`, params);
      const [row] = await query(`SELECT counts,
        last_activity_at <= now() - interval '${CONVERSATION_IDLE_MINUTES} minutes' AS expired
        FROM automatic_reply_conversations
        WHERE organization_id=$1 AND user_id=$2 AND session_name=$3 AND recipient=$4 FOR UPDATE`, params);
      const counts: Record<string, number> = row.expired ? {} : { ...row.counts };
      const unique = Array.from(new Set(categories));
      const allowed = unique.every(category => (counts[category] || 0) < MAX_AUTOMATIC_REPLIES_PER_CATEGORY);
      if (allowed) for (const category of unique) counts[category] = (counts[category] || 0) + 1;
      // Suppressed traffic also refreshes activity: a continuing loop must not
      // reset its own budget merely by waiting out a fixed time window.
      await query(`UPDATE automatic_reply_conversations SET counts=$5::jsonb,last_activity_at=now()
        WHERE organization_id=$1 AND user_id=$2 AND session_name=$3 AND recipient=$4`, [...params, JSON.stringify(counts)]);
      return allowed;
    });
  }

  async allowIncoming(scope: ReplyScope, text: string): Promise<boolean> {
    // Other messages touch the conversation without spending any reply budget.
    return this.claim(scope, isAssistantIntroduction(text) ? ['inbound:assistant'] : []);
  }
}

export interface ReplyTransport { sendTextMessage(to: string, text: string): Promise<any> }

// Wrap only the transport for this one inbound request. Never mutate the shared
// session; simultaneous chats and manual/API sends must retain their own scope.
export function guardedReplySession<T extends ReplyTransport>(
  session: T, guard: AutomaticReplyGuard, scope: ReplyScope, aliases: string[] = [],
): T {
  const recipients = new Set([scope.phoneNumber, ...aliases].map(recipientKey));
  return new Proxy(session, {
    get(target, property) {
      if (property === 'sendTextMessage') return async (to: string, text: string) => {
        if (recipients.has(recipientKey(to))) {
          const categories = replyCategories(text);
          if (categories.length && !await guard.claim(scope, categories)) {
            console.log(`[AutomaticReplyGuard] Suppressed ${categories.join(',')} for ${scope.userId}/${scope.sessionName}/${recipientKey(scope.phoneNumber)}`);
            throw new AutomaticReplySuppressedError(categories);
          }
        }
        return target.sendTextMessage(to, text);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
