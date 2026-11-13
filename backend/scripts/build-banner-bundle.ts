/**
 * Build the next private banner template bundle from the current one: replaces the
 * one-speaker podcast covers with the flow layout in src/banners/podcastLayout.ts and
 * adds the DataTalks.Club logo asset. Writes the content-addressed bundle to --out-dir
 * and prints its key; upload it with `aws s3 cp` and point BannerTemplateBundleKey at it.
 *
 *   tsx scripts/build-banner-bundle.ts --current bundle.json --logo logo.svg --out-dir DIR
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BannerBundle } from '../src/banners/model';
import { podcastOneSpeakerTemplate } from '../src/banners/podcastLayout';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); if (i < 0 || !process.argv[i + 1]) throw new Error(`--${name} is required`); return process.argv[i + 1]; };
const bundle = JSON.parse(readFileSync(arg('current'), 'utf8')) as BannerBundle;
const logo = readFileSync(arg('logo'));
const replaced = new Set<string>();
const templates = bundle.templates.map(t => {
  if (t.eventType === 'podcast' && t.speakerCount === 1 && !t.sponsorTreatment) { replaced.add(t.layout); return podcastOneSpeakerTemplate(t.layout); }
  return t;
});
if (replaced.size !== 2) throw new Error('Current bundle has no one-speaker podcast square+landscape templates to replace');
const next: BannerBundle = {
  ...bundle,
  sourceRevision: `${bundle.sourceRevision};podcast-flow-layout-v2`,
  assets: { ...bundle.assets, assetLogo: `data:image/svg+xml;base64,${logo.toString('base64')}` },
  templates,
};
const bytes = Buffer.from(JSON.stringify(next));
const hash = createHash('sha256').update(bytes).digest('hex');
const key = `banner-templates/${hash}/bundle.json`;
mkdirSync(join(arg('out-dir'), 'banner-templates', hash), { recursive: true });
writeFileSync(join(arg('out-dir'), key), bytes);
console.log(key);
