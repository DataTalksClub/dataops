/**
 * Playwright fixtures for E2E tests.
 *
 * Provides a signed-in `page`.
 * Also patches the base `page` fixture to inject a session token so browser tests
 * that use `page.goto(...)` don't see the sign-in form.
 */

const { test: base, expect } = require('@playwright/test');

const TOKEN_KEY = 'dataops_token';
const USER_KEY = 'dataops_user';

/**
 * Extended test that patches `page` to automatically have a session injected.
 * The session token comes from the test server's seeded-operator session.
 *
 * This ensures browser tests don't see the sign-in form.
 */
const test = base.extend({
  // Override the default page fixture to inject auth session
  page: async ({ page, request }, use) => {
    let token = null;
    let user = null;

    try {
      // There is no password login: the test server mints a session for the
      // seeded operator.
      const sessionRes = await request.get('/__e2e__/bearer-session');
      if (sessionRes.status() === 200) {
        const data = await sessionRes.json();
        token = data.token;
        user = data.user;
      }
    } catch (e) {
      // No seeded session - will use null token
    }

    if (token && user) {
      // Inject the real session into localStorage before each page navigation
      await page.addInitScript((args) => {
        localStorage.setItem(args.tokenKey, args.token);
        localStorage.setItem(args.userKey, JSON.stringify(args.user));
      }, {
        tokenKey: TOKEN_KEY,
        userKey: USER_KEY,
        token,
        user,
      });
    }

    await use(page);
  },
});

module.exports = { test, expect };
