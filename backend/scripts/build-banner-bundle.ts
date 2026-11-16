/**
 * Build the next private banner template bundle from the current one: every event cover
 * that has a Figma frame (Banner Generator `dtc-event`, Figma node 3613:146) is replaced
 * by that frame, exactly as designed (no date line, no logo). Combinations Figma has no
 * frame for (e.g. three speakers) keep the current bundle's template. Writes the
 * content-addressed bundle to --out-dir and prints its key.
 *
 *   tsx scripts/build-banner-bundle.ts --current bundle.json --figma-dir DIR/banner_generator/templates/dtc-event \
 *       --figma-revision SHA --out-dir DIR
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BannerBundle } from '../src/banners/model';
import { loadFigmaSource } from '../src/banners/figmaCover';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); if (i < 0 || !process.argv[i + 1]) throw new Error(`--${name} is required`); return process.argv[i + 1]; };
const bundle = JSON.parse(readFileSync(arg('current'), 'utf8')) as BannerBundle;
const figma = loadFigmaSource(arg('figma-dir'));
const revision = arg('figma-revision');
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('--figma-revision must be a full commit SHA of AI-Shipping-Labs/banner-generator');
const key = (t: { eventType: string; layout: string; speakerCount: number; sponsorTreatment?: string }) => `${t.eventType}/${t.layout}/${t.speakerCount}/${t.sponsorTreatment || ''}`;
const figmaKeys = new Set(figma.templates.map(key));
const kept = bundle.templates.filter(t => !figmaKeys.has(key(t)));
const next: BannerBundle = {
  ...bundle,
  sourceRevision: `banner-generator:${revision};figma-3613-146`,
  assets: { ...bundle.assets, ...figma.assets },
  fontAdvances: figma.advances,
  templates: [...figma.templates, ...kept],
};
const bytes = Buffer.from(JSON.stringify(next));
const hash = createHash('sha256').update(bytes).digest('hex');
const out = `banner-templates/${hash}/bundle.json`;
mkdirSync(join(arg('out-dir'), 'banner-templates', hash), { recursive: true });
writeFileSync(join(arg('out-dir'), out), bytes);
console.log(out);
