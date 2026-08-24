const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const {
  berlinBusinessDate,
  offsetBusinessDate,
} = require('./helpers/business-date');

const ROOT = path.resolve(__dirname, '..', '..');
const GRACE_ID = '00000000-0000-0000-0000-000000000001';
const SCREENSHOT_DIR = path.resolve(
  ROOT,
  '.tmp',
  'screenshots',
  'issue-201',
);

let server;
let baseURL;

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForServer(url) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok) return resolve();
      } catch {}
      if (Date.now() >= deadline) return reject(new Error('Issue 201 test server timed out'));
      setTimeout(poll, 100);
    };
    poll();
  });
}

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createAttentionFixtures(request) {
  const id = suffix();
  const now = Date.now();
  const today = berlinBusinessDate(now);
  const twoDaysAgo = offsetBusinessDate(now, -2);

  async function createTask(description, data) {
    const response = await request.post('/api/tasks', {
      data: { description, ...data },
    });
    expect(response.status()).toBe(201);
    return response.json();
  }

  const [overdue, followUp, todayTask] = await Promise.all([
    createTask(`Issue 201 overdue ${id}`, {
      date: offsetBusinessDate(now, -1),
      assigneeId: GRACE_ID,
    }),
    createTask(`Issue 201 follow-up ${id}`, {
      date: offsetBusinessDate(now, 1),
      status: 'waiting',
      assigneeId: GRACE_ID,
      waitingFor: 'Synthetic reply',
      followUpAt: `${twoDaysAgo}T12:00:00.000Z`,
      comment: 'Public-safe Home urgency fixture',
    }),
    createTask(`Issue 201 today ${id}`, {
      date: today,
      assigneeId: GRACE_ID,
    }),
  ]);

  const cardResponse = await request.post('/api/cards', {
    data: {
      title: `Issue 201 proof workflow ${id}`,
      anchorDate: offsetBusinessDate(now, 1),
      stage: 'preparation',
    },
  });
  expect(cardResponse.status()).toBe(201);
  const card = (await cardResponse.json()).card;
  const proofTask = await createTask(`Issue 201 missing proof ${id}`, {
    date: offsetBusinessDate(now, 1),
    cardId: card.id,
    assigneeId: GRACE_ID,
    requiredLinkName: 'Evidence URL',
  });

  return { followUp, overdue, proofTask, today: todayTask };
}

async function expectNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    offenders: [...document.body.querySelectorAll("*")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          className: typeof element.className === "string" ? element.className : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          tag: element.tagName.toLowerCase(),
        };
      })
      .filter(({ left, right }) => left < 0 || right > document.documentElement.clientWidth)
      .slice(0, 8),
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.documentScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(
    metrics.viewportWidth,
  );
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(
    metrics.viewportWidth,
  );
}

async function expectAttentionRowsDoNotOverlap(page) {
  const metrics = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const rows = [...document.querySelectorAll('.home-attention-row')].map(
      (row) => ({
        className: row.className,
        controls: [
          ...row.querySelectorAll(
            '.home-task-marker, strong, time, button',
          ),
        ].map((control) => {
          const rect = control.getBoundingClientRect();
          return {
            className: String(control.className || ''),
            height: rect.height,
            left: rect.left,
            right: rect.right,
            text: control.textContent.trim(),
            top: rect.top,
            width: rect.width,
          };
        }),
      }),
    );
    return { clientWidth, rows };
  });

  expect(metrics.rows).toHaveLength(4);
  for (const row of metrics.rows) {
    for (const control of row.controls) {
      expect(
        control.height,
        `${row.className}: ${control.text} height`,
      ).toBeGreaterThan(0);
      expect(
        control.width,
        `${row.className}: ${control.text} width`,
      ).toBeGreaterThan(0);
      expect(control.left).toBeGreaterThanOrEqual(-0.5);
      expect(control.right).toBeLessThanOrEqual(metrics.clientWidth + 0.5);
    }

    for (let left = 0; left < row.controls.length; left += 1) {
      for (let right = left + 1; right < row.controls.length; right += 1) {
        const first = row.controls[left];
        const second = row.controls[right];
        const overlapWidth =
          Math.min(first.right, second.right) - Math.max(first.left, second.left);
        const overlapHeight =
          Math.min(first.top + first.height, second.top + second.height) -
          Math.max(first.top, second.top);
        const overlapArea =
          Math.max(overlapWidth, 0) * Math.max(overlapHeight, 0);
        expect(
          overlapArea,
          `${row.className}: ${first.text} / ${second.text}`,
        ).toBeLessThanOrEqual(0.5);
      }
    }
  }
}

test.describe('issue 201 Home attention urgency', () => {
  test.beforeAll(async () => {
    const port = await freePort();
    baseURL = `http://127.0.0.1:${port}`;
    const cacheRoot = createDocsCacheRoot('issue-201-home-attention');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    server = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/test-server.ts'], {
      cwd: path.join(ROOT, 'backend'),
      detached: true,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        IS_LOCAL: 'true',
        SKIP_AUTH: 'true',
        DATAOPS_DOCS_DOMAIN: '1',
        DTC_OFFLINE: '1',
        DTC_CACHE_ROOT: cacheRoot,
        FRONTEND_ROOT: path.join(ROOT, 'frontend'),
        CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
        CONVERSATIONAL_EXECUTION_ENABLED: 'false',
        CONVERSATIONAL_ENABLED_PLUGINS: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(baseURL);
  });

  test.afterAll(() => {
    if (!server) return;
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  });

  test('retains urgency cues without hidden exception badges', async ({ browser }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    const fixtures = await createAttentionFixtures(context.request);
    const expected = [
      {
        action: 'Open',
        className: 'overdue',
        task: fixtures.overdue,
        text: 'Due yesterday',
      },
      {
        action: 'Follow up',
        className: 'follow-up',
        task: fixtures.followUp,
        text: 'Follow-up 2 days overdue',
      },
      {
        action: 'Open',
        className: 'today',
        task: fixtures.today,
        text: 'Due today',
      },
      {
        action: 'Add proof',
        className: 'missing-proof',
        task: fixtures.proofTask,
        text: 'Proof required',
      },
    ];

    await page.goto(`${baseURL}/#/`);
    const attention = page.getByRole('region', { name: 'Needs your attention' });
    await expect(
      page.locator('.operations-home[data-operations-work-loaded="true"]'),
    ).toBeVisible();

    const rows = [];
    for (const item of expected) {
      const row = attention.locator('.home-attention-row', {
        hasText: item.task.description,
      });
      await expect(row).toHaveCount(1);
      await expect(row).toHaveClass(new RegExp(`home-attention-${item.className}`));
      await expect(row.locator('strong')).toHaveText(item.task.description);
      await expect(row.locator('.home-task-marker')).toBeVisible();
      await expect(row.locator('.home-task-state time')).toHaveText(item.text);
      await expect(row.getByRole('button', {
        name: `${item.action}: ${item.task.description}`,
      })).toBeVisible();
      rows.push(row);
    }

    const renderedTitles = await attention
      .locator('.home-task-content strong')
      .allTextContents();
    const positions = expected.map(({ task }) => renderedTitles.indexOf(task.description));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    await expect(page.locator('[class*="home-exception"]')).toHaveCount(0);

    for (const [index, item] of expected.entries()) {
      await rows[index].getByRole('button', {
        name: `${item.action}: ${item.task.description}`,
      }).click();
      await expect(page.locator('#task-panel-title')).toHaveText(item.task.description);
      await page.locator('#task-panel-close').click();
      await expect(page.locator('#task-panel')).toBeHidden();
      if (index < expected.length - 1) {
        await page.goto(`${baseURL}/#/`);
        await expect(
          page.locator('.operations-home[data-operations-work-loaded="true"]'),
        ).toBeVisible();
      }
    }

    await page.goto(`${baseURL}/#/`);
    await expect(
      page.locator('.operations-home[data-operations-work-loaded="true"]'),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAttentionRowsDoNotOverlap(page);
    await page.screenshot({
      fullPage: true,
      path: path.join(SCREENSHOT_DIR, 'home-attention-desktop.png'),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    for (const row of rows) await expect(row).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAttentionRowsDoNotOverlap(page);
    await expect(page.locator('[class*="home-exception"]')).toHaveCount(0);
    await page.screenshot({
      fullPage: true,
      path: path.join(SCREENSHOT_DIR, 'home-attention-mobile.png'),
    });
    await context.close();
  });
});
