/**
 * The curated icon names a template may carry. The frontend draws each name
 * from the same list in `frontend/src/core/template-icons.js`; keep the two in
 * step (a frontend test asserts they match).
 */
export const TEMPLATE_ICONS = [
  'video',
  'mic',
  'wrench',
  'newspaper',
  'book',
  'graduation-cap',
  'share',
  'zap',
  'chat',
  'code',
  'receipt',
  'compass',
  'calendar',
  'megaphone',
  'users',
  'star',
] as const;

export type TemplateIcon = (typeof TEMPLATE_ICONS)[number];

export function isTemplateIcon(value: unknown): value is TemplateIcon {
  return typeof value === 'string' && (TEMPLATE_ICONS as readonly string[]).includes(value);
}
