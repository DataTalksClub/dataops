import { createHash } from 'node:crypto';
import type { Card } from '../types';

export type BannerInput = {
  eventType: 'workshop' | 'webinar' | 'podcast';
  layout: 'landscape' | 'square';
  speakers: { personId: string; portraitFileId: string }[];
  revision: string;
  sponsorLogoFileId?: string;
  sponsorTreatment?: 'approved-logo';
};
export type BannerSpeaker = BannerInput['speakers'][number] & { name: string; personVersion: number; checksum: string };
export type BannerLogo = { fileId: string; checksum: string; treatment: 'approved-logo' };
export type BannerJob = {
  bundleKey: string; id: string; cardId: string; title: string; input: BannerInput; speakers: BannerSpeaker[];
  state: 'queued' | 'rendering' | 'succeeded' | 'failed';
  createdBy: string; createdAt: string; updatedAt: string;
  artifactId?: string; error?: string; leaseUntil?: number; attempt?: number;
  sponsorLogo?: BannerLogo;
};
export type BannerTemplate = {
  id: string; eventType: BannerInput['eventType']; layout: BannerInput['layout'];
  speakerCount: number; width: number; height: number; html: string;
  sponsorTreatment?: 'approved-logo';
};
export type BannerBundle = { schema: 'dataops.banner-templates.v1'; sourceRevision: string; assets?: Record<string, string>; templates: BannerTemplate[] };
export class BannerInputError extends Error {}
export function parseBannerInput(value: unknown): BannerInput {
  const data = value as Partial<BannerInput> | null;
  if (!data || !['workshop', 'webinar', 'podcast'].includes(data.eventType || '')
    || !['landscape', 'square'].includes(data.layout || '')
    || !Array.isArray(data.speakers) || data.speakers.length < 1 || data.speakers.length > 3
    || data.speakers.some(s => !s || !/^[a-zA-Z0-9-]{1,100}$/.test(s.personId) || !/^[a-zA-Z0-9-]{1,100}$/.test(s.portraitFileId))
    || new Set(data.speakers.map(s => s.personId)).size !== data.speakers.length
    || typeof data.revision !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(data.revision)) {
    throw new BannerInputError('Choose workshop|webinar|podcast, landscape|square, one to three distinct Card people with portrait file IDs, and a stable revision.');
  }
  if ((data.sponsorLogoFileId !== undefined || data.sponsorTreatment !== undefined)
    && (typeof data.sponsorLogoFileId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(data.sponsorLogoFileId) || data.sponsorTreatment !== 'approved-logo')) {
    throw new BannerInputError('A sponsored cover requires a verified Card logo file ID and explicit approved-logo treatment.');
  }
  return { eventType: data.eventType!, layout: data.layout!, speakers: data.speakers.map(s => ({ personId: s.personId, portraitFileId: s.portraitFileId })), revision: data.revision,
    ...(data.sponsorLogoFileId ? { sponsorLogoFileId: data.sponsorLogoFileId, sponsorTreatment: 'approved-logo' as const } : {}),
  };
}
export function bannerId(card: Card, input: BannerInput, speakers: BannerSpeaker[], bundleKey: string, sponsorLogo?: BannerLogo): string {
  return createHash('sha256').update(JSON.stringify({ cardId: card.id, title: card.title, input, speakers, bundleKey, sponsorLogo })).digest('hex');
}
export function checksum(bytes: Buffer): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
export function portraitContentType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new BannerInputError('Portrait bytes must be PNG, JPEG or WebP.');
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function composeBanner(template: BannerTemplate, job: BannerJob, portraits: string[], assets: Record<string, string> = {}, sponsorLogo?: string): string {
  const titleArea = job.input.layout === 'landscape' ? 1260 * 810 : 1800 * 600;
  const values: Record<string, string> = {
    ...Object.fromEntries(Object.entries(assets).filter(([key]) => /^asset[A-Za-z]+$/.test(key))),
    title: escapeHtml(job.title),
    titleFontSize: String(Math.min(150, Math.floor(Math.sqrt(titleArea / (Math.max(job.title.length, 20) * 0.72))))),
  };
  if (sponsorLogo) values.sponsorLogo = sponsorLogo;
  job.speakers.forEach((s, i) => { values[`speaker${i + 1}Name`] = escapeHtml(s.name); values[`speaker${i + 1}Portrait`] = portraits[i]; });
  const html = template.html.replace(/\{\{([a-zA-Z0-9]+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error('Unknown banner template field');
    return values[key];
  });
  if (/\{\{|(?:src|href)\s*=\s*[\"'](?:https?:|file:)|url\(\s*[\"']?(?:https?:|file:)/i.test(html)) throw new Error('Banner template must be self-contained');
  return html;
}
export function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Renderer did not return a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
