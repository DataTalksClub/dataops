import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMandatoryPayment } from '../src/finance/mandatoryPayments';

describe('mandatory payment classifier', () => {
  it('classifies TK from the counterparty and bank reference', () => {
    assert.deepEqual(classifyMandatoryPayment({ counterparty: 'Techniker Krankenkasse' }), {
      kind: 'tk_debit', line: 'health-insurance', label: 'Health insurance',
    });
    assert.deepEqual(classifyMandatoryPayment({ reference: 'TK-BuchNr 06408502800 Monat 03/26' }), {
      kind: 'tk_debit', line: 'health-insurance', label: 'Health insurance',
    });
  });

  it('splits Finanzamt VAT purposes from other tax purposes', () => {
    assert.deepEqual(classifyMandatoryPayment({ counterparty: 'Finanzamt', reference: 'UMS.ST 2025' }), {
      kind: 'tax_debit', line: 'vat', label: 'VAT',
    });
    assert.deepEqual(classifyMandatoryPayment({ counterparty: 'Bundeskasse', reference: 'EINK.ST / SOLI' }), {
      kind: 'tax_debit', line: 'taxes', label: 'Other taxes',
    });
    assert.deepEqual(classifyMandatoryPayment({ kind: 'tax_debit', reference: 'GEW.ST 2026' }), {
      kind: 'tax_debit', line: 'taxes', label: 'Other taxes',
    });
  });

  it('uses ledger categories as a fallback and leaves unrelated entries unclassified', () => {
    assert.equal(classifyMandatoryPayment({ category: 'Taxes' })?.kind, 'tax_debit');
    assert.equal(classifyMandatoryPayment({ category: 'VAT' })?.line, 'vat');
    assert.equal(classifyMandatoryPayment({ category: 'Health Insurance' })?.kind, 'tk_debit');
    assert.equal(classifyMandatoryPayment({ counterparty: 'Synthetic Vendor', reference: 'monthly service' }), null);
  });
});
