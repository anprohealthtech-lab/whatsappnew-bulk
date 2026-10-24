import { z } from 'zod';

export type Tenant = { organizationId: string; userId: string };
export type Row = Record<string, any>;
export type Query = (text: string, params?: any[]) => Promise<Row[]>;
export interface CloudDatabase { query: Query; transaction<T>(fn: (query: Query) => Promise<T>): Promise<T>; }

export function normalizePhone(input: string): string {
  if (!/^\+?[\d ()-]+$/.test(input)) throw new Error('Use a phone number with country code');
  const phone = input.replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error('Use a phone number with country code (8–15 digits)');
  return phone;
}
const textParam = z.string().trim().min(1).max(2000);
export const campaignInput = z.object({
  name: z.string().trim().min(1).max(200), sessionId: z.string().min(1),
  templateName: z.string().regex(/^[a-z0-9_]+$/), language: z.string().min(2).max(20),
  headerParams: z.array(z.union([
    z.object({ type: z.literal('text'), text: textParam }).strict(),
    z.object({ type: z.literal('image'), image: z.object({ link: z.string().url().startsWith('https://') }).strict() }).strict(),
    z.object({ type: z.literal('video'), video: z.object({ link: z.string().url().startsWith('https://') }).strict() }).strict(),
    z.object({ type: z.literal('document'), document: z.object({ link: z.string().url().startsWith('https://'), filename: z.string().max(200).optional() }).strict() }).strict(),
  ])).max(5).default([]),
  buttonParams: z.array(z.object({ index: z.number().int().min(0).max(9), subType: z.enum(['url', 'quick_reply']), text: textParam }).strict()).max(10).default([]),
  intervalSeconds: z.number().int().min(5).max(3600).default(25),
  dailyLimit: z.number().int().min(1).max(250).default(100),
  recipients: z.array(z.object({
    name: z.string().trim().min(1).max(200), phone: z.string().transform(normalizePhone),
    bodyParams: z.array(textParam).max(30).default([]), consentNote: z.string().trim().min(1).max(1000),
  }).strict()).min(1).max(1000),
}).strict();

function placeholders(text = ''): number {
  if (/\{\{[^\d}]/.test(text)) throw new Error('Named template parameters are not supported in campaigns yet');
  const found = Array.from(text.matchAll(/\{\{(\d+)\}\}/g)).map(m => Number(m[1]));
  const unique = new Set(found);
  const max = Math.max(0, ...found);
  if (unique.size !== max) throw new Error('Template parameters must be sequential');
  return max;
}
export function templateComponents(template: Row, body: string[], header: any[], buttons: any[]): any[] {
  if (template.status !== 'APPROVED') throw new Error('The selected template is not approved');
  if (template.parameter_format === 'NAMED') throw new Error('Named template parameters are not supported yet');
  const parts: Row[] = template.components || [];
  if (parts.some(p => !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(p.type))) throw new Error('Unsupported template component');
  const bodyPart = parts.find(p => p.type === 'BODY');
  if (body.length !== placeholders(bodyPart?.text)) throw new Error('Body parameter count does not match the approved template');
  const head = parts.find(p => p.type === 'HEADER');
  const headerCount = !head ? 0 : head.format === 'TEXT' ? placeholders(head.text) : 1;
  if (header.length !== headerCount) throw new Error('Header parameters do not match the approved template');
  if (head && header.length && header.some(p => p.type !== String(head.format).toLowerCase())) throw new Error('Header type does not match the template');
  const definitions: Row[] = parts.find(p => p.type === 'BUTTONS')?.buttons || [];
  if (definitions.some(b => !['URL', 'PHONE_NUMBER', 'QUICK_REPLY'].includes(b.type))) throw new Error('Unsupported template button type');
  const unique = new Set<number>();
  for (const b of buttons) {
    if (unique.has(b.index)) throw new Error('Duplicate button parameter');
    unique.add(b.index);
    if (definitions[b.index]?.type !== b.subType.toUpperCase()) throw new Error('Button parameters do not match the template');
    if (b.subType === 'url' && placeholders(definitions[b.index].url) !== 1) throw new Error('Only dynamic URL buttons accept parameters');
  }
  definitions.forEach((b, index) => {
    if (b.type === 'URL' && placeholders(b.url) > 0 && !unique.has(index)) throw new Error('Dynamic URL button needs a parameter');
  });
  return [
    ...(header.length ? [{ type: 'header', parameters: header }] : []),
    ...(body.length ? [{ type: 'body', parameters: body.map(text => ({ type: 'text', text })) }] : []),
    ...buttons.map(b => ({ type: 'button', sub_type: b.subType, index: String(b.index), parameters: [{ type: b.subType === 'url' ? 'text' : 'payload', [b.subType === 'url' ? 'text' : 'payload']: b.text }] })),
  ];
}
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
