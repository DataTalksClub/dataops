import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadFigmaSource, fitCover, wrapTitle, CoverFitError } from '../src/banners/figmaCover';
import { composeBanner, type BannerJob } from '../src/banners/model';

const source = loadFigmaSource(join(__dirname, 'fixtures/figma-cover'));
const [template] = source.templates;
const job = (title: string, name: string, label?: 'Live Q&A'): BannerJob => ({
  id: 'j', bundleKey: 'k', cardId: 'c', title, state: 'queued', createdBy: 'u', createdAt: '', updatedAt: '',
  input: { eventType: 'podcast', layout: 'square', speakers: [{ personId: 'p', portraitFileId: 'f' }], revision: 'r', ...(label ? { eventLabel: label } : {}) },
  speakers: [{ personId: 'p', portraitFileId: 'f', name, personVersion: 1, checksum: 'sha256:x' }],
  schedule: { date: 'Mon, 30 November 2026', time: '17:00 CET' },
});

test('Figma podcast square keeps the Figma design: PODCAST pill, mic, centred title, name pill, no date line, no logo', () => {
  assert.equal(template.id, 'figma-podcast-1-speaker-luma');
  const html = composeBanner(template, job('From HR Reports to People Analytics with AI', 'Sofiia Hordiienko'), ['data:image/png;base64,AAAA'], source.assets, undefined, source.advances);
  assert.ok(!/\{\{|\$\{/.test(html));
  assert.match(html, /viewBox="982 1008 2000 2000"/);
  assert.match(html, /font-size="150"/);
  assert.match(html, />PODCAST</);
  assert.match(html, />Sofiia</);
  assert.match(html, />Hordiienko</);
  assert.match(html, />From HR Reports</);
  assert.ok(!/November|17:00|DataTalks\.Club|class="logo"/.test(html), 'the Figma design has no date line or logo');
});

test('titles wrap into the frame line count, balanced, and shrink only when needed', () => {
  const entry = template.figma!;
  const adv = source.advances;
  const short = wrapTitle('From HR Reports to People Analytics with AI', 3, 150, 1690, adv);
  assert.equal(short.size, 150);
  assert.ok(short.lines.every(Boolean));
  const long = wrapTitle('Shipping Reliable LLMs and the Rise of AI Engineering: What Changes When Agents Query Live Data', 3, 150, 1690, adv);
  assert.ok(long.size < 150);
  assert.throws(() => fitCover(entry, adv, 'word '.repeat(200), ['A B']), CoverFitError);
});

test('Live Q&A override keeps the label inside a pill that is never narrower than the Figma pill', () => {
  const html = composeBanner(template, job('A title', 'Ann Lee', 'Live Q&A'), ['data:image/png;base64,AAAA'], source.assets, undefined, source.advances);
  assert.match(html, /LIVE Q&amp;A/);
  assert.ok(Number(/<rect x="1272" y="1197.22" width="([\d.]+)"/.exec(html)![1]) >= 422);
});
