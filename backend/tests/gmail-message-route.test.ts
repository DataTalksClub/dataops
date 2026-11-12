import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { GmailMessageRouteError, resolveGmailMessageRoute } from '../src/sponsorDocs/gmailMessageRoute';

const saved = process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID;
afterEach(() => {
  if (saved === undefined) delete process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID;
  else process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID = saved;
});

test('Orin Gmail route resolves through the real google-calendar-orin connection', async () => {
  delete process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID;
  const requested: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/agent/token')) {
      requested.push(JSON.parse(String(init?.body)).connection_id);
      return Response.json({ access_token: 't', provider_account_id: 'orin@datatalks.club' });
    }
    return Response.json({
      threadId: 'th1',
      payload: { headers: [
        { name: 'From', value: 'Orin <orin@datatalks.club>' },
        { name: 'To', value: 'Sponsor <s@example.com>' },
      ] },
    });
  }) as unknown as typeof fetch;
  const route = await resolveGmailMessageRoute('m1', { fetchImpl, credential: 'c' });
  assert.deepEqual(requested, ['google-calendar-orin']);
  assert.equal(route.threadRef, 'th1');
});

test('a missing Dapier connection names the connection and account', async () => {
  const fetchImpl = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    resolveGmailMessageRoute('m1', { fetchImpl, credential: 'c' }),
    (error: unknown) => error instanceof GmailMessageRouteError
      && /no connection "google-calendar-orin"/.test(error.message)
      && /orin@datatalks\.club/.test(error.message)
      && /DATAOPS_ORIN_GMAIL_CONNECTION_ID/.test(error.message),
  );
});

test('broker failures keep their Gmail route wording', async () => {
  delete process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID;
  const expect = async (fetchImpl: typeof fetch, pattern: RegExp) => assert.rejects(
    resolveGmailMessageRoute('m1', { fetchImpl, credential: 'c' }),
    (error: unknown) => error instanceof GmailMessageRouteError && pattern.test(error.message),
  );
  await expect((async () => new Response('{}', { status: 403 })) as unknown as typeof fetch, /refused the Gmail token .* \(HTTP 403\)/);
  await expect((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, /refused the Gmail token .* \(HTTP unreachable\)/);
  await expect((async () => new Response('not json')) as unknown as typeof fetch, /returned no access token/);
  await expect((async () => Response.json({ access_token: 't', provider_account_id: 'other@example.com' })) as unknown as typeof fetch, /is not verified as orin@datatalks\.club/);
});
