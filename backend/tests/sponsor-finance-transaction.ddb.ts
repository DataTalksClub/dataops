// Run only through scripts/test-sponsor-finance-transaction.sh against DynamoDB Local.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { createTables, TABLE_BOOKKEEPING, TABLE_SPONSOR_CRM, TABLE_USERS } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import {
  classifyFinance,
  linkInvoice,
  linkPayment,
  listFinanceCandidates,
  listFinanceHistory,
  projectFinance,
  recordInvoiceRequest,
  unlinkFinanceSource,
  voidFinance,
} from '../src/sponsorFinance/repository';
import {
  berlinDate,
  claimKey,
  financeKey,
  invoiceIdentity,
  MAX_PAYMENT_LINK_TRANSACTION_ACTIONS,
  paymentIdentity,
} from '../src/sponsorFinance/core';
import {
  addDocumentReportReference,
  createDocumentLink,
  deleteBookkeepingItem,
  deleteDocumentLink,
  deleteRunOwnedLink,
  markDocumentCleanupRequired,
  markDocumentRollbackDeleting,
  putBookkeepingItem,
  removeDocumentReportReference,
  removePendingDocumentClaim,
  removeRollbackDocument,
  renewDocumentPrepareLease,
  updateBookkeepingTransaction,
} from '../src/db/bookkeeping';
import { evaluateSponsorFinanceAlerts } from '../src/sponsorFinance/alerts';

const key = (prefix: string, id: string) => ({ PK: `${prefix}#${id}`, SK: `${prefix}#${id}` });
const put = (client: DynamoDBDocumentClient, table: string, item: Record<string, unknown>) =>
  client.send(new PutCommand({ TableName: table, Item: item }));
const idem = (label: string) => `${label.replace(/[^A-Za-z0-9_-]/g, '-')}-0123456789abcdef`;

describe('sponsor finance production DynamoDB transactions', () => {
  let client: DynamoDBDocumentClient;
  const bookingId = 'booking-finance-1';
  const adminId = 'finance-admin-1';

  async function bootstrapPayable(label: string, amountDue = '100') {
    const id = `booking-${label}`;
    await put(client, TABLE_SPONSOR_CRM, {
      ...key('BOOKING', id), id, version: 1, status: 'confirmed', active: true,
      organizationId: `organization-${label}`,
    });
    const classified = await classifyFinance(client, {
      actorId: adminId, bookingId: id, bookingVersion: 1,
      idempotencyKey: idem(`${label}-classify`),
      body: { invoiceRequirement: 'required', amountDue, currency: 'EUR', taxMode: 'included' },
    });
    const requested = await recordInvoiceRequest(client, {
      actorId: adminId, bookingId: id, bookingVersion: 1,
      expectedVersion: classified.financeVersion, idempotencyKey: idem(`${label}-request`),
    });
    const invoice = {
      ...key('DOCUMENT', `invoice-${label}`), id: `invoice-${label}`,
      documentType: 'invoice', status: 'active', sha256: 'b'.repeat(64),
      objectVersionId: `version-${label}`, verifiedByteSize: 800,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await put(client, TABLE_BOOKKEEPING, invoice);
    const linked = await linkInvoice(client, {
      actorId: adminId, bookingId: id, bookingVersion: 1,
      expectedVersion: requested.financeVersion, sourceId: invoice.id,
      identityToken: invoiceIdentity(invoice), issuedOn: berlinDate(), dueOn: '2099-12-31',
      idempotencyKey: idem(`${label}-invoice`),
    });
    return { bookingId: id, version: linked.financeVersion };
  }

  function payment(label: string, amount = '1') {
    return {
      ...key('BOOKKEEPING', `payment-${label}`), id: `payment-${label}`,
      amount, currency: 'EUR', paidDate: '2026-08-01',
      createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z',
    };
  }

  before(async () => {
    assert.ok(process.env.DYNAMODB_ENDPOINT, 'focused harness requires real DynamoDB Local');
    client = await getClient();
    await createTables(client);
    await Promise.all([
      put(client, TABLE_USERS, { ...key('USER', adminId), id: adminId, role: 'admin', disabled: false }),
      put(client, TABLE_USERS, { ...key('USER', 'finance-operator-1'), id: 'finance-operator-1', role: 'operator', disabled: false }),
      put(client, TABLE_SPONSOR_CRM, {
        ...key('BOOKING', bookingId),
        id: bookingId,
        version: 1,
        status: 'confirmed',
        active: true,
        organizationId: 'organization-finance-1',
      }),
    ]);
  });

  after(() => {
    delete process.env.SPONSOR_FINANCE_ENABLED;
  });

  it('runs the exact lifecycle, protects claimed sources, and returns strict DTOs', async () => {
    const classifyInput = {
      actorId: adminId,
      bookingId,
      bookingVersion: 1,
      idempotencyKey: idem('classify'),
      body: {
        invoiceRequirement: 'required',
        amountDue: '100.0000',
        currency: 'EUR',
        taxMode: 'included',
        taxAmount: '19',
        requestBy: '2026-07-01',
        expectedInvoiceBy: '2026-07-15',
      },
    };
    const classified = await classifyFinance(client, classifyInput);
    assert.equal(classified.financeVersion, 1);
    const replayedClassification = await classifyFinance(client, classifyInput);
    assert.equal(replayedClassification.financeVersion, 1);
    assert.equal(replayedClassification.outcome, 'replayed');
    await assert.rejects(() => classifyFinance(client, {
      ...classifyInput,
      body: { ...classifyInput.body, amountDue: '101' },
    }));
    const requested = await recordInvoiceRequest(client, {
      actorId: adminId,
      bookingId,
      bookingVersion: 1,
      expectedVersion: 1,
      idempotencyKey: idem('request'),
    });
    const invoice = {
      ...key('DOCUMENT', 'invoice-finance-1'),
      id: 'invoice-finance-1',
      documentType: 'invoice',
      status: 'active',
      sha256: 'a'.repeat(64),
      objectVersionId: 'synthetic-version-1',
      verifiedByteSize: 1234,
      originalFilename: 'private-canary-invoice.pdf',
      s3Key: 'private/canary/invoice.pdf',
      createdAt: '2026-07-30T10:00:00.000Z',
      updatedAt: '2026-07-30T10:00:00.000Z',
    };
    await put(client, TABLE_BOOKKEEPING, invoice);
    const invoiceLinked = await linkInvoice(client, {
      actorId: adminId,
      bookingId,
      bookingVersion: 1,
      expectedVersion: requested.financeVersion,
      sourceId: String(invoice.id),
      identityToken: invoiceIdentity(invoice),
      issuedOn: berlinDate(),
      dueOn: '2099-12-31',
      idempotencyKey: idem('invoice'),
    });
    const payments = [
      { id: 'payment-finance-a', amount: '10.1', paidDate: '2026-07-30' },
      { id: 'payment-finance-b', amount: '89.9000', paidDate: '2026-07-31' },
    ].map((payment) => ({
      ...key('BOOKKEEPING', payment.id),
      ...payment,
      currency: 'EUR',
      description: 'private-canary-counterparty-description',
      counterparty: 'private-canary-counterparty',
      createdAt: '2026-07-30T11:00:00.000Z',
      updatedAt: '2026-07-30T11:00:00.000Z',
    }));
    for (const payment of payments) await put(client, TABLE_BOOKKEEPING, payment);
    const candidates = await listFinanceCandidates(client, { kind: 'transaction', currency: 'EUR', limit: 25 });
    assert.deepEqual(
      Object.keys(candidates.items.find((item) => item.id === payments[0].id)!).sort(),
      ['amount', 'currency', 'effectiveDate', 'id', 'identityToken'],
    );
    assert.equal(JSON.stringify(candidates).includes('private-canary'), false);
    let version = invoiceLinked.financeVersion;
    for (const payment of payments) {
      const result = await linkPayment(client, {
        actorId: adminId,
        bookingId,
        bookingVersion: 1,
        expectedVersion: version,
        sourceId: String(payment.id),
        identityToken: paymentIdentity(payment),
        idempotencyKey: idem(`link-${payment.id}`),
      });
      version = result.financeVersion;
    }
    const projection = await projectFinance(client, bookingId, 'operator');
    assert.equal(projection.paymentState, 'paid');
    assert.equal(projection.outstanding, '0');
    assert.equal(projection.reconciliationStatus, 'coherent');
    assert.equal(JSON.stringify(projection).includes('private-canary'), false);
    const history = await listFinanceHistory(client, bookingId);
    assert.ok(history.length >= 5);
    assert.equal(JSON.stringify(history).includes('100.0000'), false);
    assert.equal(JSON.stringify(history).includes('private-canary'), false);
    await assert.rejects(() => updateBookkeepingTransaction(
      client,
      String(payments[0].id),
      String(payments[0].updatedAt),
      { ...payments[0], amount: '10.2' },
    ));
    await assert.rejects(() => deleteBookkeepingItem(client, 'bookkeeping', String(payments[0].id)));
    const unlinked = await unlinkFinanceSource(client, {
      actorId: adminId,
      bookingId,
      bookingVersion: 1,
      expectedVersion: version,
      kind: 'transaction',
      sourceId: String(payments[0].id),
      idempotencyKey: idem('unlink-payment'),
    });
    assert.equal(unlinked.financeVersion, version + 1);
    const updated = await updateBookkeepingTransaction(
      client,
      String(payments[0].id),
      String(payments[0].updatedAt),
      { ...payments[0], amount: '10.2' },
    );
    assert.equal(updated?.amount, '10.2');
  });

  it('makes 25 claim attempts converge on one atomic effect and one reverse claim', async () => {
    const source = {
      ...key('BOOKKEEPING', 'payment-race-1'),
      id: 'payment-race-1',
      amount: '1',
      currency: 'EUR',
      paidDate: '2026-08-01',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    await put(client, TABLE_BOOKKEEPING, source);
    const beforeProjection = await projectFinance(client, bookingId, 'admin');
    let transactionArrivals = 0;
    let releaseTransactions!: () => void;
    const transactionGate = new Promise<void>((resolve) => { releaseTransactions = resolve; });
    const simultaneousClient = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'TransactWriteCommand') {
          transactionArrivals++;
          if (transactionArrivals === 27) releaseTransactions();
          await transactionGate;
        }
        return client.send(command as never);
      },
    } as DynamoDBDocumentClient;
    const attempts = await Promise.allSettled([
      ...Array.from({ length: 25 }, (_, index) => linkPayment(simultaneousClient, {
        actorId: adminId,
        bookingId,
        bookingVersion: 1,
        expectedVersion: beforeProjection.finance!.version,
        sourceId: String(source.id),
        identityToken: paymentIdentity(source),
        idempotencyKey: idem(`race-${index}`),
      })),
      updateBookkeepingTransaction(simultaneousClient, String(source.id), String(source.updatedAt), {
        ...source, amount: '1.1',
      }),
      deleteBookkeepingItem(simultaneousClient, 'bookkeeping', String(source.id)),
    ]);
    assert.equal(transactionArrivals, 27);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    const claim = (await client.send(new GetCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: key('SPONSOR_FINANCE_CLAIM#transaction', String(source.id)),
      ConsistentRead: true,
    }))).Item;
    const links = (await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      ConsistentRead: true,
      FilterExpression: 'recordType = :type AND sourceId = :source',
      ExpressionAttributeValues: { ':type': 'sponsor-finance-link', ':source': source.id },
    }))).Items || [];
    assert.ok(links.length === 0 || links.length === 1);
    if (links.length === 1) {
      assert.ok(claim);
      assert.equal(attempts[25].status, 'rejected');
      assert.equal(attempts[26].status, 'rejected');
      const receipts = (await client.send(new ScanCommand({
        TableName: TABLE_SPONSOR_CRM,
        FilterExpression: 'recordType = :type AND recordId = :record',
        ExpressionAttributeValues: { ':type': 'sponsor-finance-receipt', ':record': links[0].id },
      }))).Items || [];
      assert.equal(receipts.length, 1);
      assert.equal(claim.PK, claimKey('transaction', String(source.id)));
    } else {
      assert.equal(claim, undefined);
      assert.ok(attempts[25].status === 'fulfilled' || attempts[26].status === 'fulfilled');
      const afterProjection = await projectFinance(client, bookingId, 'operator');
      assert.equal(afterProjection.paymentLinkCount, beforeProjection.paymentLinkCount);
      assert.equal(afterProjection.reconciliationStatus, 'coherent');
    }
  });

  it('creates deterministic private finance alerts without commercial metadata', async () => {
    const first = await evaluateSponsorFinanceAlerts(client, '2100-01-01');
    const second = await evaluateSponsorFinanceAlerts(client, '2100-01-01');
    assert.ok(first.created >= 1);
    assert.equal(second.created, 0);
    const notifications = (await client.send(new ScanCommand({
      TableName: process.env.DATAOPS_NOTIFICATIONS_TABLE || 'Notifications',
    }))).Items || [];
    const financeAlerts = notifications.filter((item) => item.type === 'sponsor-finance');
    assert.ok(financeAlerts.length >= 1);
    for (const alert of financeAlerts) {
      assert.deepEqual(Object.keys(alert.metadata).sort(), [
        'financeBasisDate',
        'financeBookingId',
        'financeFingerprint',
        'financeRule',
        'route',
      ]);
      assert.equal(JSON.stringify(alert).includes('EUR'), false);
      assert.equal(JSON.stringify(alert).includes('100.0000'), false);
    }
  });

  it('respects alert dismissal, resolution, and later Berlin-date recurrence', async () => {
    const alertBooking = 'booking-alert-recurrence';
    await put(client, TABLE_SPONSOR_CRM, {
      ...key('BOOKING', alertBooking), id: alertBooking, version: 1,
      status: 'confirmed', active: true, organizationId: 'organization-alert-recurrence',
    });
    const classification = {
      actorId: adminId, bookingId: alertBooking, bookingVersion: 1,
      idempotencyKey: idem('alert-recurrence-classify'),
      body: {
        invoiceRequirement: 'required', amountDue: '1', currency: 'EUR',
        taxMode: 'included', requestBy: '2026-01-01',
      },
    };
    await classifyFinance(client, classification);
    const paginationRows = Array.from({ length: 300 }, (_, index) => ({
      PutRequest: {
        Item: {
          ...key('BOOKING', `inactive-alert-page-${index}`),
          id: `inactive-alert-page-${index}`, version: 1, status: 'cancelled',
          active: false, padding: 'x'.repeat(4_000),
        },
      },
    }));
    for (let offset = 0; offset < paginationRows.length; offset += 25) {
      await client.send(new BatchWriteCommand({
        RequestItems: { [TABLE_SPONSOR_CRM]: paginationRows.slice(offset, offset + 25) },
      }));
    }
    let sponsorScanPages = 0;
    const countingClient = {
      send: async (command: { constructor: { name: string }; input?: { TableName?: string } }) => {
        if (command.constructor.name === 'ScanCommand' && command.input?.TableName === TABLE_SPONSOR_CRM) {
          sponsorScanPages++;
        }
        return client.send(command as never);
      },
    } as DynamoDBDocumentClient;
    const concurrentInitial = await Promise.all(
      Array.from({ length: 8 }, () => evaluateSponsorFinanceAlerts(countingClient, '2026-01-02')),
    );
    assert.equal(concurrentInitial.reduce((sum, result) => sum + result.created, 0), 1);
    assert.ok(sponsorScanPages > concurrentInitial.length);
    const findAlerts = async () => ((await client.send(new ScanCommand({
      TableName: process.env.DATAOPS_NOTIFICATIONS_TABLE || 'Notifications',
    }))).Items || []).filter((item) =>
      item.type === 'sponsor-finance' && item.metadata?.financeBookingId === alertBooking);
    let alerts = await findAlerts();
    assert.equal(alerts.length, 1);
    await client.send(new UpdateCommand({
      TableName: process.env.DATAOPS_NOTIFICATIONS_TABLE || 'Notifications',
      Key: { PK: alerts[0].PK, SK: alerts[0].SK },
      UpdateExpression: 'SET dismissed = :true',
      ExpressionAttributeValues: { ':true': true },
    }));
    await Promise.all(Array.from({ length: 4 }, () =>
      evaluateSponsorFinanceAlerts(client, '2026-01-02')));
    alerts = await findAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].dismissed, true);
    const concurrentResolution = await Promise.all(Array.from({ length: 4 }, () =>
      evaluateSponsorFinanceAlerts(client, '2025-12-31')));
    assert.equal(concurrentResolution.reduce((sum, result) => sum + result.resolved, 0), 1);
    alerts = await findAlerts();
    assert.ok(alerts[0].resolvedAt);
    await classifyFinance(client, {
      ...classification,
      expectedVersion: 1,
      idempotencyKey: idem('alert-recurrence-reclassify'),
    });
    const concurrentRecurrence = await Promise.all(Array.from({ length: 4 }, () =>
      evaluateSponsorFinanceAlerts(client, '2026-01-02')));
    assert.equal(concurrentRecurrence.reduce((sum, result) => sum + result.created, 0), 1);
    alerts = await findAlerts();
    assert.equal(alerts.length, 2);
    assert.equal(new Set(alerts.map((item) => item.metadata.financeFingerprint)).size, 2);
  });

  it('fails locked for orphan claims and complete tuple/source drift', async () => {
    const orphanBooking = 'booking-orphan-graph';
    await put(client, TABLE_SPONSOR_CRM, {
      ...key('BOOKING', orphanBooking), id: orphanBooking, version: 1,
      status: 'confirmed', active: true, organizationId: 'organization-orphan',
    });
    const orphanId = 'payment-orphan-graph';
    await put(client, TABLE_BOOKKEEPING, {
      ...key('SPONSOR_FINANCE_CLAIM#transaction', orphanId),
      recordType: 'sponsor-finance-claim', kind: 'transaction', sourceId: orphanId,
      bookingId: orphanBooking, linkId: 'missing-link', identityToken: 'missing-identity',
    });
    const orphanProjection = await projectFinance(client, orphanBooking, 'operator');
    assert.equal(orphanProjection.reconciliationStatus, 'reconciliation-required');
    assert.equal(orphanProjection.paymentState, 'reconciliation-required');
    await client.send(new DeleteCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: key('SPONSOR_FINANCE_CLAIM#transaction', orphanId),
    }));

    const setup = await bootstrapPayable('source-drift', '10');
    const source = payment('source-drift', '5');
    await put(client, TABLE_BOOKKEEPING, source);
    await linkPayment(client, {
      actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
      expectedVersion: setup.version, sourceId: source.id, identityToken: paymentIdentity(source),
      idempotencyKey: idem('source-drift-link'),
    });
    await put(client, TABLE_BOOKKEEPING, { ...source, amount: '6', updatedAt: '2026-08-02T10:00:00.000Z' });
    const drifted = await projectFinance(client, setup.bookingId, 'operator');
    assert.equal(drifted.reconciliationStatus, 'reconciliation-required');
    assert.equal(drifted.paymentState, 'reconciliation-required');
    assert.deepEqual(drifted.payments, []);
  });

  it('retries a changing discovery graph and returns a safe conflict without a partial projection', async () => {
    const changingBooking = 'booking-changing-discovery';
    await put(client, TABLE_SPONSOR_CRM, {
      ...key('BOOKING', changingBooking), id: changingBooking, version: 1,
      status: 'confirmed', active: true, organizationId: 'organization-changing',
    });
    await classifyFinance(client, {
      actorId: adminId, bookingId: changingBooking, bookingVersion: 1,
      idempotencyKey: idem('changing-discovery-classify'),
      body: { invoiceRequirement: 'not-required' },
    });
    let changes = 0;
    const changingClient = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'TransactGetCommand') {
          const stateKey = key('SPONSOR_FINANCE', changingBooking);
          const current = (await client.send(new GetCommand({
            TableName: TABLE_SPONSOR_CRM, Key: stateKey, ConsistentRead: true,
          }))).Item!;
          changes++;
          await put(client, TABLE_SPONSOR_CRM, {
            ...current, version: Number(current.version) + 1,
            updatedAt: new Date(Date.now() + changes).toISOString(),
          });
        }
        return client.send(command as never);
      },
    } as DynamoDBDocumentClient;
    await assert.rejects(
      () => projectFinance(changingClient, changingBooking, 'operator'),
      (error: Error & { statusCode?: number }) => error.statusCode === 409,
    );
    assert.equal(changes, 3);
    assert.equal(financeKey(changingBooking), `SPONSOR_FINANCE#${changingBooking}`);
  });

  it('condition-checks every existing source and claim tuple in the payment write race', async () => {
    const setup = await bootstrapPayable('tuple-race', '10');
    const first = payment('tuple-race-first', '2');
    const second = payment('tuple-race-second', '2');
    await put(client, TABLE_BOOKKEEPING, first);
    await put(client, TABLE_BOOKKEEPING, second);
    const linked = await linkPayment(client, {
      actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
      expectedVersion: setup.version, sourceId: first.id, identityToken: paymentIdentity(first),
      idempotencyKey: idem('tuple-race-first-link'),
    });
    let changed = false;
    const racingClient = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'TransactWriteCommand' && !changed) {
          changed = true;
          await put(client, TABLE_BOOKKEEPING, {
            ...first, amount: '3', updatedAt: '2026-08-03T10:00:00.000Z',
          });
        }
        return client.send(command as never);
      },
    } as DynamoDBDocumentClient;
    await assert.rejects(() => linkPayment(racingClient, {
      actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
      expectedVersion: linked.financeVersion, sourceId: second.id, identityToken: paymentIdentity(second),
      idempotencyKey: idem('tuple-race-second-link'),
    }));
    const projection = await projectFinance(client, setup.bookingId, 'operator');
    assert.equal(projection.reconciliationStatus, 'reconciliation-required');
    assert.equal(projection.paymentLinkCount, 1);
  });

  it('recovers a committed lost response from the durable receipt with the same key', async () => {
    const setup = await bootstrapPayable('lost-response', '10');
    const source = payment('lost-response', '1');
    await put(client, TABLE_BOOKKEEPING, source);
    let lost = false;
    const lostResponseClient = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'TransactWriteCommand' && !lost) {
          lost = true;
          await client.send(command as never);
          throw Object.assign(new Error('synthetic lost response'), { name: 'TimeoutError' });
        }
        return client.send(command as never);
      },
    } as DynamoDBDocumentClient;
    const recovered = await linkPayment(lostResponseClient, {
      actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
      expectedVersion: setup.version, sourceId: source.id, identityToken: paymentIdentity(source),
      idempotencyKey: idem('lost-response-link'),
    });
    assert.equal(recovered.outcome, 'replayed');
    const replay = await linkPayment(client, {
      actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
      expectedVersion: setup.version, sourceId: source.id, identityToken: paymentIdentity(source),
      idempotencyKey: idem('lost-response-link'),
    });
    assert.equal(replay.outcome, 'replayed');
    assert.equal((await projectFinance(client, setup.bookingId, 'operator')).paymentLinkCount, 1);
  });

  it('keeps an in-progress outcome unknown and safely recovers with the same key', async () => {
    const setup = await bootstrapPayable('in-progress-retry', '10');
    const source = payment('in-progress-retry', '1');
    await put(client, TABLE_BOOKKEEPING, source);
    let interrupted = false;
    const inProgressClient = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'TransactWriteCommand' && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error('synthetic processing'), { name: 'TransactionInProgressException' });
        }
        return client.send(command as never);
      },
    } as DynamoDBDocumentClient;
    const input = {
      actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
      expectedVersion: setup.version, sourceId: source.id, identityToken: paymentIdentity(source),
      idempotencyKey: idem('in-progress-retry-link'),
    };
    await assert.rejects(
      () => linkPayment(inProgressClient, input),
      (error: Error & { statusCode?: number; outcome?: string }) =>
        error.statusCode === 503 && error.outcome === 'outcome_unknown',
    );
    const recovered = await linkPayment(client, input);
    assert.equal(recovered.financeVersion, setup.version + 1);
    assert.equal((await projectFinance(client, setup.bookingId, 'operator')).paymentLinkCount, 1);
  });

  it('fails atomic writes after admin revocation or booking cancellation', async () => {
    const revoked = await bootstrapPayable('admin-revoked', '10');
    const revokedSource = payment('admin-revoked', '1');
    await put(client, TABLE_BOOKKEEPING, revokedSource);
    await put(client, TABLE_USERS, { ...key('USER', adminId), id: adminId, role: 'operator', disabled: true });
    await assert.rejects(() => linkPayment(client, {
      actorId: adminId, bookingId: revoked.bookingId, bookingVersion: 1,
      expectedVersion: revoked.version, sourceId: revokedSource.id, identityToken: paymentIdentity(revokedSource),
      idempotencyKey: idem('admin-revoked-link'),
    }));
    await put(client, TABLE_USERS, { ...key('USER', adminId), id: adminId, role: 'admin', disabled: false });

    const cancelled = await bootstrapPayable('booking-cancelled', '10');
    const cancelledSource = payment('booking-cancelled', '1');
    await put(client, TABLE_BOOKKEEPING, cancelledSource);
    await put(client, TABLE_SPONSOR_CRM, {
      ...key('BOOKING', cancelled.bookingId), id: cancelled.bookingId, version: 2,
      status: 'cancelled', active: true, organizationId: 'organization-cancelled',
    });
    await assert.rejects(() => linkPayment(client, {
      actorId: adminId, bookingId: cancelled.bookingId, bookingVersion: 1,
      expectedVersion: cancelled.version, sourceId: cancelledSource.id,
      identityToken: paymentIdentity(cancelledSource), idempotencyKey: idem('booking-cancelled-link'),
    }));
  });

  it('races admin disable and booking cancellation against every finance write without partial state', async () => {
    let sequence = 0;
    const createBooking = async (label: string) => {
      const id = `booking-write-race-${label}-${sequence++}`;
      await put(client, TABLE_SPONSOR_CRM, {
        ...key('BOOKING', id), id, version: 1, status: 'confirmed',
        active: true, organizationId: `organization-${label}`,
      });
      return id;
    };
    const factories: Array<{
      name: string;
      prepare: (label: string) => Promise<{
        bookingId: string;
        invoke: (racingClient: DynamoDBDocumentClient) => Promise<unknown>;
      }>;
    }> = [
      {
        name: 'classify',
        prepare: async (label) => {
          const id = await createBooking(label);
          return {
            bookingId: id,
            invoke: (racingClient) => classifyFinance(racingClient, {
              actorId: adminId, bookingId: id, bookingVersion: 1,
              idempotencyKey: idem(`${label}-classify`),
              body: { invoiceRequirement: 'not-required' },
            }),
          };
        },
      },
      {
        name: 'request',
        prepare: async (label) => {
          const id = await createBooking(label);
          const classified = await classifyFinance(client, {
            actorId: adminId, bookingId: id, bookingVersion: 1,
            idempotencyKey: idem(`${label}-classify`),
            body: { invoiceRequirement: 'required', amountDue: '10', currency: 'EUR', taxMode: 'included' },
          });
          return {
            bookingId: id,
            invoke: (racingClient) => recordInvoiceRequest(racingClient, {
              actorId: adminId, bookingId: id, bookingVersion: 1,
              expectedVersion: classified.financeVersion,
              idempotencyKey: idem(`${label}-request`),
            }),
          };
        },
      },
      {
        name: 'link-invoice',
        prepare: async (label) => {
          const id = await createBooking(label);
          const classified = await classifyFinance(client, {
            actorId: adminId, bookingId: id, bookingVersion: 1,
            idempotencyKey: idem(`${label}-classify`),
            body: { invoiceRequirement: 'required', amountDue: '10', currency: 'EUR', taxMode: 'included' },
          });
          const requested = await recordInvoiceRequest(client, {
            actorId: adminId, bookingId: id, bookingVersion: 1,
            expectedVersion: classified.financeVersion, idempotencyKey: idem(`${label}-request`),
          });
          const invoice = {
            ...key('DOCUMENT', `invoice-${label}`), id: `invoice-${label}`,
            documentType: 'invoice', status: 'active', sha256: 'c'.repeat(64),
            objectVersionId: `version-${label}`, verifiedByteSize: 900,
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          };
          await put(client, TABLE_BOOKKEEPING, invoice);
          return {
            bookingId: id,
            invoke: (racingClient) => linkInvoice(racingClient, {
              actorId: adminId, bookingId: id, bookingVersion: 1,
              expectedVersion: requested.financeVersion, sourceId: invoice.id,
              identityToken: invoiceIdentity(invoice), issuedOn: berlinDate(), dueOn: '2099-12-31',
              idempotencyKey: idem(`${label}-invoice`),
            }),
          };
        },
      },
      {
        name: 'link-payment',
        prepare: async (label) => {
          const setup = await bootstrapPayable(label, '10');
          const source = payment(label, '1');
          await put(client, TABLE_BOOKKEEPING, source);
          return {
            bookingId: setup.bookingId,
            invoke: (racingClient) => linkPayment(racingClient, {
              actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
              expectedVersion: setup.version, sourceId: source.id, identityToken: paymentIdentity(source),
              idempotencyKey: idem(`${label}-payment`),
            }),
          };
        },
      },
      {
        name: 'unlink-payment',
        prepare: async (label) => {
          const setup = await bootstrapPayable(label, '10');
          const source = payment(label, '1');
          await put(client, TABLE_BOOKKEEPING, source);
          const linked = await linkPayment(client, {
            actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
            expectedVersion: setup.version, sourceId: source.id, identityToken: paymentIdentity(source),
            idempotencyKey: idem(`${label}-payment`),
          });
          return {
            bookingId: setup.bookingId,
            invoke: (racingClient) => unlinkFinanceSource(racingClient, {
              actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
              expectedVersion: linked.financeVersion, kind: 'transaction', sourceId: source.id,
              idempotencyKey: idem(`${label}-unlink`),
            }),
          };
        },
      },
      {
        name: 'unlink-invoice',
        prepare: async (label) => {
          const setup = await bootstrapPayable(label, '10');
          return {
            bookingId: setup.bookingId,
            invoke: (racingClient) => unlinkFinanceSource(racingClient, {
              actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
              expectedVersion: setup.version, kind: 'document', sourceId: `invoice-${label}`,
              idempotencyKey: idem(`${label}-unlink-invoice`),
            }),
          };
        },
      },
      {
        name: 'void',
        prepare: async (label) => {
          const id = await createBooking(label);
          const classified = await classifyFinance(client, {
            actorId: adminId, bookingId: id, bookingVersion: 1,
            idempotencyKey: idem(`${label}-classify`),
            body: { invoiceRequirement: 'not-required' },
          });
          return {
            bookingId: id,
            invoke: (racingClient) => voidFinance(racingClient, {
              actorId: adminId, bookingId: id, bookingVersion: 1,
              expectedVersion: classified.financeVersion,
              idempotencyKey: idem(`${label}-void`),
            }),
          };
        },
      },
    ];

    for (const boundary of ['admin-disable', 'booking-cancel'] as const) {
      for (const factory of factories) {
        await put(client, TABLE_USERS, {
          ...key('USER', adminId), id: adminId, role: 'admin', disabled: false,
        });
        const label = `${boundary}-${factory.name}`;
        const prepared = await factory.prepare(label);
        let raced = false;
        const racingClient = {
          send: async (command: { constructor: { name: string } }) => {
            if (command.constructor.name !== 'TransactWriteCommand' || raced) {
              return client.send(command as never);
            }
            raced = true;
            const boundaryWrite = boundary === 'admin-disable'
              ? put(client, TABLE_USERS, {
                ...key('USER', adminId), id: adminId, role: 'operator', disabled: true,
              })
              : put(client, TABLE_SPONSOR_CRM, {
                ...key('BOOKING', prepared.bookingId), id: prepared.bookingId,
                version: 2, status: 'cancelled', active: true,
                organizationId: `organization-${label}`,
              });
            const [transaction] = await Promise.allSettled([
              client.send(command as never),
              boundaryWrite,
            ]);
            if (transaction.status === 'rejected') throw transaction.reason;
            return transaction.value;
          },
        } as DynamoDBDocumentClient;
        await Promise.allSettled([prepared.invoke(racingClient)]);
        assert.equal(raced, true);
        const state = (await client.send(new GetCommand({
          TableName: TABLE_SPONSOR_CRM,
          Key: key('SPONSOR_FINANCE', prepared.bookingId),
          ConsistentRead: true,
        }))).Item;
        if (state) {
          const listedIds = [
            ...(state.invoiceLinkId ? [String(state.invoiceLinkId)] : []),
            ...((state.paymentLinkIds || []) as string[]),
          ];
          for (const id of listedIds) {
            const parts = id.split('#');
            const kind = parts.at(-2) as 'document' | 'transaction';
            const sourceId = String(parts.at(-1));
            const [link, claim] = await Promise.all([
              client.send(new GetCommand({
                TableName: TABLE_SPONSOR_CRM, Key: { PK: id, SK: id }, ConsistentRead: true,
              })),
              client.send(new GetCommand({
                TableName: TABLE_BOOKKEEPING,
                Key: key(`SPONSOR_FINANCE_CLAIM#${kind}`, sourceId),
                ConsistentRead: true,
              })),
            ]);
            assert.equal(Boolean(link.Item), Boolean(claim.Item), `${label} link/claim parity`);
          }
        }
      }
    }
    await put(client, TABLE_USERS, {
      ...key('USER', adminId), id: adminId, role: 'admin', disabled: false,
    });
  });

  it('guards every document cleanup, rollback, link, report, delete, and duplicate path', async () => {
    const runId = 'guard-matrix-run';
    const owner = 'guard-matrix-owner';
    const hashFor = (index: number) => index.toString(16).padStart(64, '0');
    const makeDocument = async (
      label: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const id = `invoice-guard-${label}`;
      const document = Object.fromEntries(Object.entries({
        ...key('DOCUMENT', id), id, documentType: 'invoice', status: 'active',
        sha256: hashFor(id.length), declaredSha256: hashFor(id.length),
        objectVersionId: `version-${label}`, verifiedByteSize: 900,
        creatorIdempotencyKey: owner, createdByRunId: runId,
        uploadAuthorizationExpiresAt: '2020-01-01T00:00:00.000Z',
        linkRefCount: 0, reportRefCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
      }).filter(([, value]) => value !== undefined));
      await put(client, TABLE_BOOKKEEPING, document);
      await put(client, TABLE_BOOKKEEPING, {
        ...key('SPONSOR_FINANCE_CLAIM#document', id),
        recordType: 'sponsor-finance-claim', kind: 'document', sourceId: id,
        bookingId: `booking-${label}`, linkId: `finance-link-${label}`,
        identityToken: `identity-${label}`,
      });
      return document;
    };
    const unchanged = async (document: Record<string, unknown>, action: () => Promise<unknown>) => {
      await assert.rejects(action);
      const current = (await client.send(new GetCommand({
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: document.PK, SK: document.SK },
        ConsistentRead: true,
      }))).Item;
      assert.deepEqual(current, document);
    };

    const deleteDoc = await makeDocument('delete');
    await unchanged(deleteDoc, () => deleteBookkeepingItem(client, 'document', String(deleteDoc.id)));

    const cleanup = await makeDocument('cleanup', { status: 'pending', objectVersionId: undefined });
    await unchanged(cleanup, () => markDocumentCleanupRequired(client, String(cleanup.id), owner, runId));

    const lease = await makeDocument('lease', { status: 'pending', objectVersionId: undefined });
    await put(client, TABLE_BOOKKEEPING, {
      ...key('DOCUMENT_HASH', String(lease.declaredSha256)),
      documentId: lease.id, state: 'pending', creatorIdempotencyKey: owner, createdByRunId: runId,
    });
    await unchanged(lease, () => renewDocumentPrepareLease(
      client, String(lease.id), String(lease.declaredSha256), owner, runId,
      '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
    ));

    const pending = await makeDocument('pending-remove', { status: 'pending', objectVersionId: undefined });
    await put(client, TABLE_BOOKKEEPING, {
      ...key('DOCUMENT_HASH', String(pending.declaredSha256)),
      documentId: pending.id, state: 'pending', creatorIdempotencyKey: owner, createdByRunId: runId,
    });
    await unchanged(pending, () => removePendingDocumentClaim(
      client, String(pending.id), String(pending.declaredSha256), owner, runId,
    ));

    const rollback = await makeDocument('rollback');
    await unchanged(rollback, () => markDocumentRollbackDeleting(client, String(rollback.id), runId));

    const rollbackDelete = await makeDocument('rollback-delete', { status: 'rollback-deleting' });
    await put(client, TABLE_BOOKKEEPING, {
      ...key('DOCUMENT_HASH', String(rollbackDelete.sha256)),
      documentId: rollbackDelete.id, state: 'active', createdByRunId: runId,
    });
    await unchanged(rollbackDelete, () => removeRollbackDocument(
      client, String(rollbackDelete.id), String(rollbackDelete.sha256), runId,
    ));

    const linkCreate = await makeDocument('link-create');
    const linkTransaction = payment('guard-link-create', '1');
    await put(client, TABLE_BOOKKEEPING, linkTransaction);
    await unchanged(linkCreate, () => createDocumentLink(client, {
      documentId: String(linkCreate.id), transactionId: String(linkTransaction.id),
      coverageType: 'invoice',
    }));

    for (const kind of ['ordinary', 'run-owned'] as const) {
      const document = await makeDocument(`link-delete-${kind}`, { linkRefCount: 1 });
      const link = {
        ...key('LINK', `guard-${kind}`), id: `guard-${kind}`,
        documentId: document.id, transactionId: `transaction-${kind}`,
        coverageType: 'invoice', createdByRunId: runId,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await put(client, TABLE_BOOKKEEPING, link);
      await unchanged(document, () => kind === 'ordinary'
        ? deleteDocumentLink(client, link as never)
        : deleteRunOwnedLink(client, link as never, runId));
      assert.ok((await client.send(new GetCommand({
        TableName: TABLE_BOOKKEEPING, Key: { PK: link.PK, SK: link.SK },
      }))).Item);
    }

    const reportAdd = await makeDocument('report-add');
    await unchanged(reportAdd, () => addDocumentReportReference(client, String(reportAdd.id), 'report-add'));

    const reportRemove = await makeDocument('report-remove', { reportRefCount: 1 });
    const reportGuard = `DOCUMENT_REPORT_REF#${reportRemove.id}#report-remove`;
    await put(client, TABLE_BOOKKEEPING, {
      PK: reportGuard, SK: reportGuard, documentId: reportRemove.id, reportId: 'report-remove',
    });
    await unchanged(reportRemove, () => removeDocumentReportReference(
      client, String(reportRemove.id), 'report-remove',
    ));
    assert.ok((await client.send(new GetCommand({
      TableName: TABLE_BOOKKEEPING, Key: { PK: reportGuard, SK: reportGuard },
    }))).Item);

    const unique = 'guarded-ingestion-duplicate';
    const first = await putBookkeepingItem(client, 'document', {
      status: 'active', documentType: 'invoice', marker: 'original',
    }, unique);
    await put(client, TABLE_BOOKKEEPING, {
      ...key('SPONSOR_FINANCE_CLAIM#document', first.item.id),
      recordType: 'sponsor-finance-claim', kind: 'document', sourceId: first.item.id,
      bookingId: 'booking-duplicate', linkId: 'link-duplicate', identityToken: 'identity-duplicate',
    });
    const duplicate = await putBookkeepingItem(client, 'document', {
      status: 'active', documentType: 'invoice', marker: 'changed',
    }, unique);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.item.marker, 'original');
  });

  it('keeps candidate pages globally ordered without duplicates', async () => {
    const ids = Array.from({ length: 31 }, (_, index) => `candidate-page-${String(30 - index).padStart(2, '0')}`);
    for (const id of ids) await put(client, TABLE_BOOKKEEPING, payment(id, '1'));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listFinanceCandidates(client, {
        kind: 'transaction', currency: 'EUR', limit: 7, cursor,
      });
      seen.push(...page.items.filter((item) => String(item.id).startsWith('payment-candidate-page-')).map((item) => String(item.id)));
      cursor = page.nextCursor || undefined;
    } while (cursor);
    const expected = ids.map((id) => `payment-${id}`).sort();
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, seen.length);
  });

  it('cancels every real 46-action payment transaction position without partial effects', async () => {
    const setup = await bootstrapPayable('link-cap', '20');
    let version = setup.version;
    for (let index = 0; index < 19; index++) {
      const source = payment(`link-cap-${index}`, '1');
      await put(client, TABLE_BOOKKEEPING, source);
      const linked = await linkPayment(client, {
        actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
        expectedVersion: version, sourceId: source.id, identityToken: paymentIdentity(source),
        idempotencyKey: idem(`link-cap-${index}`),
      });
      version = linked.financeVersion;
    }
    const twentieth = payment('link-cap-19', '1');
    await put(client, TABLE_BOOKKEEPING, twentieth);
    const actionPositions = [
      'current administrator',
      'current booking',
      ...Array.from({ length: 19 }, (_, index) => [
        `existing payment ${index + 1} source identity`,
        `existing payment ${index + 1} reverse claim`,
      ]).flat(),
      'prospective payment source identity',
      'prospective reverse claim uniqueness',
      'prospective sponsor-finance link uniqueness',
      'finance version and payment-link list',
      'idempotency receipt uniqueness',
      'history event uniqueness',
    ];
    assert.equal(actionPositions.length, MAX_PAYMENT_LINK_TRANSACTION_ACTIONS);

    for (let cancellationIndex = 0; cancellationIndex < actionPositions.length; cancellationIndex++) {
      let actionCount = 0;
      let rawCancellation: (Error & {
        CancellationReasons?: Array<{ Code?: string }>;
      }) | undefined;
      let beforeItems: Array<Record<string, unknown> | undefined> = [];
      let actionKeys: Array<{ TableName: string; Key: { PK: string; SK: string } }> = [];
      const cancellationClient = {
        send: async (command: {
          constructor: { name: string };
          input?: { TransactItems?: Array<Record<string, any>> };
        }) => {
          if (command.constructor.name === 'TransactWriteCommand') {
            const actions = command.input?.TransactItems || [];
            actionCount = actions.length;
            actionKeys = actions.map((action) => {
              const operation = action.ConditionCheck || action.Put || action.Update || action.Delete;
              const item = operation.Item as Record<string, unknown> | undefined;
              const keyValue = (operation.Key || { PK: item?.PK, SK: item?.SK }) as {
                PK: string;
                SK: string;
              };
              return { TableName: String(operation.TableName), Key: keyValue };
            });
            beforeItems = await Promise.all(actionKeys.map(async ({ TableName, Key }) =>
              (await client.send(new GetCommand({
                TableName, Key, ConsistentRead: true,
              }))).Item));
            const targetAction = actions[cancellationIndex];
            const targetOperation = targetAction.ConditionCheck
              || targetAction.Put
              || targetAction.Update
              || targetAction.Delete;
            const target = actionKeys[cancellationIndex];
            const targetBefore = beforeItems[cancellationIndex];
            if (targetAction.Put) {
              assert.equal(targetBefore, undefined, `${actionPositions[cancellationIndex]} starts absent`);
              await put(client, target.TableName, {
                ...target.Key,
                cancellationProbe: actionPositions[cancellationIndex],
              });
            } else {
              assert.ok(targetBefore, `${actionPositions[cancellationIndex]} starts present`);
              await client.send(new DeleteCommand({
                TableName: target.TableName,
                Key: target.Key,
              }));
            }
            try {
              return await client.send(command as never);
            } catch (error) {
              rawCancellation = error as typeof rawCancellation;
              throw error;
            } finally {
              if (targetBefore) {
                await put(client, target.TableName, targetBefore);
              } else {
                await client.send(new DeleteCommand({
                  TableName: target.TableName,
                  Key: target.Key,
                }));
              }
            }
          }
          return client.send(command as never);
        },
      } as DynamoDBDocumentClient;
      await assert.rejects(
        () => linkPayment(cancellationClient, {
          actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
          expectedVersion: version, sourceId: twentieth.id, identityToken: paymentIdentity(twentieth),
          idempotencyKey: idem(`link-cap-cancel-${cancellationIndex}`),
        }),
        (error: Error & { statusCode?: number }) => error.statusCode === 409,
      );
      assert.equal(actionCount, MAX_PAYMENT_LINK_TRANSACTION_ACTIONS);
      assert.equal(rawCancellation?.name, 'TransactionCanceledException');
      const codes = rawCancellation?.CancellationReasons?.map((reason) => reason.Code) || [];
      assert.equal(
        codes[cancellationIndex],
        'ConditionalCheckFailed',
        `${actionPositions[cancellationIndex]} cancels at action ${cancellationIndex}`,
      );
      assert.ok(
        codes.every((code, index) =>
          index === cancellationIndex ? code === 'ConditionalCheckFailed' : code === 'None'),
        `${actionPositions[cancellationIndex]} is the only failed action`,
      );
      const afterItems = await Promise.all(actionKeys.map(async ({ TableName, Key }) =>
        (await client.send(new GetCommand({
          TableName, Key, ConsistentRead: true,
        }))).Item));
      assert.deepEqual(
        afterItems,
        beforeItems,
        `${actionPositions[cancellationIndex]} cancellation has zero partial effects`,
      );
    }
    assert.equal((await projectFinance(client, setup.bookingId, 'operator')).paymentLinkCount, 19);
  });

  it('accepts exactly 20 payment links, rejects link 21 and prospective overpayment', async () => {
    const setup = await bootstrapPayable('link-cap-success', '20');
    let version = setup.version;
    for (let index = 0; index < 19; index++) {
      const source = payment(`link-cap-success-${index}`, '1');
      await put(client, TABLE_BOOKKEEPING, source);
      const linked = await linkPayment(client, {
        actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
        expectedVersion: version, sourceId: source.id, identityToken: paymentIdentity(source),
        idempotencyKey: idem(`link-cap-success-${index}`),
      });
      version = linked.financeVersion;
    }
    const twentieth = payment('link-cap-success-19', '1');
    await put(client, TABLE_BOOKKEEPING, twentieth);
    const twentiethLinked = await linkPayment(client, {
      actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
      expectedVersion: version, sourceId: twentieth.id, identityToken: paymentIdentity(twentieth),
      idempotencyKey: idem('link-cap-success-19'),
    });
    version = twentiethLinked.financeVersion;
    const twentyFirst = payment('link-cap-success-20', '1');
    await put(client, TABLE_BOOKKEEPING, twentyFirst);
    await assert.rejects(() => linkPayment(client, {
      actorId: adminId, bookingId: setup.bookingId, bookingVersion: 1,
      expectedVersion: version, sourceId: twentyFirst.id, identityToken: paymentIdentity(twentyFirst),
      idempotencyKey: idem('link-cap-success-20'),
    }));
    const capped = await projectFinance(client, setup.bookingId, 'operator');
    assert.equal(capped.paymentLinkCount, 20);
    assert.equal(capped.paymentState, 'paid');
    const firstLinked = payment('link-cap-success-0', '1');
    const guardedEdits = await Promise.allSettled([
      updateBookkeepingTransaction(client, firstLinked.id, firstLinked.updatedAt, {
        ...firstLinked, amount: '1.1',
      }),
      deleteBookkeepingItem(client, 'bookkeeping', firstLinked.id),
    ]);
    assert.deepEqual(guardedEdits.map((result) => result.status), ['rejected', 'rejected']);
    assert.equal((await projectFinance(client, setup.bookingId, 'operator')).paymentLinkCount, 20);

    const overpay = await bootstrapPayable('overpay', '1');
    const tooLarge = payment('overpay', '1.0001');
    await put(client, TABLE_BOOKKEEPING, tooLarge);
    await assert.rejects(() => linkPayment(client, {
      actorId: adminId, bookingId: overpay.bookingId, bookingVersion: 1,
      expectedVersion: overpay.version, sourceId: tooLarge.id, identityToken: paymentIdentity(tooLarge),
      idempotencyKey: idem('overpay-link'),
    }));
    assert.equal((await projectFinance(client, overpay.bookingId, 'operator')).paymentLinkCount, 0);
  });

  it('fails closed at the real DynamoDB 5,000-evaluated-row discovery boundary', async () => {
    const requests = Array.from({ length: 5_001 }, (_, index) => ({
      PutRequest: {
        Item: {
          ...key('BOUNDARY', `row-${String(index).padStart(5, '0')}`),
          id: `row-${index}`,
        },
      },
    }));
    for (let offset = 0; offset < requests.length; offset += 25) {
      let pending = requests.slice(offset, offset + 25);
      do {
        const result = await client.send(new BatchWriteCommand({
          RequestItems: { [TABLE_BOOKKEEPING]: pending },
        }));
        pending = result.UnprocessedItems?.[TABLE_BOOKKEEPING] || [];
      } while (pending.length);
    }
    await assert.rejects(
      () => listFinanceCandidates(client, { kind: 'transaction', currency: 'EUR', limit: 10 }),
      (error: Error & { statusCode?: number }) => error.statusCode === 503,
    );
  });
});
