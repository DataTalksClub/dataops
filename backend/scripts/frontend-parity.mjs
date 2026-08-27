import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tempRoot = join(repoRoot, '.tmp', 'issue-159');
const screenshotRoot = join(repoRoot, '.tmp', 'screenshots', 'issue-159');
const targetServer = join(repoRoot, 'backend', 'scripts', 'frontend-parity-target.mjs');
const samSource = join(repoRoot, '.aws-sam', 'build', 'BackendFunction');
const samCopy = join(tempRoot, 'isolated-sam');
const frontendAssets = JSON.parse(readFileSync(
  join(repoRoot, 'backend', 'src', 'docs', 'frontend-assets.json'),
  'utf8',
)).files;
const fixedTime = new Date('2026-08-12T10:15:00.000Z');
const states = [
  'home-ready',
  'inbox-blocked-detail',
  'task-proof-waiting-return',
  'workflow-detail',
  'assistant-detail-baseline',
  'template-projection-readonly',
  'notifications-dismissed',
  'sponsor-booking-role-safe',
  'docs-search-detail',
  'settings-users-role',
];
const viewports = {
  'desktop-1440x900': { width: 1440, height: 900 },
  'mobile-390x844': { width: 390, height: 844 },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEvidenceText(value) {
  return String(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\s+/g, ' ')
    .trim();
}

function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const poll = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolveWait();
      } catch {}
      if (Date.now() >= deadline) return rejectWait(new Error(`Target did not become ready: ${url}`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

function pngDimensions(path) {
  const bytes = readFileSync(path);
  if (bytes.toString('hex', 1, 4) !== '504e47') throw new Error(`Not a PNG: ${path}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function createDocsCache(target) {
  const cache = join(tempRoot, `docs-${target}`);
  mkdirSync(join(cache, 'content', 'synthetic'), { recursive: true });
  writeFileSync(join(cache, 'content', 'synthetic', 'parity.md'), `---
id: sop.synthetic.parity
aliases: []
title: Synthetic parity process
summary: Public-safe local fixture for canonical frontend behavior evidence.
doc_type: sop
schema_version: 1
systems:
  - synthetic-system
tags:
  - synthetic
---

# Synthetic parity process

<!-- sop-section-start: summary -->
## Summary
Public-safe local fixture for canonical frontend behavior evidence.
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites
Use synthetic records only.
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure
<!-- sop-step-start id=1 systems="synthetic-system" -->
1. Verify synthetic proof.
Record a synthetic completion note and confirm the local result.
<!-- sop-step-end -->
<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation
The local result is visible.
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting
Retry the local request.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References
None.
<!-- sop-section-end -->
`);
  return cache;
}

function createLocalSchema(endpoint) {
  return new Promise((resolveSetup, rejectSetup) => {
    const setup = spawn(process.execPath, ['--import', 'tsx', '--eval', [
      "Promise.all([import('./backend/scripts/local-dynamodb.ts'), import('./backend/src/db/client.ts')])",
      '.then(async ([local, client]) => local.createTables(await client.getClient()))',
    ].join('')], {
      cwd: repoRoot,
      env: { ...process.env, DYNAMODB_ENDPOINT: endpoint },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    setup.stderr.setEncoding('utf8');
    setup.stderr.on('data', (chunk) => { stderr += chunk; });
    setup.once('error', rejectSetup);
    setup.once('exit', (status) => {
      if (status === 0) resolveSetup();
      else rejectSetup(new Error(`Local schema setup failed:\n${stderr}`));
    });
  });
}

async function launchTarget(target, port, root) {
  const require = createRequire(import.meta.url);
  const dynalite = require('dynalite')({ createTableMs: 0 });
  await new Promise((resolveListen, rejectListen) => dynalite.listen(0, '127.0.0.1', (error) => error ? rejectListen(error) : resolveListen()));
  const endpoint = `http://127.0.0.1:${dynalite.address().port}`;
  await createLocalSchema(endpoint);
  const cache = createDocsCache(target);
  const child = spawn(process.execPath, ['--import', 'tsx', targetServer, '--mode', target, '--root', root, '--port', String(port), '--dynamo', endpoint, '--cache', cache], {
    cwd: repoRoot,
    env: { ...process.env, NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.resume();
  try {
    await waitFor(`http://127.0.0.1:${port}/__parity__/health`);
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  }
  return {
    baseURL: `http://127.0.0.1:${port}`,
    async close() {
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      await Promise.race([exited, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000))]);
      await new Promise((resolveClose) => dynalite.close(() => resolveClose()));
    },
  };
}

async function reset(baseURL) {
  const response = await fetch(`${baseURL}/__parity__/reset`, { method: 'POST' });
  if (!response.ok) throw new Error(`Fixture reset failed: ${response.status}`);
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(250);
  await page.waitForFunction(() => document.body.dataset.view === 'library');
}

async function navigateState(page, baseURL, state) {
  await reset(baseURL);
  let role = 'admin';
  if (state === 'sponsor-booking-role-safe') role = 'operator';
  await page.goto(`${baseURL}/__parity__/session?role=${role}`);
  const result = { mutation: 'none' };
  if (state === 'home-ready') {
    await page.goto(`${baseURL}/#/`);
    await settle(page);
    const home = page.locator('.operations-home-daily');
    await home.waitFor({ state: 'visible' });
    await page.locator('.operations-home-daily[data-operations-work-loaded="true"]').waitFor();
  } else if (state === 'inbox-blocked-detail') {
    await page.goto(`${baseURL}/#/inbox?intakeId=parity-intake`);
    await settle(page);
    await page.locator('.intake-detail h3').filter({ hasText: 'Synthetic blocked intake' }).waitFor();
  } else if (state === 'task-proof-waiting-return') {
    await page.goto(`${baseURL}/#/tasks?taskId=parity-task&date=2026-08-12&cardId=parity-workflow&contextCardId=parity-return`);
    await settle(page);
    await page.locator('#task-panel-title').filter({ hasText: 'Verify synthetic publication proof' }).waitFor();
  } else if (state === 'workflow-detail') {
    await page.goto(`${baseURL}/#/cards?cardId=parity-workflow&taskId=parity-task`);
    await settle(page);
    await page.locator('#card-panel-title').filter({ hasText: 'Synthetic publication workflow' }).waitFor();
  } else if (state === 'assistant-detail-baseline') {
    await page.goto(`${baseURL}/#/assistants?assistantJobId=parity-assistant`);
    await settle(page);
    await page.locator('.assistant-detail h3').filter({ hasText: 'Synthetic assistant baseline' }).waitFor();
    result.mutation = 'non-mutating-list-detail';
  } else if (state === 'template-projection-readonly') {
    await page.goto(`${baseURL}/#/templates?templateId=parity-template`);
    await settle(page);
    await page.locator('.runtime-template-projection').waitFor();
    await page.getByText('workflow-templates/parity-template.yaml').waitFor();
    result.mutation = 'non-mutating-template-projection';
  } else if (state === 'notifications-dismissed') {
    await page.goto(`${baseURL}/#/notifications`);
    await settle(page);
    const items = page.locator('.work-bell-item');
    await items.first().waitFor();
    for (let guard = 0; guard < 20; guard += 1) {
      const remaining = await items.count();
      if (remaining === 0) break;
      await items.first().getByRole('button', { name: /Dismiss notification/ }).click();
      await items.nth(remaining - 1).waitFor({ state: 'detached' });
    }
    await page.getByText('No active notifications.').waitFor();
    result.mutation = 'notification-dismissed';
  } else if (state === 'sponsor-booking-role-safe') {
    await page.goto(`${baseURL}/#/sponsors?bookingId=parity-booking`);
    await settle(page);
    const sponsorDetail = page.locator("[data-crm-detail] .crm-booking-detail");
    await sponsorDetail.filter({ hasText: "Synthetic Learning Co" }).waitFor();
    await sponsorDetail.filter({ hasText: "confirmed" }).waitFor();
    result.mutation = 'operator-read-only';
  } else if (state === 'docs-search-detail') {
    await page.goto(`${baseURL}/#/processes`);
    await settle(page);
    await page.locator('#library-view').waitFor({ state: 'visible' });
    await page.getByRole('heading', { name: 'Docs', exact: true }).waitFor({ state: 'visible' });
    if (page.viewportSize().width < 700) await page.locator('#mobile-menu-button').click();
    const search = page.locator('#search-input');
    await search.fill('Synthetic parity process');
    const searchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/search' && url.searchParams.get('q') === 'Synthetic parity process';
    });
    await page.locator('#search-form').evaluate((form) => form.requestSubmit());
    if (!(await searchResponse).ok()) throw new Error('Docs parity search failed');
    const link = page.locator('.unified-search-row', { hasText: 'Synthetic parity process' }).first();
    await link.waitFor({ state: 'attached' });
    await link.click({ force: true });
    await page.locator('#rendered-view').getByText('Public-safe local fixture for canonical frontend behavior evidence.').waitFor();
    result.mutation = 'docs-search-detail';
  } else if (state === 'settings-users-role') {
    await page.goto(`${baseURL}/#/users`);
    await settle(page);
    await page.locator('.ops-user-row .ops-user-name').filter({ hasText: 'Synthetic parity operator' }).waitFor();
    const opener = page.viewportSize().width < 700 ? page.locator('#mobile-settings-button') : page.locator('#settings-button');
    await opener.click();
    await page.locator('#settings-menu').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'settings-menu-close');
    result.mutation = 'server-admin-role';
  }
  return result;
}

async function assetHashes(page) {
  return page.evaluate(async (assets) => {
    const digest = async (path) => {
      const bytes = await (await fetch(path, { credentials: 'same-origin' })).arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const hashes = {};
    for (const asset of assets) hashes[asset] = await digest(`/${asset}`);
    return hashes;
  }, frontendAssets);
}

async function captureTarget(target, baseURL, browser) {
  const evidence = [];
  for (const [viewportName, viewport] of Object.entries(viewports)) {
    for (const state of states) {
      const context = await browser.newContext({
        baseURL,
        viewport,
        locale: 'en-GB',
        timezoneId: 'Europe/Berlin',
        reducedMotion: 'reduce',
        colorScheme: 'light',
      });
      const page = await context.newPage();
      await page.clock.setFixedTime(fixedTime);
      await page.addInitScript(() => {
        addEventListener('DOMContentLoaded', () => {
          const style = document.createElement('style');
          style.textContent = 'html,body,button,input,select,textarea{font-family:Arial,sans-serif!important}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
          document.documentElement.append(style);
        }, { once: true });
      });
      const consoleErrors = [];
      const pageErrors = [];
      const failedResponses = [];
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
      page.on('response', (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`); });
      const action = await navigateState(page, baseURL, state);
      await page.waitForLoadState('networkidle');
      consoleErrors.sort();
      pageErrors.sort();
      failedResponses.sort();
      const screenshot = join(screenshotRoot, `${target}-${state}-${viewportName}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      const dimensions = pngDimensions(screenshot);
      if (dimensions.width !== viewport.width || dimensions.height !== viewport.height) throw new Error(`Wrong screenshot dimensions: ${screenshot}`);
      const accessibleSummary = normalizeEvidenceText(await page.locator('body').ariaSnapshot());
      const visibleSummary = normalizeEvidenceText(await page.locator('body').innerText());
      for (const [summaryType, summary] of [['visible', visibleSummary], ['accessible', accessibleSummary]]) {
        if (/\bNaN\b|got \[NaN\]|step id=NaN|\[object (?:HTMLElement|Text)\]/.test(summary)) {
          throw new Error(`${target}/${state}/${viewportName} contains invalid ${summaryType} evidence copy`);
        }
      }
      evidence.push({
        target,
        state,
        viewport: viewportName,
        route: new URL(page.url()).hash || new URL(page.url()).pathname,
        title: await page.locator('#document-list h1, #document-list h2, #document-list h3').first().innerText(),
        mutation: action.mutation,
        visibleSummary,
        visibleHash: sha256(visibleSummary),
        accessibleSummary,
        accessibleHash: sha256(accessibleSummary),
        fontFamily: await page.locator('body').evaluate((element) => getComputedStyle(element).fontFamily),
        consoleErrors,
        pageErrors,
        failedResponses,
        assets: await assetHashes(page),
        screenshot: screenshot.slice(repoRoot.length + 1),
        screenshotSha256: sha256(readFileSync(screenshot)),
        dimensions,
      });
      if (consoleErrors.length || pageErrors.length || failedResponses.length) {
        throw new Error(`${target}/${state}/${viewportName} emitted browser or response errors: ${JSON.stringify({ consoleErrors, pageErrors, failedResponses })}`);
      }
      await context.close();
    }
  }
  return evidence;
}

function compareEvidence(all) {
  for (const state of states) {
    for (const viewport of Object.keys(viewports)) {
      const source = all.find((entry) => entry.target === 'source' && entry.state === state && entry.viewport === viewport);
      const sam = all.find((entry) => entry.target === 'sam' && entry.state === state && entry.viewport === viewport);
      for (const key of ['route', 'title', 'mutation', 'visibleSummary', 'visibleHash', 'accessibleSummary', 'accessibleHash', 'fontFamily']) {
        if (source[key] !== sam[key]) throw new Error(`Source/SAM mismatch for ${state}/${viewport}: ${key}`);
      }
      for (const key of ['consoleErrors', 'pageErrors', 'failedResponses']) {
        if (JSON.stringify(source[key]) !== JSON.stringify(sam[key])) throw new Error(`Source/SAM mismatch for ${state}/${viewport}: ${key} ${JSON.stringify({ source: source[key], sam: sam[key] })}`);
      }
      if (JSON.stringify(source.assets) !== JSON.stringify(sam.assets)) throw new Error(`Asset mismatch for ${state}/${viewport}`);
    }
  }
}

async function main() {
  rmSync(screenshotRoot, { recursive: true, force: true });
  rmSync(samCopy, { recursive: true, force: true });
  mkdirSync(screenshotRoot, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  const verify = spawnSync(process.execPath, [join(repoRoot, 'backend', 'scripts', 'verify-frontend-artifact.mjs'), '--source', join(repoRoot, 'frontend'), '--artifact', samSource], { encoding: 'utf8' });
  if (verify.status !== 0) throw new Error(verify.stderr || verify.stdout);
  cpSync(samSource, samCopy, { recursive: true, dereference: false });

  try {
  const browser = await chromium.launch({ headless: true });
  const browserVersion = browser.version();
  const all = [];
  try {
    for (const [target, port, root] of [['source', 31591, join(repoRoot, 'backend')], ['sam', 31592, samCopy]]) {
      const server = await launchTarget(target, port, root);
      try { all.push(...await captureTarget(target, server.baseURL, browser)); }
      finally { await server.close(); }
    }
  } finally {
    await browser.close();
  }
  compareEvidence(all);
  const inventory = readdirSync(screenshotRoot).sort();
  const expected = ['source', 'sam'].flatMap((target) => states.flatMap((state) => Object.keys(viewports).map((viewport) => `${target}-${state}-${viewport}.png`))).sort();
  if (JSON.stringify(inventory) !== JSON.stringify(expected)) throw new Error('Screenshot inventory is not the exact 40-file cross-product');
  const manifest = {
    fixedTime: fixedTime.toISOString(),
    timezone: 'Europe/Berlin',
    locale: 'en-GB',
    reducedMotion: 'reduce',
    fontFamily: 'Arial, sans-serif',
    browser: { engine: 'chromium', version: browserVersion },
    evidence: all,
  };
  writeFileSync(join(tempRoot, 'frontend-parity-evidence.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Frontend parity PASS: ${all.length} evidence records and ${inventory.length} screenshots`);
  } finally {
    rmSync(samCopy, { recursive: true, force: true });
  }
}

await main();
