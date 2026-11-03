import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createDocumentLink, putBookkeepingItem } from '../src/db/bookkeeping';
import { saveStatement } from '../src/reconcile/service';
import { buildMonth, closeMonth, ledgerRowsFrom, monthPackage } from '../src/reconcile/monthService';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';

describe('reconciliation ledger projection', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('preserves stored classification and EUR conversion details', () => {
    const [row] = ledgerRowsFrom([{
      id: 'tx-1', amount: '10.00', currency: 'USD', entryType: 'expense', paidDate: '2026-10-23',
      category: 'Tools', subtype: 'Subscription', amountEur: '9.25', rateSource: 'ECB 23 Oct 2026',
    }], []);
    assert.equal(row.category, 'Tools');
    assert.equal(row.subtype, 'Subscription');
    assert.equal(row.amountEur, '-9.25');
    assert.equal(row.rateSource, 'ECB 23 Oct 2026');
  });

  it('includes ordinary Compliance & Taxes service invoices in the accountant CSV and package while excluding true taxes', async () => {
    const period = '2026-10';
    const serviceInvoiceDoc = (await putBookkeepingItem(client, 'document', {
      documentType: 'invoice',
      status: 'active',
      contentType: 'application/pdf',
      originalFilename: 'synthetic-advisory-invoice.pdf',
      byteSize: 128,
      sha256: 'a'.repeat(64),
      s3Key: 'documents/synthetic-advisory-invoice.pdf',
    })).item;
    const taxNoticeDoc = (await putBookkeepingItem(client, 'document', {
      documentType: 'other-evidence',
      status: 'active',
      contentType: 'application/pdf',
      originalFilename: 'synthetic-tax-notice.pdf',
      byteSize: 128,
      sha256: 'b'.repeat(64),
      s3Key: 'documents/synthetic-tax-notice.pdf',
    })).item;

    const serviceTx = (await putBookkeepingItem(client, 'bookkeeping', {
      transactionDate: '2026-10-07',
      paidDate: '2026-10-08',
      counterparty: 'Synthetic Advisory GmbH',
      description: 'Monthly compliance service fee',
      amount: '238.00',
      currency: 'EUR',
      entryType: 'expense',
      category: 'Compliance & Taxes',
      subtype: 'Services',
      invoiceNumber: 'SYN-2026-10',
      sourceType: 'invoice',
    })).item;
    await createDocumentLink(client, {
      documentId: serviceInvoiceDoc.id,
      transactionId: serviceTx.id,
      coverageType: 'evidence',
    });

    const exactTaxTx = (await putBookkeepingItem(client, 'bookkeeping', {
      transactionDate: '2026-10-15',
      paidDate: '2026-10-15',
      counterparty: 'Finanzamt Example',
      description: 'Prepayment Q4',
      amount: '1500.00',
      currency: 'EUR',
      entryType: 'expense',
      category: 'Taxes',
      sourceType: 'manual',
    })).item;
    await createDocumentLink(client, {
      documentId: taxNoticeDoc.id,
      transactionId: exactTaxTx.id,
      coverageType: 'evidence',
    });

    await saveStatement(client, {
      accountId: 'finom',
      period,
      filename: 'finom-2026-10.pdf',
      documentId: 'stmt-doc-2026-10',
      rows: [
        { date: '2026-10-08', amount: '-238.00', currency: 'EUR', counterparty: 'Synthetic Advisory GmbH', reference: 'SYN-2026-10' },
        { date: '2026-10-15', amount: '-1500.00', currency: 'EUR', counterparty: 'Finanzamt Example', reference: 'Steuer Q4' },
        { date: '2026-10-18', amount: '-540.00', currency: 'EUR', counterparty: 'Techniker Krankenkasse', reference: 'TK 10/2026' },
      ],
    });

    const view = await buildMonth(client, period);
    const serviceRow = view.rows.find((row) => row.ledger?.id === serviceTx.id);
    assert.ok(serviceRow);
    assert.equal(serviceRow.tax, false);
    assert.equal(serviceRow.status, 'matched');
    assert.equal(serviceRow.ledger?.category, 'Compliance & Taxes');

    const finanzamtRow = view.rows.find((row) => row.counterparty === 'Finanzamt Example');
    const tkRow = view.rows.find((row) => row.counterparty === 'Techniker Krankenkasse');
    assert.equal(finanzamtRow?.tax, true);
    assert.equal(tkRow?.tax, true);

    await closeMonth(client, period, 'tester');
    const pack = await monthPackage(client, period);
    assert.equal(pack.draft, false);
    assert.match(pack.csv, /Synthetic Advisory GmbH/);
    assert.match(pack.csv, /Compliance & Taxes/);
    assert.doesNotMatch(pack.csv, /Finanzamt Example/);
    assert.doesNotMatch(pack.csv, /Techniker Krankenkasse/);

    const invoiceEntries = pack.entries.filter((entry) => entry.kind === 'invoice');
    assert.equal(invoiceEntries.length, 1);
    assert.equal(invoiceEntries[0].documentId, serviceInvoiceDoc.id);
    assert.match(invoiceEntries[0].path, /^2026-10\/expenses\/2026-10-08_synthetic-advisory-gmbh_SYN-2026-10_238\.00EUR\.pdf$/);
    assert.ok(!pack.entries.some((entry) => entry.documentId === taxNoticeDoc.id));
  });
});
