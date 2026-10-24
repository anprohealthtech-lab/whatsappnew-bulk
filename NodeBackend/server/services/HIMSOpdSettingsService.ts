export interface HIMSBotSettings {
  greetingMessage: string;
  systemPrompt: string;
  contactNumber: string;
  allowedLanguages: string[];
}

export interface HIMSBotConfiguration {
  context: {
    clinic: { id: string; name: string; phone: string; address: string; timezone: string; workingHours: unknown };
    doctors: { id: string; name: string; specialization: string | null; qualification: string | null; availability: unknown; consultationFee: number | null }[];
    specialties: string[];
  };
  settings: HIMSBotSettings | null;
  draft: HIMSBotSettings;
  fetchedAt: string;
  updatedAt: string | null;
}

const cache = new Map<string, { expires: number; value: HIMSBotConfiguration }>();

export async function requestHIMSBotConfiguration(
  clinicId: string,
  action: 'get' | 'tune' | 'save' = 'get',
  settings?: HIMSBotSettings,
  fresh = false,
): Promise<HIMSBotConfiguration> {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(clinicId)) throw new Error('Configure a valid HIMS Clinic UUID first');
  const cached = cache.get(clinicId);
  if (action === 'get' && !fresh && cached && cached.expires > Date.now()) return cached.value;
  const baseUrl = (process.env.HIMS_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const secret = process.env.HIMS_BOT_SECRET;
  if (!baseUrl || !secret) throw new Error('HIMS connection is not configured');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('HIMS_SUPABASE_URL must contain only the HTTPS project URL');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-hims-bot-secret': secret };
  const key = process.env.HIMS_SUPABASE_ANON_KEY || process.env.HIMS_SUPABASE_SERVICE_ROLE_KEY;
  if (key) { headers.apikey = key; if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; }
  const response = await fetch(`${baseUrl}/functions/v1/hims-opd-bot`, {
    method: 'POST', headers, body: JSON.stringify({ action, clinicId, settings }), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `HIMS bot settings request failed (${response.status})`);
  if (data?.context?.clinic?.id !== clinicId || !data?.draft || !Array.isArray(data.context.doctors)) throw new Error('HIMS returned invalid clinic details');
  // Bound cache size; callers cannot select another tenant's clinic via request body.
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  cache.set(clinicId, { expires: Date.now() + 60000, value: data });
  return data;
}

export function resolveHIMSBotSettings(features: Record<string, any>, config: HIMSBotConfiguration): HIMSBotSettings {
  if (config.settings) return {
    ...config.settings,
    greetingMessage: config.settings.greetingMessage || config.draft.greetingMessage,
    systemPrompt: config.settings.systemPrompt || config.draft.systemPrompt,
  };
  return {
    greetingMessage: features.himsGreetingMessage || config.draft.greetingMessage,
    systemPrompt: features.himsSystemPrompt || config.draft.systemPrompt,
    contactNumber: features.himsContactNumber || config.draft.contactNumber,
    allowedLanguages: features.himsAllowedLanguages || config.draft.allowedLanguages,
  };
}
