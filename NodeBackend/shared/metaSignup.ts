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
