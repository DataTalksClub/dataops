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
 * Since SKIP_AUTH=true, /api/me will still return 401 for the fake token;
 * use loginAndSetupPage for a real session.
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

/**
 * Inject the test server's real session for the seeded operator. There is no
 * password login: people sign in with SSO, and the test server mints this one.
 */
async function loginAndSetupPage(page, request) {
  const loginRes = await request.get('/__e2e__/bearer-session');

  if (loginRes.status() !== 200) {
    // No seeded session: fall back to the bypass token.
    await setupPageWithAuth(page);
    return null;
  }

  const { token, user } = await loginRes.json();

  // Inject real token into localStorage
  await page.addInitScript((args) => {
    localStorage.setItem(args.tokenKey, args.token);
    localStorage.setItem(args.userKey, JSON.stringify(args.user));
  }, {
    tokenKey: TOKEN_KEY,
    userKey: USER_KEY,
    token,
    user,
  });

  return { token, user };
}

module.exports = { setupPageWithAuth, loginAndSetupPage, TOKEN_KEY, USER_KEY };
