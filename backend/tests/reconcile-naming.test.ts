import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { docToken, documentName, packagePath, proofName, reportName, slug, statementName, taxName, uniquePaths } from '../src/reconcile/naming';

describe('month package naming', () => {
  it('slugs counterparties to lowercase ascii with hyphens, at most 40 characters', () => {
    assert.equal(slug('Pro Sulum, LLC'), 'pro-sulum-llc');
    assert.equal(slug('Müller & Söhne GmbH'), 'mueller-soehne-gmbh');
    assert.equal(slug('Café Crème'), 'cafe-creme');
    assert.equal(slug('A'.repeat(30) + ' ' + 'B'.repeat(30)), 'a'.repeat(30));
    assert.ok(slug('x'.repeat(80)).length <= 40);
    assert.equal(slug(''), 'unknown');
    assert.equal(docToken('202610/53'), '202610-53');
  });

  it('names each package part from its data', () => {
    assert.equal(statementName('2026-10', 'finom', 'main', 'finom_2026-10_main.csv'), '2026-10_finom-main.csv');
    assert.equal(statementName('2026-10', 'revolut', 'EUR', 'x.pdf'), '2026-10_revolut-eur.pdf');
    assert.equal(documentName({ date: '2026-10-30', counterparty: 'Pro Sulum, LLC', documentNumber: 'D9D54E5A-0059-CN-01', amount: '-646.63', currency: 'usd' }), '2026-10-30_pro-sulum-llc_D9D54E5A-0059-CN-01_646.63USD.pdf');
    assert.equal(documentName({ date: '2026-10-14', counterparty: 'Google', amount: -1.99, currency: 'EUR' }), '2026-10-14_google_1.99EUR.pdf');
    assert.equal(proofName({ date: '2026-10-14', counterparty: 'Google', ledgerId: 'a1c9d26b53120ca5896d' }), '2026-10-14_google_a1c9d26b5312.pdf');
    assert.equal(taxName({ date: '2026-11-10', kind: 'ust-va', period: '2026-10' }), '2026-11-10_ust-va_2026-10.pdf');
    assert.equal(reportName('2026-10', 'xlsx'), '2026-10_reconciliation_datatalksclub.xlsx');
    assert.equal(packagePath('2026-10', 'expenses', 'a.pdf'), '2026-10/expenses/a.pdf');
    assert.equal(packagePath('2026-10', null, 'r.csv'), '2026-10/r.csv');
  });

  it('suffixes collisions -2, -3 in order', () => {
    assert.deepEqual(uniquePaths(['m/e/a.pdf', 'm/e/a.pdf', 'm/e/b.pdf', 'm/e/a.pdf']), ['m/e/a.pdf', 'm/e/a-2.pdf', 'm/e/b.pdf', 'm/e/a-3.pdf']);
  });
});
