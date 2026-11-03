import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  candidateId, ingestPaymentMail, matchPaidRow, matchPayment, parsePaymentMail, type PaymentMail,
} from '../src/sponsorFinance/paymentMail';
import { pollPaymentMail, setPaymentMailPollDepsForTests } from '../src/sponsorFinance/paymentMailPoll';
import { handleSponsorFinanceRoutes } from '../src/routes/sponsorFinance';

// Real-shaped samples; names, numbers and addresses are fictional.
const ramp = {
  from: 'Ramp <no-reply@ramp.com>',
  subject: 'Payment received: #202610/50',
  body: '<html><body><p>Hi Orin,</p><p>PhoenixData has paid invoice #202610/50.</p><table><tr><td>Amount</td><td>$1,500.00 USD</td></tr></table></body></html>',
};
const stripe = {
  from: 'Stripe <receipts@stripe.com>',
  subject: 'You received a payment of €2.400,00 from Acme GmbH',
  body: 'Acme GmbH paid invoice INV-2026-0042.\nAmount paid: €2.400,00 EUR',
};
const bill = {
  from: 'BILL <notifications@hq.bill.com>',
  subject: 'Payment received for invoice 202611/03',
  body: 'Payment received from Northwind Ltd.\nInvoice number: 202611/03\nAmount: 3,000.00 USD',
};

const row = (over: Record<string, unknown>) => ({
  dealId: 'deal-1', organizationId: 'org-1', organizationName: 'PhoenixData', dealStatus: 'won',
  invoiceState: 'issued', paymentState: 'unpaid', timingState: 'on-time', invoiceNumber: '202610/50',
  amountDue: '1500', outstanding: '1500', currency: 'USD', followUp: { code: 'payment-follow-up' }, ...over,
}) as never;

describe('payment notification parsing', () => {
  it('parses a Ramp mail', () => {
    assert.deepEqual(parsePaymentMail(ramp), { provider: 'ramp', invoiceNumber: '202610/50', amount: '1500.00', currency: 'USD', payer: 'PhoenixData' });
  });
  it('parses a Stripe mail with European number format', () => {
    const parsed = parsePaymentMail(stripe)!;
    assert.equal(parsed.provider, 'stripe');
    assert.equal(parsed.amount, '2400.00');
    assert.equal(parsed.currency, 'EUR');
    assert.equal(parsed.invoiceNumber, 'INV-2026-0042');
  });
  it('parses a BILL mail', () => {
    const parsed = parsePaymentMail(bill)!;
    assert.equal(parsed.provider, 'bill');
    assert.equal(parsed.invoiceNumber, '202611/03');
    assert.equal(parsed.amount, '3000.00');
    assert.equal(parsed.currency, 'USD');
  });
  it('ignores unknown senders, failures and unrelated mail', () => {
    assert.equal(parsePaymentMail({ ...ramp, from: 'x@evil.example' }), null);
    assert.equal(parsePaymentMail({ ...ramp, from: 'a@notramp.com' }), null);
    assert.equal(parsePaymentMail({ from: ramp.from, subject: 'Payment failed: #1', body: 'declined' }), null);
    assert.equal(parsePaymentMail({ from: ramp.from, subject: 'Your weekly summary', body: 'Spend overview' }), null);
  });
});

describe('payment matching', () => {
  it('matches exactly on invoice number, amount and currency', () => {
    const match = matchPayment(parsePaymentMail(ramp)!, [row({}), row({ dealId: 'd2', invoiceNumber: '202610/51', organizationName: 'Other' })])!;
    assert.equal(match.dealId, 'deal-1');
    assert.equal(match.confidence, 'exact');
  });
  it('downgrades when the amount differs and skips paid invoices', () => {
    assert.equal(matchPayment(parsePaymentMail(ramp)!, [row({ outstanding: '1400', amountDue: '1400' })])!.confidence, 'invoice');
    assert.equal(matchPayment(parsePaymentMail(ramp)!, [row({ paymentState: 'paid' })]), null);
  });
  it('does not guess between ambiguous sponsors', () => {
    const parsed = { provider: 'stripe' as const, amount: '1500.00', currency: 'USD', payer: 'PhoenixData' };
    assert.equal(matchPayment(parsed, [row({ invoiceNumber: undefined }), row({ dealId: 'd2', invoiceNumber: undefined })]), null);
  });
});

// PhoenixData-shaped backfill: the paid deal predates the stored invoice number,
// so the mail resolves against the paid row by amount, currency, sponsor and date.
const paidRow = (over: Record<string, unknown>) => row({
  paymentState: 'paid', invoiceNumber: undefined, outstanding: '0', paid: '3700', amountDue: '3700',
  currency: 'EUR', lastPaymentOn: '2026-10-29', ...over,
});
const phoenixMail = () => parsePaymentMail({
  from: 'Ramp <no-reply@ramp.com>', subject: 'Payment received: #202610/50',
  body: 'PhoenixData has paid invoice #202610/50. Amount: EUR 3,700.00',
})!;

describe('already-paid fallback', () => {
  it('resolves a paid deal without a stored invoice number', () => {
    const hit = matchPaidRow(phoenixMail(), '2026-10-29', [paidRow({})])!;
    assert.equal(hit.dealId, 'deal-1');
  });
  it('refuses ties, distant dates, wrong amounts and open rows', () => {
    assert.equal(matchPaidRow(phoenixMail(), '2026-10-29', [paidRow({}), paidRow({ dealId: 'd2' })]), null);
    assert.equal(matchPaidRow(phoenixMail(), '2026-12-31', [paidRow({})]), null);
    assert.equal(matchPaidRow(phoenixMail(), '2026-10-29', [paidRow({ paid: '3600', amountDue: '3600' })]), null);
    assert.equal(matchPaidRow(phoenixMail(), '2026-10-29', [row({})]), null);
    assert.equal(matchPaidRow({ ...phoenixMail(), payer: undefined }, '2026-10-29', [paidRow({})]), null);
  });
});

function fakeClient() {
  const store = new Map<string, any>();
  return {
    store,
    send: async (command: any) => {
      assert.equal(command.constructor.name, 'PutCommand');
      const item = command.input.Item;
      if (store.has(item.PK)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      store.set(item.PK, item);
      return {};
    },
  };
}

describe('ingestion', () => {
  const mail = (over: Partial<PaymentMail> = {}): PaymentMail => ({ messageId: '<abc@ramp.com>', receivedAt: '2026-10-29T09:15:00Z', ...ramp, ...over });
  it('creates a candidate once per message id', async () => {
    const client = fakeClient();
    const first = await ingestPaymentMail(client as never, [mail()], [row({})]);
    assert.equal(first[0].outcome, 'created');
    assert.equal(first[0].candidate?.status, 'candidate');
    assert.equal(first[0].candidate?.id, candidateId('<abc@ramp.com>'));
    assert.equal(first[0].candidate?.receivedOn, '2026-10-29');
    const again = await ingestPaymentMail(client as never, [mail()], [row({})]);
    assert.equal(again[0].outcome, 'duplicate');
    assert.equal(client.store.size, 1);
  });
  it('records an already-paid invoice and unmatched mail without marking anything paid', async () => {
    const client = fakeClient();
    const [paid] = await ingestPaymentMail(client as never, [mail()], [row({ paymentState: 'paid' })]);
    assert.equal(paid.candidate?.status, 'already-paid');
    const [none] = await ingestPaymentMail(client as never, [mail({ messageId: '<other>' })], []);
    assert.equal(none.candidate?.status, 'unmatched');
    const [skip] = await ingestPaymentMail(client as never, [mail({ messageId: '<n>', subject: 'Newsletter', body: 'hello' })], []);
    assert.equal(skip.outcome, 'ignored');
  });
  it('marks a paid deal without a stored invoice number as an already-paid no-op', async () => {
    const client = fakeClient();
    const backfill: PaymentMail = {
      messageId: '<ramp-20261050@ramp.com>', from: 'Ramp <no-reply@ramp.com>',
      subject: 'Payment received: #202610/50',
      body: 'PhoenixData has paid invoice #202610/50. Amount: EUR 3,700.00',
      receivedAt: '2026-10-29T09:15:00Z',
    };
    const [result] = await ingestPaymentMail(client as never, [backfill], [paidRow({})]);
    assert.equal(result.outcome, 'created');
    assert.equal(result.candidate?.status, 'already-paid');
    assert.equal(result.candidate?.match?.dealId, 'deal-1');
    assert.ok((result.candidate?.match?.reasons || []).includes('already paid'));
  });
});

describe('payment-mail candidate API', () => {
  it('lists a stored candidate and requires an explicit authorized confirmation', async () => {
    const originalFlag = process.env.SPONSOR_FINANCE_ENABLED;
    process.env.SPONSOR_FINANCE_ENABLED = 'true';
    const id = candidateId('<api-candidate@example.test>');
    const item = {
      PK: `PAYMENT_MAIL#${id}`, SK: `PAYMENT_MAIL#${id}`,
      id, recordType: 'payment-mail-candidate', messageId: '<api-candidate@example.test>',
      provider: 'ramp', from: 'payments@ramp.com', subject: 'Payment received: #202610/50',
      receivedAt: '2026-10-29T09:15:00.000Z', receivedOn: '2026-10-29', invoiceNumber: '202610/50',
      amount: '1500.00', currency: 'USD', status: 'candidate',
      match: { dealId: 'deal-1', organizationName: 'PhoenixData', confidence: 'exact', reasons: ['invoice number', 'amount', 'currency'] },
      createdAt: '2026-10-29T09:15:00.000Z', updatedAt: '2026-10-29T09:15:00.000Z',
    };
    const stored = new Map<string, any>([[item.PK, item]]);
    const client = {
      send: async (command: any) => {
        const input = command.input;
        if (command.constructor.name === 'GetCommand') {
          if (input.Key.PK === 'USER#orin') return { Item: { role: 'admin', disabled: false } };
          return { Item: stored.get(input.Key.PK) };
        }
        if (command.constructor.name === 'ScanCommand') return { Items: [...stored.values()] };
        if (command.constructor.name === 'UpdateCommand') {
          const current = stored.get(input.Key.PK);
          if (!current || current.status !== input.ExpressionAttributeValues[':previous']) {
            throw Object.assign(new Error('conditional write failed'), { name: 'ConditionalCheckFailedException' });
          }
          Object.assign(current, {
            status: input.ExpressionAttributeValues[':status'],
            decidedAt: input.ExpressionAttributeValues[':now'],
            decidedBy: input.ExpressionAttributeValues[':actor'],
            updatedAt: input.ExpressionAttributeValues[':now'],
          });
          return {};
        }
        throw new Error(`Unexpected DynamoDB command ${command.constructor.name}`);
      },
    };
    const event = { headers: { 'x-user-id': 'orin' } } as never;
    try {
      const listed = await handleSponsorFinanceRoutes('/api/sponsor-crm/finance/payment-mail', 'GET', event, client as never);
      assert.equal(listed?.statusCode, 200);
      assert.equal(JSON.parse(String(listed?.body)).items[0].id, id);

      const confirmed = await handleSponsorFinanceRoutes(`/api/sponsor-crm/finance/payment-mail/${id}/confirmed`, 'POST', event, client as never);
      assert.equal(confirmed?.statusCode, 200);
      assert.equal(JSON.parse(String(confirmed?.body)).status, 'confirmed');
      assert.equal(stored.get(item.PK).decidedBy, 'orin');
    } finally {
      if (originalFlag === undefined) delete process.env.SPONSOR_FINANCE_ENABLED;
      else process.env.SPONSOR_FINANCE_ENABLED = originalFlag;
    }
  });
});

describe('mailbox poll', () => {
  it('reads mails through the Dapier token and defers without Gmail scope', async () => {
    const enc = (t: string) => Buffer.from(t).toString('base64url');
    const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    setPaymentMailPollDepsForTests({ credential: 'test-credential', fetchImpl: (async (url: string) => {
      if (url.endsWith('/api/agent/token')) return respond(200, { access_token: 'at' });
      if (url.includes('/messages?')) return respond(200, { messages: [{ id: 'm1' }] });
      return respond(200, { internalDate: String(Date.parse('2026-10-29T09:15:00Z')), payload: {
        headers: [{ name: 'From', value: ramp.from }, { name: 'Subject', value: ramp.subject }, { name: 'Message-ID', value: '<abc@ramp.com>' }],
        mimeType: 'text/html', body: { data: enc(ramp.body) },
      } });
    }) as never });
    const result = await pollPaymentMail();
    assert.equal(result.state, 'ok');
    if (result.state === 'ok') assert.equal(parsePaymentMail(result.mails[0])?.invoiceNumber, '202610/50');
    setPaymentMailPollDepsForTests({ credential: 'test-credential', fetchImpl: (async (url: string) =>
      url.endsWith('/api/agent/token') ? respond(200, { access_token: 'at' }) : respond(403, {})) as never });
    const denied = await pollPaymentMail();
    assert.equal(denied.state, 'deferred');
    setPaymentMailPollDepsForTests({});
  });
});
