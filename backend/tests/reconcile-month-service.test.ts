import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createDocumentLink, getBookkeepingItem, putBookkeepingItem } from '../src/db/bookkeeping';
import { createInvoice } from '../src/invoices/store';
import { TABLE_ARTIFACTS } from '../src/db/tableNames';
import { saveStatement } from '../src/reconcile/service';
import { buildMonth, closeMonth, getConfig, ledgerRowsFrom, monthPackage, saveConfig } from '../src/reconcile/monthService';
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

  it('projects a confirmed invoice intake artifact and blocks unresolved expected files in the package', async () => {
    const period = '2026-11';
    const invoiceId = 'c'.repeat(64);
    const artifactId = 'synthetic-invoice-artifact';
    const originalChecksum = 'e'.repeat(64);
    const oldBucket = process.env.EMAIL_DOCUMENTS_BUCKET;
    const oldPrefix = process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX;
    process.env.EMAIL_DOCUMENTS_BUCKET = 'synthetic-private-documents';
    process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX = 'artifacts/';
    try {
      await client.send(new PutCommand({
        TableName: TABLE_ARTIFACTS,
        Item: {
          PK: `ARTIFACT#${artifactId}`, SK: `ARTIFACT#${artifactId}`, id: artifactId,
          type: 'invoice', title: 'synthetic-source-invoice.pdf', filename: 'synthetic-source-invoice.pdf',
          contentType: 'application/pdf', checksum: `sha256:${originalChecksum}`, sizeBytes: 128, dataClass: 'sensitive', status: 'approved',
          storageUri: `s3://synthetic-private-documents/artifacts/${artifactId}.pdf`,
          metadata: { importState: 'complete' },
        },
      }));
      await createInvoice(client, {
        id: invoiceId, revision: 1, status: 'confirmed', fields: { transactionDate: '2026-11-02', paidDate: '2026-11-03', counterparty: 'Synthetic Vendor', amount: '24.00', currency: 'EUR', invoiceNumber: 'SYN-24' },
        extraction: { method: 'synthetic', evidence: [], issues: [], direction: 'expense' },
        source: { intakeItemIds: ['synthetic-intake'], artifactId, checksum: originalChecksum },
        destinations: { dropbox: { state: 'verified', operationId: 'dropbox' }, sheets: { state: 'verified', operationId: 'sheets' } },
        audit: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedRevision: 1,
      });
      const ledger = (await putBookkeepingItem(client, 'bookkeeping', {
        id: 'synthetic-invoice-ledger', transactionDate: '2026-11-02', paidDate: '2026-11-03',
        counterparty: 'Synthetic Vendor', amount: '24.00', currency: 'EUR', entryType: 'expense',
        invoiceNumber: 'SYN-24', invoiceId, documentArtifactId: artifactId, sourceType: 'invoice',
      })).item;
      const attachedCopy = (await putBookkeepingItem(client, 'document', {
        documentType: 'invoice', status: 'active', contentType: 'application/pdf',
        originalFilename: 'synthetic-attached-copy.pdf', byteSize: 128, sha256: originalChecksum,
        s3Key: 'documents/synthetic-attached-copy.pdf',
      })).item;
      const distinctEvidence = (await putBookkeepingItem(client, 'document', {
        documentType: 'other-evidence', status: 'active', contentType: 'application/pdf',
        originalFilename: 'synthetic-supporting-contract.pdf', byteSize: 256, sha256: 'f'.repeat(64),
        s3Key: 'documents/synthetic-supporting-contract.pdf',
      })).item;
      await createDocumentLink(client, { documentId: attachedCopy.id, transactionId: String(ledger.id), coverageType: 'evidence' });
      await createDocumentLink(client, { documentId: distinctEvidence.id, transactionId: String(ledger.id), coverageType: 'evidence' });
      assert.deepEqual(ledgerRowsFrom([ledger], [])[0].documents, [{ id: artifactId, invoiceId }]);
      const packageResult = await monthPackage(client, period, { draft: true });
      const entry = packageResult.entries.find((item) => item.invoiceId === invoiceId);
      assert.ok(entry);
      assert.equal(entry.kind, 'invoice');
      assert.equal(entry.originalFilename, 'synthetic-source-invoice.pdf');
      assert.equal(packageResult.entries.filter((item) => item.rowId === `ledger:${ledger.id}`).length, 2,
        'same-byte attached copy is deduplicated while distinct linked evidence remains');
      assert.ok(packageResult.entries.some((item) => item.documentId === distinctEvidence.id));
      assert.ok(!packageResult.entries.some((item) => item.documentId === attachedCopy.id));
      assert.deepEqual(packageResult.blockers, []);

      const missingLedger = (await putBookkeepingItem(client, 'bookkeeping', {
        id: 'synthetic-missing-invoice-ledger', transactionDate: '2026-11-04', paidDate: '2026-11-04',
        counterparty: 'Synthetic Missing Vendor', amount: '10.00', currency: 'EUR', entryType: 'expense',
        invoiceId: 'd'.repeat(64), documentArtifactId: 'synthetic-missing-artifact', sourceType: 'invoice',
      })).item;
      const unrelatedAttachment = (await putBookkeepingItem(client, 'document', {
        documentType: 'other-evidence', status: 'active', contentType: 'application/pdf',
        originalFilename: 'synthetic-unrelated-attachment.pdf', byteSize: 64, sha256: 'a'.repeat(64),
        s3Key: 'documents/synthetic-unrelated-attachment.pdf',
      })).item;
      await createDocumentLink(client, { documentId: unrelatedAttachment.id, transactionId: String(missingLedger.id), coverageType: 'evidence' });
      await putBookkeepingItem(client, 'bookkeeping', {
        id: 'synthetic-mismatched-invoice-ledger', transactionDate: '2026-11-05', paidDate: '2026-11-05',
        counterparty: 'Synthetic Mismatch Vendor', amount: '11.00', currency: 'EUR', entryType: 'expense',
        invoiceId, documentArtifactId: 'synthetic-unowned-artifact', sourceType: 'invoice',
      });
      const incomplete = await monthPackage(client, period, { draft: true });
      assert.equal(incomplete.blockers.length, 2);
      assert.deepEqual(incomplete.blockers.map((blocker) => blocker.rowId), [
        'ledger:synthetic-missing-invoice-ledger',
        'ledger:synthetic-mismatched-invoice-ledger',
      ]);
      assert.ok(incomplete.blockers.every((blocker) => /cannot be safely resolved/.test(blocker.reason)));
    } finally {
      if (oldBucket === undefined) delete process.env.EMAIL_DOCUMENTS_BUCKET; else process.env.EMAIL_DOCUMENTS_BUCKET = oldBucket;
      if (oldPrefix === undefined) delete process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX; else process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX = oldPrefix;
    }
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
    const ownerTransferDoc = (await putBookkeepingItem(client, 'document', {
      documentType: 'receipt', status: 'active', contentType: 'application/pdf',
      originalFilename: 'synthetic-owner-transfer.pdf', byteSize: 128,
      sha256: 'c'.repeat(64), s3Key: 'documents/synthetic-owner-transfer.pdf',
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

    const ownerTransferTx = (await putBookkeepingItem(client, 'bookkeeping', {
      transactionDate: '2026-10-19', paidDate: '2026-10-19',
      counterparty: 'Synthetic Owner', description: 'Synthetic owner draw', amount: '42.00',
      currency: 'EUR', entryType: 'expense', category: 'Owner pay', ownerPayType: 'draw',
      sourceType: 'manual',
    })).item;
    await createDocumentLink(client, {
      documentId: ownerTransferDoc.id,
      transactionId: ownerTransferTx.id,
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
        { date: '2026-10-19', amount: '-42.00', currency: 'EUR', counterparty: 'Synthetic Owner', reference: 'Synthetic private transfer' },
      ],
    });

    const view = await buildMonth(client, period);
    const serviceRow = view.rows.find((row) => row.ledger?.id === serviceTx.id);
    assert.ok(serviceRow);
    assert.equal(serviceRow.tax, false);
    assert.equal(serviceRow.status, 'matched');
    assert.equal(serviceRow.ledger?.category, 'Compliance & Taxes');

    const ownerTransferRow = view.rows.find((row) => row.ledger?.id === ownerTransferTx.id);
    assert.ok(ownerTransferRow);
    assert.equal(ownerTransferRow.ledger?.ownerPayType, 'draw');
    assert.equal(ownerTransferRow.status, 'matched');
    assert.equal(view.counters.rows, view.rows.filter((row) => !row.tax).length);
    assert.ok(view.counters.rows >= 2, 'owner draw remains in the internal month counters');

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
    assert.doesNotMatch(pack.csv, /Synthetic Owner|Owner pay/);

    const invoiceEntries = pack.entries.filter((entry) => entry.kind === 'invoice');
    assert.equal(invoiceEntries.length, 1);
    assert.equal(invoiceEntries[0].documentId, serviceInvoiceDoc.id);
    assert.match(invoiceEntries[0].path, /^2026-10\/expenses\/2026-10-08_synthetic-advisory-gmbh_SYN-2026-10_238\.00EUR\.pdf$/);
    assert.ok(!pack.entries.some((entry) => entry.documentId === taxNoticeDoc.id));
    assert.ok(!pack.entries.some((entry) => entry.documentId === ownerTransferDoc.id));
    assert.ok(await getBookkeepingItem(client, 'document', ownerTransferDoc.id), 'owner transfer source document remains stored');
    assert.ok(pack.entries.some((entry) => entry.kind === 'statement' && entry.documentId === 'stmt-doc-2026-10' && entry.originalFilename === 'finom-2026-10.pdf'), 'the original statement reference remains unchanged in the package');
  });

  it('excludes a satisfied bank-only owner withdrawal from an open-month accountant export while retaining internal rows and source statements', async () => {
    const period = '2026-12';
    const previousConfig = await getConfig(client);
    await saveConfig(client, {
      ...previousConfig,
      rules: [...previousConfig.rules, {
        id: 'synthetic-owner-withdrawal', kind: 'owner_withdrawal', direction: 'out',
        counterparty: '^Synthetic Owner$', category: 'Owner pay',
      }],
    }, 'tester');
    try {
      const serviceInvoice = (await putBookkeepingItem(client, 'document', {
        documentType: 'invoice', status: 'active', contentType: 'application/pdf',
        originalFilename: 'synthetic-ilz-service-invoice.pdf', byteSize: 128,
        sha256: 'd'.repeat(64), s3Key: 'documents/synthetic-ilz-service-invoice.pdf',
      })).item;
      const serviceTx = (await putBookkeepingItem(client, 'bookkeeping', {
        id: 'synthetic-ilz-service-ledger', transactionDate: '2026-12-04', paidDate: '2026-12-05',
        counterparty: 'Synthetic ILZ Services', description: 'Synthetic ordinary service invoice',
        amount: '35.00', currency: 'EUR', entryType: 'expense', category: 'Compliance & Taxes',
        subtype: 'Services', invoiceNumber: 'SYN-ILZ-12', sourceType: 'invoice',
      })).item;
      await createDocumentLink(client, {
        documentId: serviceInvoice.id, transactionId: String(serviceTx.id), coverageType: 'evidence',
      });
      await saveStatement(client, {
        accountId: 'finom', period, filename: 'synthetic-original-statement.pdf', documentId: 'synthetic-original-statement',
        rows: [
          { date: '2026-12-03', amount: '-42.00', currency: 'EUR', counterparty: 'Synthetic Owner', reference: 'Synthetic private transfer' },
          { date: '2026-12-05', amount: '-35.00', currency: 'EUR', counterparty: 'Synthetic ILZ Services', reference: 'SYN-ILZ-12' },
        ],
      });

      const view = await buildMonth(client, period);
      assert.equal(view.state, 'open');
      assert.equal(view.exceptionConfirmation, undefined);
      const ownerRow = view.rows.find((row) => row.counterparty === 'Synthetic Owner');
      assert.ok(ownerRow);
      assert.equal(ownerRow.ledger, undefined);
      assert.deepEqual([ownerRow.exception?.kind, ownerRow.exception?.satisfied], ['owner_withdrawal', true]);
      assert.equal(view.counters.rows, 2);
      assert.equal(view.counters.exceptions, 1);

      const pack = await monthPackage(client, period, { draft: true });
      assert.equal(pack.state, 'open');
      assert.equal(pack.draft, true);
      assert.equal(pack.csv.includes('Synthetic Owner'), false);
      assert.match(pack.csv, /Synthetic ILZ Services/);
      assert.match(pack.csv, /Compliance & Taxes/);
      assert.ok(pack.entries.some((entry) => entry.documentId === serviceInvoice.id));
      assert.ok(pack.entries.some((entry) => entry.kind === 'statement'
        && entry.documentId === 'synthetic-original-statement'
        && entry.originalFilename === 'synthetic-original-statement.pdf'));
      assert.equal(view.rows.includes(ownerRow), true, 'the internal reconciliation row remains visible');
      assert.equal(view.counters.rows, 2, 'month counters continue to include the owner transfer');
    } finally {
      await saveConfig(client, previousConfig, 'tester');
    }
  });

  it('allocates one bank payment (420.84 EUR) across three invoice rows and three PDFs in the accountant package while preserving one bank/ledger pair', async () => {
    const period = '2026-09';
    const doc399 = (await putBookkeepingItem(client, 'document', {
      documentType: 'invoice',
      status: 'active',
      contentType: 'application/pdf',
      originalFilename: 'compute-399.pdf',
      byteSize: 128,
      sha256: '1'.repeat(64),
      s3Key: 'documents/compute-399.pdf',
    })).item;
    const doc1499 = (await putBookkeepingItem(client, 'document', {
      documentType: 'invoice',
      status: 'active',
      contentType: 'application/pdf',
      originalFilename: 'domain-1499.pdf',
      byteSize: 128,
      sha256: '2'.repeat(64),
      s3Key: 'documents/domain-1499.pdf',
    })).item;
    const doc685 = (await putBookkeepingItem(client, 'document', {
      documentType: 'invoice',
      status: 'active',
      contentType: 'application/pdf',
      originalFilename: 'mail-685.pdf',
      byteSize: 128,
      sha256: '3'.repeat(64),
      s3Key: 'documents/mail-685.pdf',
    })).item;

    const bundledPayment = (await putBookkeepingItem(client, 'bookkeeping', {
      transactionDate: '2026-09-18',
      paidDate: '2026-09-18',
      counterparty: 'Synthetic Card Settlement',
      description: 'Combined invoice settlement',
      amount: '420.84',
      currency: 'EUR',
      entryType: 'expense',
      category: 'Tools',
      sourceType: 'statement',
      allocations: [
        {
          id: 'alloc-1',
          documentId: doc399.id,
          invoiceNumber: 'INV-399',
          counterparty: 'Synthetic Compute GmbH',
          counterpartyCanonical: 'Synthetic Compute GmbH',
          description: 'Dedicated cluster September',
          amount: '399.00',
          currency: 'EUR',
          category: 'Infrastructure',
          transactionDate: '2026-09-15',
        },
        {
          id: 'alloc-2',
          documentId: doc1499.id,
          invoiceNumber: 'INV-1499',
          counterparty: 'Synthetic Domains Ltd',
          counterpartyCanonical: 'Synthetic Domains Ltd',
          description: 'Domain renewal',
          amount: '14.99',
          currency: 'EUR',
          category: 'Domains',
          transactionDate: '2026-09-16',
        },
        {
          id: 'alloc-3',
          documentId: doc685.id,
          invoiceNumber: 'INV-685',
          counterparty: 'Synthetic Mail B.V.',
          counterpartyCanonical: 'Synthetic Mail B.V.',
          description: 'Transactional email usage',
          amount: '6.85',
          currency: 'EUR',
          category: 'Tools',
          transactionDate: '2026-09-17',
        },
      ],
    })).item;

    for (const doc of [doc399, doc1499, doc685]) {
      await createDocumentLink(client, {
        documentId: doc.id,
        transactionId: bundledPayment.id,
        coverageType: 'evidence',
      });
    }

    await saveStatement(client, {
      accountId: 'finom',
      period,
      filename: 'finom-2026-09.pdf',
      documentId: 'stmt-doc-2026-09',
      rows: [
        {
          date: '2026-09-18',
          amount: '-420.84',
          currency: 'EUR',
          counterparty: 'Synthetic Card Settlement',
          reference: 'BATCH-42084',
        },
      ],
    });

    const view = await buildMonth(client, period);
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].status, 'matched');
    assert.equal(view.rows[0].amount, '-420.84');
    assert.equal(view.rows[0].ledger?.id, bundledPayment.id);
    assert.equal(view.rows[0].ledger?.allocations?.length, 3);
    assert.equal(view.statements.length, 1);

    await closeMonth(client, period, 'tester');
    const pack = await monthPackage(client, period);
    assert.equal(pack.draft, false);
    assert.deepEqual(pack.blockers, []);

    const invoiceEntries = pack.entries.filter((entry) => entry.kind === 'invoice');
    assert.equal(invoiceEntries.length, 3);
    assert.deepEqual(
      invoiceEntries.map((entry) => entry.documentId),
      [doc399.id, doc1499.id, doc685.id],
    );
    assert.deepEqual(
      invoiceEntries.map((entry) => entry.path),
      [
        '2026-09/expenses/2026-09-15_synthetic-compute-gmbh_INV-399_399.00EUR.pdf',
        '2026-09/expenses/2026-09-16_synthetic-domains-ltd_INV-1499_14.99EUR.pdf',
        '2026-09/expenses/2026-09-17_synthetic-mail-b-v_INV-685_6.85EUR.pdf',
      ],
    );

    const csvLines = pack.csv.trim().split('\n');
    assert.equal(csvLines.length, 4);
    assert.match(csvLines[1], /Synthetic Compute GmbH,Dedicated cluster September,-399\.00,EUR,finom,2026-09-18,-420\.84 EUR,BATCH-42084/);
    assert.match(csvLines[2], /Synthetic Domains Ltd,Domain renewal,-14\.99,EUR,finom,2026-09-18,-420\.84 EUR,BATCH-42084/);
    assert.match(csvLines[3], /Synthetic Mail B\.V\.,Transactional email usage,-6\.85,EUR,finom,2026-09-18,-420\.84 EUR,BATCH-42084/);
  });
});
