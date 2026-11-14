/**
 * Build the next private banner template bundle from the current one: replaces the
 * one-speaker podcast covers with the flow layout in src/banners/podcastLayout.ts and
 * ensures the DataTalks.Club logo asset is embedded. Writes the content-addressed bundle
 * to --out-dir and prints its key.
 *
 *   tsx scripts/build-banner-bundle.ts --current bundle.json [--logo logo.svg] --out-dir DIR
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BannerBundle } from '../src/banners/model';
import { podcastOneSpeakerTemplate } from '../src/banners/podcastLayout';

const optionalArg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined; };
const arg = (name: string) => { const v = optionalArg(name); if (!v) throw new Error(`--${name} is required`); return v; };
const bundle = JSON.parse(readFileSync(arg('current'), 'utf8')) as BannerBundle;
const logoPath = optionalArg('logo');
const assetLogo = logoPath ? `data:image/svg+xml;base64,${readFileSync(logoPath).toString('base64')}` : bundle.assets?.assetLogo;
if (!assetLogo) throw new Error('--logo is required when current bundle has no assets.assetLogo');
const replaced = new Set<string>();
const templates = bundle.templates.map(t => {
  if (t.eventType === 'podcast' && t.speakerCount === 1 && !t.sponsorTreatment) { replaced.add(t.layout); return podcastOneSpeakerTemplate(t.layout); }
  return t;
});
if (replaced.size !== 2) throw new Error('Current bundle has no one-speaker podcast square+landscape templates to replace');
const baseRevision = bundle.sourceRevision.replace(/;podcast-flow-layout-v2$/, '');
const next: BannerBundle = {
  ...bundle,
  sourceRevision: `${baseRevision};podcast-flow-layout-v2`,
  assets: { ...bundle.assets, assetLogo },
  templates,
};
const bytes = Buffer.from(JSON.stringify(next));
const hash = createHash('sha256').update(bytes).digest('hex');
const key = `banner-templates/${hash}/bundle.json`;
mkdirSync(join(arg('out-dir'), 'banner-templates', hash), { recursive: true });
writeFileSync(join(arg('out-dir'), key), bytes);
console.log(key);
