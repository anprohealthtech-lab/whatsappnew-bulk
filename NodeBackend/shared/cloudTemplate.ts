import { z } from 'zod';

export const templateCategory = z.enum(['UTILITY', 'MARKETING']);
export const templateLanguage = z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/, 'Choose a WhatsApp language code');
export const templateButton = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: z.string().trim().min(1).max(25) }).strict(),
  z.object({ type: z.literal('URL'), text: z.string().trim().min(1).max(25),
    url: z.string().url().startsWith('https://').max(2000).refine(v => !/[{}]/.test(v), 'Use a static button URL') }).strict(),
  z.object({ type: z.literal('PHONE_NUMBER'), text: z.string().trim().min(1).max(25),
    phone_number: z.string().regex(/^\+?[1-9]\d{7,14}$/, 'Include the country code') }).strict(),
]);

export function templateVariableCount(text: string): number {
  const matches = Array.from(text.matchAll(/\{\{([1-9]\d*)\}\}/g));
  if (/[{}]/.test(text.replace(/\{\{[1-9]\d*\}\}/g, ''))) throw new Error('Use sequential variables such as {{1}}, {{2}}');
  const numbers = matches.map(m => Number(m[1]));
  const count = Math.max(0, ...numbers);
  if (count > 10 || new Set(numbers).size !== count) throw new Error('Use up to 10 sequential variables starting at {{1}}');
  return count;
}

export const templateContent = z.object({
  name: z.string().trim().min(1).max(512).regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores for the name'),
  category: templateCategory,
  language: templateLanguage,
  headerText: z.string().trim().max(60).refine(v => !/[{}]/.test(v), 'Use plain text in the header').default(''),
  bodyText: z.string().trim().min(1).max(1024),
  footerText: z.string().trim().max(60).refine(v => !/[{}]/.test(v), 'Use plain text in the footer').default(''),
  bodyExamples: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  buttons: z.array(templateButton).max(3).default([]),
}).strict().superRefine((value, ctx) => {
  try {
    const count = templateVariableCount(value.bodyText);
    if (value.bodyExamples.length !== count) ctx.addIssue({ code: 'custom', path: ['bodyExamples'], message: `Provide ${count} sample values, one for each body variable` });
    if (/^\{\{|\}\}$/.test(value.bodyText)) ctx.addIssue({ code: 'custom', path: ['bodyText'], message: 'Add message text before and after variables' });
  } catch (e) { ctx.addIssue({ code: 'custom', path: ['bodyText'], message: (e as Error).message }); }
  if (new Set(value.buttons.map(b => b.text.toLowerCase())).size !== value.buttons.length) {
    ctx.addIssue({ code: 'custom', path: ['buttons'], message: 'Button labels must be different' });
  }
  if (value.buttons.filter(b => b.type === 'URL').length > 2 || value.buttons.filter(b => b.type === 'PHONE_NUMBER').length > 1) {
    ctx.addIssue({ code: 'custom', path: ['buttons'], message: 'Use at most two URL buttons and one phone button' });
  }
});
export type TemplateContent = z.infer<typeof templateContent>;
export type TemplateButton = z.infer<typeof templateButton>;

export const templateSubmitInput = z.object({ sessionId: z.string().min(1).max(200), template: templateContent }).strict();
export const templateAssistantInput = z.object({
  sessionId: z.string().min(1).max(200), category: templateCategory, language: templateLanguage,
  brief: z.string().trim().min(10).max(3000),
}).strict();
export type TemplateAssistantInput = z.infer<typeof templateAssistantInput>;

/** Only these reviewed fields go to Meta. Account IDs and credentials come from the owned sender. */
export function metaTemplatePayload(raw: unknown) {
  const t = templateContent.parse(raw);
  return {
    name: t.name, category: t.category, language: t.language,
    components: [
      ...(t.headerText ? [{ type: 'HEADER', format: 'TEXT', text: t.headerText }] : []),
      { type: 'BODY', text: t.bodyText, ...(t.bodyExamples.length ? { example: { body_text: [t.bodyExamples] } } : {}) },
      ...(t.footerText ? [{ type: 'FOOTER', text: t.footerText }] : []),
      ...(t.buttons.length ? [{ type: 'BUTTONS', buttons: t.buttons }] : []),
    ],
  };
}
