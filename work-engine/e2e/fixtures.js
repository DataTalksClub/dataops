/**
 * Playwright fixtures for E2E tests.
 *
 * Provides an `authedPage` fixture that automatically logs in before navigating.
 * Also patches the base `page` fixture to inject a session token so browser tests
 * that use `page.goto(...)` don't see the sign-in form.
 */

const { test: base, expect } = require('@playwright/test');

const TOKEN_KEY = 'datatasks_token';
const USER_KEY = 'datatasks_user';
const GRACE_EMAIL = 'grace@datatalks.club';
const GRACE_PASSWORD = '111';
const GRACE_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Extended test that patches `page` to automatically have a session injected.
 * The session token is obtained by logging in via the API.
 *
 * This ensures browser tests don't see the sign-in form.
 */
const test = base.extend({
  // Override the default page fixture to inject auth session
  page: async ({ page, request }, use) => {
    // Try to get a real token by logging in
    let token = null;
    let user = null;

    try {
      const loginRes = await request.post('/api/auth/login', {
        data: { email: GRACE_EMAIL, password: GRACE_PASSWORD },
      });
      if (loginRes.status() === 200) {
        const data = await loginRes.json();
        token = data.token;
        user = data.user;
      }
    } catch (e) {
      // Login failed - will use null token
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
