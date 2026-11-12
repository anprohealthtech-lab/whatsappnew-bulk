import { templateAssistantInput, templateSubmitInput, metaTemplatePayload, type TemplateAssistantInput, type TemplateContent } from '@shared/cloudTemplate';
import type { Tenant } from './model';

export interface TemplateAccount {
  wabaId: string | null;
  phoneNumberId: string;
  listCampaignTemplates(): Promise<any[]>;
  createMessageTemplate(payload: ReturnType<typeof metaTemplatePayload>): Promise<any>;
}
type Draft = { template: TemplateContent; notes: string[]; model: string };

export class CloudTemplateWorkflow {
  private generating = new Set<string>();
  private submissions = new Set<string>();
  private limits = new Map<string, { count: number; expires: number }>();
  constructor(
    private resolve: (tenant: Tenant, sessionId: string) => Promise<TemplateAccount>,
    private generate: (input: TemplateAssistantInput) => Promise<Draft>,
  ) {}
  async list(tenant: Tenant, sessionId: string) {
    const account = await this.resolve(tenant, sessionId);
    return { wabaId: account.wabaId, templates: await account.listCampaignTemplates() };
  }
  async draft(tenant: Tenant, raw: unknown) {
    const input = templateAssistantInput.parse(raw);
    await this.resolve(tenant, input.sessionId); // Check ownership before spending AI tokens.
    const key = JSON.stringify([tenant.organizationId, tenant.userId]);
    const now = Date.now();
    for (const [k, limit] of Array.from(this.limits.entries())) if (limit.expires <= now) this.limits.delete(k);
    const limit = this.limits.get(key) || { count: 0, expires: now + 60000 };
    if (this.generating.has(key) || limit.count >= 5) throw new Error('Please wait before generating another template (up to five drafts per minute).');
    if (!this.limits.has(key) && this.limits.size >= 5000) throw new Error('Template AI is busy. Please try again shortly.');
    limit.count++; this.limits.set(key, limit); this.generating.add(key);
    try { return await this.generate(input); }
    finally { this.generating.delete(key); }
  }
  async submit(tenant: Tenant, raw: unknown) {
    const { sessionId, template } = templateSubmitInput.parse(raw);
    const account = await this.resolve(tenant, sessionId);
    const key = JSON.stringify([account.wabaId, template.name, template.language]);
    if (this.submissions.has(key)) throw new Error('This template is already being submitted. Refresh its status before retrying.');
    this.submissions.add(key);
    try {
      const result = await account.createMessageTemplate(metaTemplatePayload(template));
      if (!result?.id) throw new Error('Meta did not confirm a template ID. Refresh the template list before retrying submission.');
      return { id: result.id, status: result.status || 'SUBMITTED', category: result.category || template.category, wabaId: account.wabaId };
    } finally { this.submissions.delete(key); }
  }
  async billing(tenant: Tenant, sessionId: string) {
    const account = await this.resolve(tenant, sessionId);
    return { wabaId: account.wabaId, phoneNumberId: account.phoneNumberId,
      billingUrl: 'https://business.facebook.com/billing_hub/', balance: null,
      message: 'View your payment method, available Meta credit and invoices in Meta Billing. This app does not read a live Meta balance.' };
  }
}
