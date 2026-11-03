import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createDocumentLink, getBookkeepingItem, putBookkeepingItem } from '../src/db/bookkeeping';
import { handleBookkeepingAccountantReportRoutes } from '../src/routes/bookkeepingAccountantReport';
import { createInvoice } from '../src/invoices/store';
import { TABLE_ARTIFACTS, TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { saveStatement } from '../src/reconcile/service';
import { attachProof, buildMonth, closeMonth, getConfig, ledgerRowsFrom, monthPackage, saveConfig } from '../src/reconcile/monthService';
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

  it('blocks an accountant package row without a booked EUR conversion', async () => {
    const period = '2027-06';
    await putBookkeepingItem(client, 'bookkeeping', {
      id: 'synthetic-unconverted-package-row', transactionDate: `${period}-08`, paidDate: `${period}-08`,
      counterparty: 'Synthetic USD Vendor', description: 'Unconverted service', amount: '12.00',
      currency: 'USD', entryType: 'expense',
    });
    const packageResult = await monthPackage(client, period, { draft: true });
    assert.equal(packageResult.blockers.length, 1);
    assert.deepEqual(packageResult.blockers[0], {
      rowId: 'synthetic-unconverted-package-row',
      reference: 'USD',
      reason: 'foreign-currency transaction has no booked EUR value; convert it before preparing the package',
    });
  });

  it('keeps accountant API and package CSV aligned for normalized EUR and blocks unconverted foreign currency', async () => {
    const period = '2027-02';
    const normalizedEuroRows = [
      {
        id: 'synthetic-package-missing-currency-eur', transactionDate: `${period}-08`, paidDate: `${period}-08`,
        counterparty: 'Synthetic Missing Currency Vendor', description: 'Missing currency service', amount: '10.00',
        entryType: 'expense',
      },
      {
        id: 'synthetic-package-lowercase-currency-eur', transactionDate: `${period}-09`, paidDate: `${period}-09`,
        counterparty: 'Synthetic Lowercase Currency Vendor', description: 'Lowercase currency service', amount: '20.00',
        amountEur: '19.00', currency: 'eur', entryType: 'expense',
      },
      {
        id: 'synthetic-package-padded-currency-eur', transactionDate: `${period}-10`, paidDate: `${period}-10`,
        counterparty: 'Synthetic Padded Currency Vendor', description: 'Padded currency service', amount: '30.00',
        amountEur: '29.00', currency: ' EUR ', entryType: 'expense',
      },
    ];
    for (const row of normalizedEuroRows) await putBookkeepingItem(client, 'bookkeeping', row);

    const packageResult = await monthPackage(client, period, { draft: true });
    const accountant = await handleBookkeepingAccountantReportRoutes(
      '/api/bookkeeping/reports/accountant', 'GET',
      { httpMethod: 'GET', path: '/api/bookkeeping/reports/accountant', headers: {}, queryStringParameters: { period, format: 'csv' } } as any,
      client,
    );
    assert.equal(accountant?.statusCode, 200);
    const report = JSON.parse(accountant!.body);
    assert.equal(report.count, 3);
    assert.deepEqual(packageResult.blockers, []);
    assert.equal(packageResult.csv, report.content);
    assert.match(packageResult.csv, /Synthetic Missing Currency Vendor","Missing currency service","-10\.00/);
    assert.match(packageResult.csv, /Synthetic Lowercase Currency Vendor","Lowercase currency service","-20\.00/);
    assert.match(packageResult.csv, /Synthetic Padded Currency Vendor","Padded currency service","-30\.00/);
    assert.doesNotMatch(packageResult.csv, /-19\.00|-29\.00/);

    const unconverted = await putBookkeepingItem(client, 'bookkeeping', {
      id: 'synthetic-package-unconverted-usd', transactionDate: `${period}-11`, paidDate: `${period}-11`,
      counterparty: 'Synthetic Unconverted USD Vendor', description: 'Unconverted foreign service', amount: '12.00',
      currency: 'USD', entryType: 'expense',
    });
    const blockedPackage = await monthPackage(client, period, { draft: true });
    const blockedAccountant = await handleBookkeepingAccountantReportRoutes(
      '/api/bookkeeping/reports/accountant', 'GET',
      { httpMethod: 'GET', path: '/api/bookkeeping/reports/accountant', headers: {}, queryStringParameters: { period, format: 'csv' } } as any,
      client,
    );
    assert.equal(blockedAccountant?.statusCode, 409);
    assert.deepEqual(JSON.parse(blockedAccountant!.body).unconvertedTransactionIds, [unconverted.item.id]);
    assert.deepEqual(blockedPackage.blockers.map((blocker) => blocker.rowId), [unconverted.item.id]);
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
      assert.deepEqual(incomplete.blockers.map((blocker) => blocker.rowId).sort(), [
        'ledger:synthetic-missing-invoice-ledger',
        'ledger:synthetic-mismatched-invoice-ledger',
      ].sort());
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
    assert.match(pack.csv, /Monthly compliance service fee/);
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
      assert.match(pack.csv, /Synthetic ordinary service invoice/);
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

  it('packages only selected cash rows, allocated invoice amounts, and registered proofs with proof-role precedence', async () => {
    const period = '2027-01';
    const makeDocument = async (id: string, filename: string, hash: string, type = 'invoice') => (await putBookkeepingItem(client, 'document', {
      id, documentType: type, status: 'active', contentType: 'application/pdf', originalFilename: filename,
      byteSize: 128, sha256: hash.repeat(64), s3Key: `documents/${filename}`,
    })).item;

    const allocationDocuments = [
      await makeDocument('synthetic-package-allocation-one', 'synthetic-allocation-one.pdf', '1'),
      await makeDocument('synthetic-package-allocation-two', 'synthetic-allocation-two.pdf', '2'),
      await makeDocument('synthetic-package-allocation-three', 'synthetic-allocation-three.pdf', '5'),
    ];
    const allocatedPayment = (await putBookkeepingItem(client, 'bookkeeping', {
      id: 'synthetic-package-allocated-income', transactionDate: '2026-12-30', paidDate: '2027-01-03',
      counterparty: 'Synthetic Combined Client', description: 'Combined settlement', amount: '120.00', currency: 'EUR', entryType: 'income', category: 'Consulting',
      allocations: [
        { id: 'synthetic-allocation-one', documentId: allocationDocuments[0].id, invoiceNumber: 'SYN-A', counterparty: 'Synthetic Client A', description: 'Consulting milestone', amount: '70.00', currency: 'EUR' },
        { id: 'synthetic-allocation-two', documentId: allocationDocuments[1].id, invoiceNumber: 'SYN-B', counterparty: 'Synthetic Client B', description: 'Support service', amount: '35.00', currency: 'EUR' },
        { id: 'synthetic-allocation-three', documentId: allocationDocuments[2].id, invoiceNumber: 'SYN-C', counterparty: 'Synthetic Client C', description: 'Workshop delivery', amount: '15.00', currency: 'EUR' },
      ],
    })).item;
    for (const document of allocationDocuments) {
      await createDocumentLink(client, { documentId: document.id, transactionId: String(allocatedPayment.id), coverageType: 'evidence' });
    }

    const linkedProof = await makeDocument('synthetic-package-linked-proof', 'synthetic-payment-proof-one.pdf', '3');
    const secondProof = await makeDocument('synthetic-package-second-proof', 'synthetic-payment-proof-two.pdf', '4', 'other-evidence');
    const linkedProofTransaction = (await putBookkeepingItem(client, 'bookkeeping', {
      id: 'synthetic-package-income-with-proof', transactionDate: '2027-01-05', paidDate: '2027-01-06',
      counterparty: 'Synthetic Proof Client', description: 'Proof-linked income', amount: '12.00', currency: 'EUR', entryType: 'income', category: 'Consulting',
    })).item;
    const secondProofTransaction = (await putBookkeepingItem(client, 'bookkeeping', {
      id: 'synthetic-package-proof-only-income', transactionDate: '2027-01-07', paidDate: '2027-01-08',
      counterparty: 'Synthetic Other Client', description: 'Proof-only income', amount: '8.00', currency: 'EUR', entryType: 'income', category: 'Consulting',
    })).item;
    await createDocumentLink(client, { documentId: linkedProof.id, transactionId: String(linkedProofTransaction.id), coverageType: 'evidence' });
    await attachProof(client, period, 'tester', String(linkedProofTransaction.id), linkedProof.id);
    await attachProof(client, period, 'tester', String(secondProofTransaction.id), secondProof.id);

    const unpaidDeal = 'synthetic-package-unpaid-deal';
    const crmNow = new Date().toISOString();
    await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: {
      PK: `DEAL#${unpaidDeal}`, SK: `DEAL#${unpaidDeal}`, id: unpaidDeal, name: 'Synthetic Unpaid Client', version: 1, createdAt: crmNow, updatedAt: crmNow,
    } }));
    await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: {
      PK: `SPONSOR_FINANCE#${unpaidDeal}`, SK: `SPONSOR_FINANCE#${unpaidDeal}`, id: 'synthetic-package-unpaid-invoice', dealId: unpaidDeal,
      invoiceNumber: 'SYN-UNPAID', amountDue: '88.00', currency: 'EUR', issuedOn: '2027-01-09', createdAt: crmNow, updatedAt: crmNow,
    } }));

    const nextMonth = await monthPackage(client, period, { draft: true });
    const accountant = await handleBookkeepingAccountantReportRoutes(
      '/api/bookkeeping/reports/accountant', 'GET',
      { httpMethod: 'GET', path: '/api/bookkeeping/reports/accountant', headers: {}, queryStringParameters: { period, format: 'csv' } } as any,
      client,
    );
    assert.equal(accountant?.statusCode, 200);
    assert.equal(nextMonth.csv, JSON.parse(accountant!.body).content,
      'the package CSV is exactly the native accountant report for its cash period');
    assert.match(nextMonth.csv, /Synthetic Client A/);
    assert.match(nextMonth.csv, /Consulting milestone/);
    assert.match(nextMonth.csv, /70\.00/);
    assert.match(nextMonth.csv, /Synthetic Client B/);
    assert.match(nextMonth.csv, /Support service/);
    assert.match(nextMonth.csv, /35\.00/);
    assert.match(nextMonth.csv, /Synthetic Client C/);
    assert.match(nextMonth.csv, /Workshop delivery/);
    assert.match(nextMonth.csv, /15\.00/);
    assert.doesNotMatch(nextMonth.csv, /Synthetic Combined Client|Combined settlement|Synthetic Unpaid Client/);
    assert.ok(nextMonth.entries.some((entry) => entry.documentId === allocationDocuments[0].id
      && entry.path === '2027-01/income/2027-01-03_synthetic-client-a_SYN-A_70.00EUR.pdf'));
    assert.ok(nextMonth.entries.some((entry) => entry.documentId === allocationDocuments[1].id
      && entry.path === '2027-01/income/2027-01-03_synthetic-client-b_SYN-B_35.00EUR.pdf'));
    assert.ok(nextMonth.entries.some((entry) => entry.documentId === allocationDocuments[2].id
      && entry.path === '2027-01/income/2027-01-03_synthetic-client-c_SYN-C_15.00EUR.pdf'));
    assert.equal(nextMonth.entries.filter((entry) => entry.documentId === linkedProof.id).length, 1);
    assert.ok(nextMonth.entries.some((entry) => entry.kind === 'proof' && entry.documentId === linkedProof.id
      && entry.path.startsWith('2027-01/proofs/')));
    assert.ok(nextMonth.entries.some((entry) => entry.kind === 'proof' && entry.documentId === secondProof.id
      && entry.path.startsWith('2027-01/proofs/')));
    assert.equal(nextMonth.entries.filter((entry) => entry.kind === 'proof').length, 2);

    const priorMonth = await monthPackage(client, '2026-12', { draft: true });
    assert.doesNotMatch(priorMonth.csv, /Synthetic Client A|Synthetic Client B|Synthetic Proof Client/);
    assert.ok(!priorMonth.entries.some((entry) => allocationDocuments.some((document) => entry.documentId === document.id)));
    const unchangedParent = await getBookkeepingItem(client, 'bookkeeping', String(allocatedPayment.id));
    assert.equal(unchangedParent?.amount, '120.00');
    assert.equal((unchangedParent?.allocations as unknown[]).length, 3);
  });
});
