import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createDocumentLink, getBookkeepingItem, putBookkeepingItem } from '../src/db/bookkeeping';
import { handleBookkeepingAccountantReportRoutes } from '../src/routes/bookkeepingAccountantReport';
import { createInvoice } from '../src/invoices/store';
import { TABLE_ARTIFACTS, TABLE_SPONSOR_CRM, TABLE_BOOKKEEPING } from '../src/db/tableNames';
import { saveStatement } from '../src/reconcile/service';
import { attachProof, buildMonth, setInvoiceDisposition, setException, pairRows, MonthGateError, closeMonth, getConfig, ledgerRowsFrom, monthPackage, saveConfig } from '../src/reconcile/monthService';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';

describe('reconciliation ledger projection', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });

  async function verifiedPayment(id: string, period: string, invoice = true) {
    const document = (await putBookkeepingItem(client, 'document', {
      id: `proof-${id}`, documentType: 'other-evidence', status: 'active', contentType: 'application/pdf',
      originalFilename: `proof-${id}.pdf`, byteSize: 128, sha256: '9'.repeat(64), s3Key: `documents/proof-${id}.pdf`,
    })).item;
    if (invoice) await createDocumentLink(client, { documentId: document.id, transactionId: id, coverageType: 'evidence' });
    await attachProof(client, period, 'synthetic-operator', id, document.id);
  }

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
    await verifiedPayment("synthetic-unconverted-package-row", period);
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
    for (const row of normalizedEuroRows) { await putBookkeepingItem(client, 'bookkeeping', row); await verifiedPayment(row.id, period); }

    const packageResult = await monthPackage(client, period, { draft: true });
    const accountant = await handleBookkeepingAccountantReportRoutes(
      '/api/bookkeeping/reports/accountant', 'GET',
      { httpMethod: 'GET', path: '/api/bookkeeping/reports/accountant', headers: {}, queryStringParameters: { period: period, format: 'csv' } } as any,
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
    await verifiedPayment(String(unconverted.item.id), period);
    const blockedPackage = await monthPackage(client, period, { draft: true });
    const blockedAccountant = await handleBookkeepingAccountantReportRoutes(
      '/api/bookkeeping/reports/accountant', 'GET',
      { httpMethod: 'GET', path: '/api/bookkeeping/reports/accountant', headers: {}, queryStringParameters: { period: period, format: 'csv' } } as any,
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
      await attachProof(client, period, "synthetic-operator", String(ledger.id), distinctEvidence.id);
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
      await attachProof(client, period, "synthetic-operator", String(missingLedger.id), unrelatedAttachment.id);
      await attachProof(client, period, "synthetic-operator", "synthetic-mismatched-invoice-ledger", unrelatedAttachment.id);
      await assert.rejects(() => monthPackage(client, period, { draft: true }), (error: any) => {
        assert.ok(error instanceof MonthGateError);
        assert.deepEqual(error.blockers.map((blocker: any) => blocker.rowId).sort(), [
          'ledger:synthetic-missing-invoice-ledger', 'ledger:synthetic-mismatched-invoice-ledger',
        ].sort());
        assert.ok(error.blockers.every((blocker: any) => /missing or inactive/.test(blocker.reason)));
        return true;
      });
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
    assert.match(invoiceEntries[0].path, /^2026-10\/expenses\/2026-10-08_synthetic-advisory-gmbh_monthly-compliance-service-fee_238\.00EUR\.pdf$/);
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
      await setException(client, period, "synthetic-operator", ownerRow.id, "owner_withdrawal", "Owner pay");

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

    const allocatedProof = await makeDocument('synthetic-package-allocated-proof', 'synthetic-parent-proof.pdf', '6', 'other-evidence');
    await attachProof(client, '2027-01', 'synthetic-operator', String(allocatedPayment.id), String(allocatedProof.id));
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
    await createDocumentLink(client, { documentId: secondProof.id, transactionId: String(secondProofTransaction.id), coverageType: 'evidence' });
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

    await assert.rejects(() => monthPackage(client, period, { draft: true }), MonthGateError);
    let unresolved = await buildMonth(client, period);
    const unpaidRow = unresolved.rows.find((row) => row.ledger?.id === unpaidDeal)!;
    const { paymentRowDigest } = await import('../src/finance/accountantReadiness');
    await setInvoiceDisposition(client, period, 'synthetic-operator', {
      rowId: unpaidRow.id, kind: 'verified-unpaid', reason: 'Invoice remains outstanding', evidence: 'Synthetic operator checked receivable register',
      rowDigest: paymentRowDigest(unpaidRow, period), version: unresolved.version,
    });
    const nextMonth = await monthPackage(client, period, { draft: true });
    const accountant = await handleBookkeepingAccountantReportRoutes(
      '/api/bookkeeping/reports/accountant', 'GET',
      { httpMethod: 'GET', path: '/api/bookkeeping/reports/accountant', headers: {}, queryStringParameters: { period: period, format: 'csv' } } as any,
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
      && entry.path === '2027-01/income/2027-01-03_synthetic-client-a_consulting-milestone_70.00EUR.pdf'));
    assert.ok(nextMonth.entries.some((entry) => entry.documentId === allocationDocuments[1].id
      && entry.path === '2027-01/income/2027-01-03_synthetic-client-b_support-service_35.00EUR.pdf'));
    assert.ok(nextMonth.entries.some((entry) => entry.documentId === allocationDocuments[2].id
      && entry.path === '2027-01/income/2027-01-03_synthetic-client-c_workshop-delivery_15.00EUR.pdf'));
    assert.equal(nextMonth.entries.filter((entry) => entry.documentId === linkedProof.id).length, 1);
    assert.ok(nextMonth.entries.some((entry) => entry.kind === 'proof' && entry.documentId === linkedProof.id
      && entry.path === '2027-01/proofs/2027-01-06_synthetic-proof-client_payment-proof-proof-linked-income_12.00EUR.pdf'));
    assert.ok(nextMonth.entries.some((entry) => entry.kind === 'proof' && entry.documentId === secondProof.id
      && entry.path === '2027-01/proofs/2027-01-08_synthetic-other-client_payment-proof-proof-only-income_8.00EUR.pdf'));
    assert.ok(nextMonth.entries.some((entry) => entry.kind === 'proof' && entry.documentId === allocatedProof.id
      && entry.path === '2027-01/proofs/2027-01-03_synthetic-combined-client_payment-proof-combined-settlement_120.00EUR.pdf'));
    assert.equal(nextMonth.entries.filter((entry) => entry.kind === 'proof').length, 3);

    const priorMonth = await monthPackage(client, '2026-12', { draft: true });
    assert.doesNotMatch(priorMonth.csv, /Synthetic Client A|Synthetic Client B|Synthetic Proof Client/);
    assert.ok(!priorMonth.entries.some((entry) => allocationDocuments.some((document) => entry.documentId === document.id)));
    const unchangedParent = await getBookkeepingItem(client, 'bookkeeping', String(allocatedPayment.id));
    assert.equal(unchangedParent?.amount, '120.00');
    assert.equal((unchangedParent?.allocations as unknown[]).length, 3);
  });
  it('requires an explicit report month and blocks invoice-only attribution for CSV/TSV and draft ZIP until an audited decision', async () => {
    const period = '2030-04';
    const dealId = 'synthetic-readiness-receivable';
    const now = new Date().toISOString();
    await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: {
      PK: `DEAL#${dealId}`, SK: `DEAL#${dealId}`, id: dealId, name: 'Invented Readiness Client', version: 1, createdAt: now, updatedAt: now,
    } }));
    const finance = { PK: `SPONSOR_FINANCE#${dealId}`, SK: `SPONSOR_FINANCE#${dealId}`, id: 'synthetic-readiness-invoice', dealId,
      invoiceNumber: 'INVENTED-RECEIVABLE', amountDue: '73.00', currency: 'EUR', issuedOn: `${period}-09`, createdAt: now, updatedAt: now };
    await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: finance }));
    const report = (lens: string, format = 'csv') => handleBookkeepingAccountantReportRoutes('/api/bookkeeping/reports/accountant', 'GET', {
      httpMethod: 'GET', path: '/api/bookkeeping/reports/accountant', headers: {}, queryStringParameters: { period: lens, format },
    } as any, client);
    for (const lens of ['2030', 'all', '']) assert.equal((await report(lens))?.statusCode, 400);
    for (const lens of [period]) for (const format of ['csv', 'tsv']) {
      const result = await report(lens, format);
      assert.equal(result?.statusCode, 409);
      assert.ok(JSON.parse(result!.body).blockers.some((row: any) => row.rowId === `ledger:${dealId}` && row.status === 'needs-attribution'));
      assert.equal(JSON.parse(result!.body).content, undefined);
    }
    await assert.rejects(() => monthPackage(client, period, { draft: true }), MonthGateError);
    await assert.rejects(() => monthPackage(client, period), MonthGateError);
    const view = await buildMonth(client, period);
    const row = view.rows.find((row) => row.ledger?.id === dealId)!;
    const { paymentRowDigest } = await import('../src/finance/accountantReadiness');
    const input = { rowId: row.id, kind: 'deferred', reason: 'Operator verified later settlement', evidence: 'Invented receivable confirmation reference', targetPeriod: '2030-05', rowDigest: paymentRowDigest(row, period), version: view.version };
    await assert.rejects(() => setInvoiceDisposition(client, period, 'synthetic-operator', { ...input, evidence: '' }), /reason and evidence/);
    await assert.rejects(() => setInvoiceDisposition(client, period, 'synthetic-operator', { ...input, rowDigest: 'stale' }), /changed/);
    const saved = await setInvoiceDisposition(client, period, 'synthetic-operator', input);
    assert.equal(saved.log.at(-1)?.action, 'invoice-disposition');
    await assert.rejects(() => setInvoiceDisposition(client, period, 'synthetic-operator', input), /changed/);
    assert.equal((await report(period))?.statusCode, 200);
    assert.equal(JSON.parse((await report(period))!.body).reportPeriod, period);
    const pack = await monthPackage(client, period, { draft: true });
    assert.doesNotMatch(pack.csv, /Invented Readiness Client/);
    assert.equal(pack.reportPeriod, period);
    assert.equal((await buildMonth(client, period)).reportPeriod, period);
    assert.equal((await buildMonth(client, '2030-05')).statements.length, 0, 'verified deferral does not require future bank proof');
    assert.equal((await buildMonth(client, period)).rows.find((item) => item.id === row.id)?.status, 'payment-proof-missing');
    assert.equal((await buildMonth(client, period)).invoiceDispositions[row.id].kind, 'deferred');
    await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { ...finance, amountDue: '74.00' } }));
    assert.equal((await report(period))?.statusCode, 409, 'changed source amount invalidates the decision without changing the month version');
    await assert.rejects(() => monthPackage(client, period, { draft: true }), MonthGateError);
  });

  it('does not attribute an invoice issued in month A and paid in month B to A or require a B statement for A', async () => {
    const invoiceId = '9'.repeat(64);
    await createInvoice(client, {
      id: invoiceId, revision: 1, status: 'confirmed', fields: { transactionDate: '2032-10-31', paidDate: '2032-11-02', counterparty: 'Invented Future Settlement Vendor', amount: '57.00', currency: 'EUR', invoiceNumber: 'INVENTED-FUTURE' },
      extraction: { method: 'synthetic', evidence: [], issues: [], direction: 'expense' },
      source: { intakeItemIds: ['invented-future-intake'], artifactId: 'invented-future-artifact', checksum: '7'.repeat(64) },
      destinations: { dropbox: { state: 'verified', operationId: 'dropbox' }, sheets: { state: 'verified', operationId: 'sheets' } },
      audit: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedRevision: 1,
    });
    const october = await handleBookkeepingAccountantReportRoutes('/api/bookkeeping/reports/accountant', 'GET', {
      httpMethod: 'GET', path: '/api/bookkeeping/reports/accountant', headers: {}, queryStringParameters: { period: '2032-10', format: 'csv' },
    } as any, client);
    assert.equal(october?.statusCode, 200);
    assert.equal(JSON.parse(october!.body).reportPeriod, '2032-10');
    assert.equal(JSON.parse(october!.body).count, 0);
    const pack = await monthPackage(client, '2032-10', { draft: true });
    assert.equal(pack.reportPeriod, '2032-10');
    assert.equal((await buildMonth(client, '2032-11')).statements.length, 0, 'no future-month bank statement was needed');
  });

  async function assertBothExportsBlocked(period: string, expected: RegExp) {
    const response = await handleBookkeepingAccountantReportRoutes('/api/bookkeeping/reports/accountant', 'GET', {
      httpMethod: 'GET', path: '/api/bookkeeping/reports/accountant', headers: {}, queryStringParameters: { period, format: 'csv' },
    } as any, client);
    assert.equal(response?.statusCode, 409);
    assert.match(JSON.stringify(JSON.parse(response!.body).blockers), expected);
    await assert.rejects(() => monthPackage(client, period, { draft: true }), (error: any) => {
      assert.ok(error instanceof MonthGateError);
      assert.match(JSON.stringify(error.blockers), expected);
      return true;
    });
  }

  it('blocks a matched bank-only fee omitted from the cash ledger and report', async () => {
    const period = '2033-02';
    await saveStatement(client, { accountId: 'finom', period, filename: 'invented-fee-statement.pdf', rows: [
      { date: `${period}-06`, amount: '-17.00', currency: 'EUR', counterparty: 'Finom invented account fee' },
    ] });
    const view = await buildMonth(client, period);
    assert.equal(view.rows[0].status, 'matched');
    assert.equal(view.rows[0].ledger, undefined);
    await assertBothExportsBlocked(period, /must be booked in the ledger/);
  });

  it('blocks a selected cash parent globally paired to a different month despite mismatched amount and inactive invoice evidence', async () => {
    const period = '2033-10';
    const transaction = (await putBookkeepingItem(client, 'bookkeeping', {
      id: 'invented-cross-month-cash', paidDate: `${period}-31`, transactionDate: `${period}-29`,
      counterparty: 'Invented Cross Month Service', amount: '53.00', currency: 'EUR', entryType: 'expense',
    })).item;
    const document = (await putBookkeepingItem(client, 'document', {
      id: 'invented-cross-month-receipt', documentType: 'invoice', status: 'active', contentType: 'application/pdf',
      originalFilename: 'invented-cross-month.pdf', byteSize: 10, sha256: '6'.repeat(64), s3Key: 'documents/invented-cross-month.pdf',
    })).item;
    await createDocumentLink(client, { documentId: document.id, transactionId: String(transaction.id), coverageType: 'evidence' });
    await client.send(new PutCommand({ TableName: TABLE_BOOKKEEPING, Item: { ...document, PK: `DOCUMENT#${document.id}`, SK: `DOCUMENT#${document.id}`, status: 'archived' } }));
    await saveStatement(client, { accountId: 'finom', period: '2033-11', filename: 'invented-later-statement.pdf', rows: [
      { date: '2033-11-01', amount: '-54.00', currency: 'EUR', counterparty: 'Invented Cross Month Service' },
    ] });
    const november = await buildMonth(client, '2033-11');
    const bank = november.rows.find((row) => row.bank?.counterparty === 'Invented Cross Month Service')!.bank!;
    await pairRows(client, period, 'invented-operator', bank.key, String(transaction.id));
    const october = await buildMonth(client, period);
    assert.ok(october.rows.some((row) => row.ledger?.id === transaction.id && row.bank?.date === '2033-11-01'));
    await assertBothExportsBlocked(period, /Cash-month attribution conflict/);
  });

  it('retains selected-month needsReview invoice and receipt candidates for explicit attribution without sweeping future sources', async () => {
    const period = '2034-06';
    const invoiceId = '8'.repeat(64);
    await createInvoice(client, {
      id: invoiceId, revision: 1, status: 'pending', fields: { transactionDate: `${period}-30`, counterparty: 'Invented Draft Invoice Vendor', amount: '39.00', currency: 'EUR', invoiceNumber: 'INVENTED-REVIEW' },
      extraction: { method: 'synthetic', evidence: [], issues: ['Synthetic attribution uncertainty'], needsReview: true, direction: 'expense' },
      source: { intakeItemIds: ['invented-review-intake'], artifactId: 'invented-review-artifact', checksum: '4'.repeat(64) },
      destinations: { dropbox: { state: 'verified', operationId: 'dropbox' }, sheets: { state: 'verified', operationId: 'sheets' } },
      audit: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const receipt = (await putBookkeepingItem(client, 'document', {
      id: 'invented-review-receipt', documentType: 'receipt', status: 'active', needsReview: true,
      transactionDate: `${period}-29`, counterparty: 'Invented Review Receipt Vendor', amount: '28.00', currency: 'EUR',
    })).item;
    await putBookkeepingItem(client, 'document', {
      id: 'invented-future-review-receipt', documentType: 'receipt', status: 'active', needsReview: true,
      transactionDate: '2034-07-02', counterparty: 'Invented Future Review Vendor', amount: '62.00', currency: 'EUR',
    });
    const view = await buildMonth(client, period);
    assert.equal(view.rows.length, 2);
    assert.ok(view.rows.every((row) => row.status === 'needs-review'));
    await assertBothExportsBlocked(period, /needs-attribution/);
    const { paymentRowDigest } = await import('../src/finance/accountantReadiness');
    for (const id of [invoiceId, String(receipt.id)]) {
      const current = await buildMonth(client, period);
      const row = current.rows.find((row) => row.ledger?.id === id)!;
      await setInvoiceDisposition(client, period, 'invented-operator', { rowId: row.id, kind: 'deferred',
        reason: 'Verified outside selected cash month', evidence: 'Invented later-period attribution reference', targetPeriod: '2034-07', rowDigest: paymentRowDigest(row, period), version: current.version });
    }
    const pack = await monthPackage(client, period, { draft: true });
    assert.equal(pack.csv.trim().split(/\r?\n/).length, 1);
    assert.equal((await buildMonth(client, period)).rows.length, 2, 'unresolved source facts remain visible after the attribution decision');
    assert.equal((await buildMonth(client, '2034-07')).statements.length, 0, 'future proof is not a prerequisite for selected-month attribution');
  });

  it('blocks dated review sources with invalid or missing amounts without inventing money or a cash month', async () => {
    const period = '2035-09';
    const invoiceId = '5'.repeat(64);
    await createInvoice(client, {
      id: invoiceId, revision: 1, status: 'pending', fields: { transactionDate: `${period}-19`, counterparty: 'Invented Invalid Amount Vendor', amount: 'unreadable-amount', currency: 'EUR' },
      extraction: { method: 'synthetic', evidence: [], issues: ['Amount unreadable'], needsReview: true, direction: 'expense' },
      source: { intakeItemIds: ['invented-invalid-intake'], artifactId: 'invented-invalid-artifact', checksum: '2'.repeat(64) },
      destinations: { dropbox: { state: 'verified', operationId: 'dropbox' }, sheets: { state: 'verified', operationId: 'sheets' } },
      audit: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await putBookkeepingItem(client, 'document', {
      id: 'invented-missing-amount-source', documentType: 'receipt', status: 'active', needsReview: true,
      transactionDate: `${period}-20`, counterparty: 'Invented Missing Amount Vendor', currency: 'EUR',
    });
    await putBookkeepingItem(client, 'document', {
      id: 'invented-unknown-month-source', documentType: 'invoice', status: 'active', needsReview: true,
      counterparty: 'Invented Unknown Month Vendor', amount: 'invalid', currency: 'EUR',
    });
    await putBookkeepingItem(client, 'document', {
      id: 'invented-later-invalid-source', documentType: 'invoice', status: 'active', needsReview: true,
      transactionDate: '2035-10-01', counterparty: 'Invented Later Month Vendor', amount: 'invalid', currency: 'EUR',
    });
    const view = await buildMonth(client, period);
    assert.equal(view.rows.length, 2);
    assert.deepEqual(view.rows.map((row) => row.amount).sort(), ['', 'unreadable-amount']);
    assert.ok(view.rows.every((row) => row.invoiceReview && !row.ledger && row.status === 'needs-review'));
    await assertBothExportsBlocked(period, /needs-attribution/);
  });

});
