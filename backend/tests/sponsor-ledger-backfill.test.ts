import { describe, it } from 'node:test';
import assert from 'node:assert';
import { deterministicCrmId, planBackfill } from '../scripts/backfill-sponsor-ledger';

const deal = (overrides: Record<string, unknown>) => ({
  key: 'synthetic-deal', title: 'Synthetic newsletter', kind: 'newsletter', productKind: 'one-off', status: 'agreed',
  agreementDate: '2026-05-01', amount: '1500', currency: 'EUR', amountEur: 1500, taxMode: 'not-applicable',
  deliverables: [{ channel: 'main', date: '2026-06-01', delivered: true, cardId: 'synthetic-card', newsletterSlotId: null }],
  invoice: { required: true, number: 'SYN/1', issuedOn: '2026-06-02', sentOn: '2026-06-02', dueOn: '2026-07-02' },
  payments: [], paymentStatus: 'overdue', waitingOn: null, nextAction: 'Chase AP', evidence: [
    { kind: 'email', account: 'ops@example.invalid', threadId: 'synthetic-thread', date: '2026-06-02T10:00:00Z', what: 'invoice sent' },
  ],
  ...overrides,
});

const ledger = {
  asOf: '2026-10-14',
  sponsors: [{
    key: 'synthetic', displayName: 'Synthetic Sponsor', domain: 'synthetic.example.invalid',
    deals: [
      deal({}),
      deal({
        key: 'synthetic-paid', amount: '2500', paymentStatus: 'paid',
        invoice: { required: true, number: null, issuedOn: null, sentOn: null, dueOn: null },
        payments: [
          { receivedOn: '2026-03-01', amount: '2468.5', currency: 'EUR', source: 'ledger', bookkeepingId: 'row-1' },
        ],
      }),
      deal({ key: 'synthetic-unknown', amount: null, paymentStatus: 'not-invoiced' }),
      deal({
        key: 'synthetic-recorded', paymentStatus: 'paid',
        payments: [{ receivedOn: '2026-09-30', amount: '1500', currency: 'EUR', source: 'bank-report', note: 'September report' }],
        waitingOn: { party: 'us', reason: 'payment-link', since: '2026-09-01' },
      }),
      deal({ key: 'synthetic-lost', status: 'lost', paymentStatus: 'void' }),
    ],
  }],
};
const snapshot = {
  companies: [{ domain: 'other.example.invalid', displayName: 'Other' }],
  people: [{ email: 'pat@synthetic.example.invalid', name: 'Pat', organizationDomain: 'synthetic.example.invalid' }],
  leads: [],
  activity: [{ organizationDomain: 'synthetic.example.invalid', threadId: 't1', direction: 'inbound', sentAt: '2026-06-01T00:00:00Z' }],
};
const bookkeeping = [{ PK: 'BOOKKEEPING#row-1', id: 'row-1', amount: '2468.5', currency: 'EUR' }];

describe('sponsor ledger backfill planner', () => {
  it('plans CRM imports and finance steps without inventing money', () => {
    const plan = planBackfill({ ledger: ledger as never, snapshot, bookkeeping, existing: [] });
    assert.equal(plan.counts.companies, 2, 'ledger sponsors missing from the snapshot are added');
    assert.equal(plan.counts.deals, 5);
    assert.equal(plan.counts.activity, 1);
    const dealsBatch = plan.importBatches.find((batch) => batch.deals)!.deals;
    const overdue = dealsBatch.find((item: any) => item.sourceKey === 'ledger-deal:synthetic-deal');
    assert.equal(overdue.nextAction.type, 'chase_payment');
    assert.deepEqual(overdue.deliverables[0], {
      channel: 'main', plannedPublicationDate: '2026-06-01', publishedAt: '2026-06-01T12:00:00Z',
      cardId: 'synthetic-card', sourceKey: 'ledger-deal:synthetic-deal:deliverable:0',
    });
    assert.equal(dealsBatch.find((item: any) => item.sourceKey === 'ledger-deal:synthetic-paid').nextAction, undefined);

    const byKey = new Map(plan.deals.map((item) => [item.dealKey, item]));
    const first = byKey.get('synthetic-deal')!;
    assert.equal(first.dealId, deterministicCrmId('deal', 'ledger-deal:synthetic-deal'));
    assert.deepEqual(first.steps.map((step) => step.op), ['classify', 'issue', 'follow-through']);
    assert.deepEqual((first.steps[1] as any).body, { invoiceNumber: 'SYN/1', issuedOn: '2026-06-02', dueOn: '2026-07-02', sentOn: '2026-06-02' });

    const paid = byKey.get('synthetic-paid')!;
    assert.deepEqual((paid.steps[0] as any).body.amountDue, '2468.5', 'small fee shortfalls settle at the received total');
    assert.deepEqual((paid.steps[1] as any), { op: 'issue', inferred: true, body: { issuedOn: '2026-03-01', dueOn: '2026-03-01' } });
    assert.deepEqual(paid.steps[2], { op: 'link-payment', bookkeepingId: 'row-1', amount: '2468.5', receivedOn: '2026-03-01' });

    assert.deepEqual(byKey.get('synthetic-unknown')!.steps, []);
    assert.match(byKey.get('synthetic-unknown')!.issues[0], /amount unknown/);
    const recorded = byKey.get('synthetic-recorded')!;
    assert.deepEqual(recorded.steps.find((step) => step.op === 'record-payment'), {
      op: 'record-payment',
      body: { receivedOn: '2026-09-30', amount: '1500', currency: 'EUR', method: 'bank-report', reference: 'September report' },
    });
    assert.deepEqual(byKey.get('synthetic-lost')!.steps, []);
  });

  it('skips ledger payments the bookkeeping dump does not confirm', () => {
    const plan = planBackfill({ ledger: ledger as never, snapshot, bookkeeping: [], existing: [] });
    const paid = plan.deals.find((item) => item.dealKey === 'synthetic-paid')!;
    assert.equal(paid.steps.some((step) => step.op === 'link-payment'), false);
    assert.match(paid.issues.join(' '), /missing or different/);
  });
});
