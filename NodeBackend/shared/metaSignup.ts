/** Parse only Meta's signup messages. Never log authorization codes or tokens. */
export function parseMetaSignupMessage(origin: string, raw: unknown): any | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' ||
        !(url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))) return null;
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!payload || typeof payload !== 'object' || (payload as any).type !== 'WA_EMBEDDED_SIGNUP') return null;
    return payload;
  } catch {
    return null;
  }
}

/** Copyable field layout for troubleshooting; never include arbitrary message values. */
export function metaSignupDiagnostic(payload: any) {
  const knownEvents = ['FINISH', 'FINISH_ONLY_WABA', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', 'CANCEL', 'ERROR'];
  const fields: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const idFields = new Set(['waba_id', 'phone_number_id', 'business_id', 'messaging_account_ids']);
  const visit = (value: unknown, path: string, depth: number, idField = false) => {
    if (Object.keys(fields).length >= 50) return;
    fields[path] = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    // Meta IDs are decimal strings. Never copy codes, tokens, error text or phone numbers.
    if (idField && typeof value === 'string' && /^\d{1,40}$/.test(value)) ids[path] = value;
    if (depth >= 4 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.slice(0, 3).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1, idField));
    } else {
      Object.entries(value).slice(0, 30).forEach(([key, item]) => {
        visit(item, `${path}.${key}`, depth + 1, idFields.has(key));
      });
    }
  };
  visit(payload?.data, 'data', 0);
  return {
    event: knownEvents.includes(payload?.event) ? payload.event : 'OTHER',
    version: /^v?\d{1,3}$/.test(String(payload?.version)) ? String(payload.version) : 'unknown',
    messageFields: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 30) : [],
    fields,
    ids,
  };
}

/** Never silently select between multiple phones or from an incomplete list. */
export function selectSignupPhone(result: any, requestedId?: string): string {
  const phones = Array.isArray(result?.data) ? result.data : [];
  if (requestedId && phones.some((phone: any) => phone.id === requestedId)) return requestedId;
  if (requestedId) throw new Error('The selected phone does not belong to the selected WhatsApp account, or was not found on its first page. Complete signup with the correct account and number.');
  if (result?.paging?.next || phones.length !== 1 || !phones[0]?.id) {
    throw new Error('Meta did not return a phone ID and the selected WhatsApp account does not contain exactly one phone. Complete signup with a specific phone number; no number was linked.');
  }
  return String(phones[0].id);
}
