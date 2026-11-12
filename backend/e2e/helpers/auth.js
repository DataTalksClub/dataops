/**
 * Authentication helpers for E2E tests.
 *
 * The dev server runs with SKIP_AUTH=true, so API calls don't require auth tokens.
 * However, the frontend requires a login session to show the app (not the sign-in form).
 *
 * Use setupPageWithAuth(page) to inject a session into localStorage before navigating.
 */

const TOKEN_KEY = 'dataops_token';
const USER_KEY = 'dataops_user';

const GRACE_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Set up a browser page with a fake auth session injected into localStorage.
 * This bypasses the sign-in form for browser tests.
 *
 * The token used is 'e2e-test-token' which is recognized by the dev server
 * only when SKIP_AUTH=true is set (which it is in playwright.config.js).
 *
 * The SKIP_AUTH test server resolves its configured template actor for
 * /api/me, so no server-side session is needed.
 */
async function setupPageWithAuth(page) {
  // Use addInitScript to set localStorage before page load
  await page.addInitScript((args) => {
    // Store a fake user so the app doesn't try to validate with /api/me
    // on first load. The app checks localStorage first.
    localStorage.setItem(args.tokenKey, args.token);
    localStorage.setItem(args.userKey, JSON.stringify(args.user));
  }, {
    tokenKey: TOKEN_KEY,
    userKey: USER_KEY,
    // Use a special known token that works with the dev server
    token: 'e2e-bypass-token',
    user: {
      id: GRACE_ID,
      name: 'Grace',
      email: 'grace@datatalks.club',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
}

module.exports = { setupPageWithAuth, TOKEN_KEY, USER_KEY };
