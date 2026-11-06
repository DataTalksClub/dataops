import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { documentName, packagePath, proofName, reportName, slug, statementName, taxName, uniquePaths } from '../src/reconcile/naming';

describe('month package naming', () => {
  it('slugs counterparties to lowercase ascii with hyphens, at most 40 characters', () => {
    assert.equal(slug('Pro Sulum, LLC'), 'pro-sulum-llc');
    assert.equal(slug('Müller & Söhne GmbH'), 'mueller-soehne-gmbh');
    assert.equal(slug('Café Crème'), 'cafe-creme');
    assert.equal(slug('A'.repeat(30) + ' ' + 'B'.repeat(30)), 'a'.repeat(30));
    assert.ok(slug('x'.repeat(80)).length <= 40);
    assert.equal(slug(''), 'unknown');
  });

  it('names each package part from its data', () => {
    assert.equal(statementName('2028-03', 'finom', 'main', 'source.csv'), '2028-03_finom-main_statement.csv');
    assert.equal(statementName('2028-03', 'revolut', 'EUR', 'x.pdf'), '2028-03_revolut-eur_statement.pdf');
    assert.equal(documentName({ date: '2028-03-17', counterparty: 'Example Tools Ltd', description: 'Annual workspace license', amount: '-83.42', currency: 'usd' }), '2028-03-17_example-tools-ltd_annual-workspace-license_83.42USD.pdf');
    assert.equal(documentName({ date: '2028-03-18', counterparty: 'Example Cloud', description: 'Hosting', amount: 27, currency: 'EUR' }), '2028-03-18_example-cloud_hosting_27.00EUR.pdf');
    assert.equal(proofName({ date: '2028-03-18', counterparty: 'Example Cloud', description: 'Hosting', amount: 27, currency: 'EUR' }), '2028-03-18_example-cloud_payment-proof-hosting_27.00EUR.pdf');
    assert.equal(taxName({ date: '2026-11-10', kind: 'ust-va', period: '2026-10' }), '2026-11-10_ust-va_2026-10.pdf');
    assert.equal(reportName('2026-10', 'xlsx'), '2026-10_reconciliation_datatalksclub.xlsx');
    assert.equal(packagePath('2026-10', 'expenses', 'a.pdf'), '2026-10/expenses/a.pdf');
    assert.equal(packagePath('2026-10', null, 'r.csv'), '2026-10/r.csv');
  });

  it('suffixes collisions -2, -3 in order', () => {
    assert.deepEqual(uniquePaths(['m/e/a.pdf', 'm/e/a.pdf', 'm/e/b.pdf', 'm/e/a.pdf']), ['m/e/a.pdf', 'm/e/a-2.pdf', 'm/e/b.pdf', 'm/e/a-3.pdf']);
  });
});
