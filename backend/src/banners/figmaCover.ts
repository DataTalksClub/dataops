/**
 * Figma event-banner covers (Banner Generator `dtc-event`, Figma node 3613:146).
 *
 * The templates are the exported Figma frames; this module only fills their slots:
 * balanced title wrapping into the frame's fixed line count, name splitting, and the
 * hugging name/label pills. It mirrors banner_generator/event_cover.py in the Banner
 * Generator repo (single source of the design); keep the two in sync.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BannerTemplate, FigmaCoverSpec } from './model';

export type FigmaManifestEntry = FigmaCoverSpec & {
  template: string; eventType: string; layout: 'square' | 'landscape'; width: number; height: number; sponsorLogo: boolean;
};
export class CoverFitError extends Error { constructor(message: string) { super(message); this.name = 'CoverFitError'; } }
export type Advances = Record<string, number>;

const MIN_SCALE = 0.55, SCALE_STEP = 0.96, WIDTH_SLACK = 1.04, HUG_LIMIT = 1.6;

export function textWidth(text: string, size: number, advances: Advances): number {
  let total = 0;
  for (const ch of text) total += advances[ch] ?? 0.6;
  return total * size;
}
function greedy(words: string[], size: number, limit: number, advances: Advances): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = `${line} ${word}`.trim();
    if (line && textWidth(candidate, size, advances) > limit) { out.push(line); line = word; } else line = candidate;
  }
  out.push(line);
  return out;
}
export function wrapTitle(title: string, lines: number, size: number, maxWidth: number, advances: Advances): { lines: string[]; size: number } {
  const words = title.split(/\s+/).filter(Boolean);
  if (!words.length) throw new CoverFitError('Title is empty');
  for (let scale = 1; scale >= MIN_SCALE - 1e-9; scale *= SCALE_STEP) {
    const current = size * scale;
    let out = greedy(words, current, maxWidth, advances);
    if (out.length <= lines && out.every(l => textWidth(l, current, advances) <= maxWidth)) {
      let low = Math.max(...words.map(w => textWidth(w, current, advances))), high = maxWidth;
      for (let i = 0; i < 30; i++) { const mid = (low + high) / 2; if (greedy(words, current, mid, advances).length <= out.length) high = mid; else low = mid; }
      out = greedy(words, current, high, advances);
      return { lines: [...out, ...Array(lines - out.length).fill('')], size: Math.round(current * 100) / 100 };
    }
  }
  throw new CoverFitError('Title does not fit the template lines');
}
function splitName(name: string, lines: number, size: number, advances: Advances): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  if (lines === 1 || words.length === 1) return [words.join(' '), ...Array(lines - 1).fill('')];
  let best = 1, bestWidth = Infinity;
  for (let i = 1; i < words.length; i++) {
    const width = Math.max(textWidth(words.slice(0, i).join(' '), size, advances), textWidth(words.slice(i).join(' '), size, advances));
    if (width < bestWidth) { best = i; bestWidth = width; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}
const num = (value: number) => String(Math.round(value * 100) / 100);

/** Slot values (unescaped, keyed like the template slots) for one cover. */
export function fitCover(entry: FigmaCoverSpec, advances: Advances, title: string, names: string[], label?: string): Record<string, string> {
  if (names.length !== entry.speakers.length) throw new CoverFitError('Speaker count does not match the template');
  const data: Record<string, string> = {};
  const spec = entry.title;
  const wrapped = wrapTitle(title, spec.keys.length, spec.fontSize, Math.round(spec.widestExampleLine * WIDTH_SLACK), advances);
  spec.keys.forEach((key, i) => { data[key] = wrapped.lines[i]; });
  data.title_font_size = String(Math.round(wrapped.size * 100) / 100);
  const labelText = label ?? entry.label.default;
  const pill = entry.label.pill;
  const wanted = textWidth(labelText, entry.label.fontSize, advances) + 2 * pill.textPad;
  data[entry.label.key] = labelText;
  data.label_pill_width = num(wanted > pill.pillWidth + 3 ? wanted : pill.pillWidth);
  entry.speakers.forEach((speaker, i) => {
    const parts = splitName(names[i], speaker.nameKeys.length, speaker.fontSize, advances);
    speaker.nameKeys.forEach((key, j) => { data[key] = parts[j]; });
    const widest = Math.max(...parts.map(p => textWidth(p, speaker.fontSize, advances)));
    if (speaker.pill.hug) {
      const width = widest + 2 * speaker.pill.textPad;
      if (width > speaker.pill.pillWidth * HUG_LIMIT) throw new CoverFitError('Speaker name is too long for the name pill');
      data[`speaker${i + 1}_pill_width`] = num(width);
      data[`speaker${i + 1}_pill_x`] = num(speaker.pill.centerX - width / 2);
    } else if (widest > speaker.pill.pillWidth * 0.92) throw new CoverFitError('Speaker name is too long for the name pill');
  });
  return data;
}

/** Convert a Banner Generator `dtc-event` template into a self-contained bundle template. */
export function figmaBundleTemplate(entry: FigmaManifestEntry, html: string): BannerTemplate {
  const converted = html
    .replace(/<link rel="stylesheet" href="\.\.\/assets\/ubuntu\.css">/, '<style>{{assetFont}}</style>')
    .replace(/\.\.\/assets\/texture\.png/g, '{{assetTexture}}')
    .replace(/\.\.\/assets\/icon-workshop\.png/g, '{{assetIcon}}')
    .replace(/\$\{(\w+)\}/g, '{{$1}}');
  return {
    id: `figma-${entry.template}`, eventType: entry.eventType as BannerTemplate['eventType'], layout: entry.layout,
    speakerCount: entry.speakers.length, width: entry.width, height: entry.height, html: converted,
    ...(entry.sponsorLogo ? { sponsorTreatment: 'approved-logo' as const } : {}),
    figma: { title: entry.title, label: entry.label, speakers: entry.speakers },
  };
}

export type FigmaSource = { entries: FigmaManifestEntry[]; templates: BannerTemplate[]; advances: Advances; assets: Record<string, string> };
/** Read a checkout of banner_generator/templates/dtc-event. Frames without a DataOps event type (open-source spotlight) are skipped. */
export function loadFigmaSource(dir: string): FigmaSource {
  const entries = (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as FigmaManifestEntry[]).filter(e => ['workshop', 'webinar', 'podcast'].includes(e.eventType));
  const templates = entries.map(e => figmaBundleTemplate(e, readFileSync(join(dir, e.template, 'template.html'), 'utf8')));
  const seen = new Set<string>();
  for (const t of templates) {
    const key = `${t.eventType}/${t.layout}/${t.speakerCount}/${t.sponsorTreatment || ''}`;
    if (seen.has(key)) throw new Error(`Two Figma frames map to the same DataOps template: ${key}`);
    seen.add(key);
  }
  const data = (file: string, type: string) => `data:${type};base64,${readFileSync(join(dir, 'assets', file)).toString('base64')}`;
  return {
    entries, templates,
    advances: JSON.parse(readFileSync(join(dir, 'font-metrics.json'), 'utf8')).advance,
    assets: {
      assetFont: readFileSync(join(dir, 'assets', 'ubuntu.css'), 'utf8'),
      assetTexture: data('texture.png', 'image/png'),
      assetIcon: data('icon-workshop.png', 'image/png'),
    },
  };
}
