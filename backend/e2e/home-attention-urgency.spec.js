const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require('./helpers/isolated-capability-server');
const {
  berlinBusinessDate,
  offsetBusinessDate,
} = require('./helpers/business-date');

const GRACE_ID = '00000000-0000-0000-0000-000000000001';
const SCREENSHOT_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '.tmp',
  'screenshots',
  'issue-201',
);

let server;
let baseURL;

async function ownedContext(browser, options = {}) {
  const context = await browser.newContext({ baseURL, ...options });
  const health = await context.request.get('/api/health');
  assertOwnedServerResponse(server, health, 'queue urgency health');
  return context;
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
      comment: 'Public-safe queue urgency fixture',
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
    const rows = [...document.querySelectorAll('.ops-queue-row')].map(
      (row) => ({
        className: row.className,
        controls: [
          ...row.querySelectorAll(
            'strong, time, button',
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
          // Timing text and the row action are the urgency cues.
        }).filter((control) => control.height > 0 || control.width > 0 || control.text),
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

test.describe('issue 201 queue urgency cues', () => {
  test.beforeAll(async () => {
    const cacheRoot = createDocsCacheRoot('issue-201-queue-urgency');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: cacheRoot,
        E2E_TEMPLATE_ACTOR_ID: '00000000-0000-0000-0000-000000000001',
      },
    });
    baseURL = server.baseURL;
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });

  test('retains urgency cues without hidden exception badges', async ({ browser }) => {
    const context = await ownedContext(browser, { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    const fixtures = await createAttentionFixtures(context.request);
    const expected = [
      {
        task: fixtures.overdue,
        timing: '1 day overdue',
        proof: false,
      },
      {
        task: fixtures.followUp,
        timing: '2 days overdue',
        proof: false,
      },
      {
        task: fixtures.today,
        timing: 'Due today',
        proof: false,
      },
      {
        task: fixtures.proofTask,
        timing: 'Due tomorrow',
        proof: true,
      },
    ];

    await page.goto(`${baseURL}/#/`);
    const queue = page.locator('.ops-queue-board');
    await expect(queue).toBeVisible();

    const rows = [];
    for (const item of expected) {
      const row = queue.locator('.ops-queue-row', {
        hasText: item.task.description,
      });
      await expect(row).toHaveCount(1);
      await expect(row.locator('strong')).toHaveText(item.task.description);
      // Urgency is stated as text, never as a colored-only marker.
      await expect(row.locator('.ops-queue-meta')).toContainText(item.timing);
      // Proof-blocked work names its blocker instead of claiming "Mark done".
      const summary = row.locator('small');
      if (item.proof) await expect(summary).toContainText('Proof needed');
      else await expect(summary).not.toContainText('Proof needed');
      await expect(row.getByRole('button', {
        name: `Open task ${item.task.description}`,
      })).toBeVisible();
      rows.push(row);
    }

    // One queue, most urgent first: the rendered order is the expected order.
    const renderedTitles = await queue.locator('.ops-queue-row strong').allTextContents();
    const positions = expected.map(({ task }) => renderedTitles.indexOf(task.description));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    await expect(page.locator('[class*="home-exception"]')).toHaveCount(0);

    for (const [index, item] of expected.entries()) {
      await rows[index].click();
      await expect(page.locator('#task-panel-title')).toHaveText(item.task.description);
      await page.locator('#task-panel-close').click();
      await expect(page.locator('#task-panel')).toBeHidden();
      if (index < expected.length - 1) {
        await page.goto(`${baseURL}/#/`);
        await expect(page.locator('.ops-queue-board')).toBeVisible();
      }
    }

    await page.goto(`${baseURL}/#/`);
    await expect(page.locator('.ops-queue-board')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAttentionRowsDoNotOverlap(page);
    await page.screenshot({
      fullPage: true,
      path: path.join(SCREENSHOT_DIR, 'queue-urgency-desktop.png'),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    for (const row of rows) await expect(row).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAttentionRowsDoNotOverlap(page);
    await expect(page.locator('[class*="home-exception"]')).toHaveCount(0);
    await page.screenshot({
      fullPage: true,
      path: path.join(SCREENSHOT_DIR, 'queue-urgency-mobile.png'),
    });
    await context.close();
  });
});
