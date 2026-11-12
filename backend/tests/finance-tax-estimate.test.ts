import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTaxes, gewerbesteuerBerlin, section35Relief, solidaritaetszuschlag, tariflicheEinkommensteuer, INCOME_TARIFFS } from '../src/finance/taxEstimate';
import { handler } from '../src/handler';
import { putTaxReturn } from '../src/finance/taxReturns';
import { saveStatement } from '../src/reconcile/service';
import { getClient } from '../src/db/client';
import { berlinToday } from '../src/relativeDates';
import { useTestDatabase } from './helpers/db';

// Reference values are computed from the statutory § 32a Abs. 1 EStG zone
// formulas whose coefficients are cited in taxEstimate.ts, cross-checked
// against published tax-table anchors (e.g. VZ 2025, zvE 50.000 € → 10.691 €).

const invoke = (path: string) => {
  const [route, query = ''] = path.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  return handler({ httpMethod: 'GET', path: route, headers: {}, body: null, queryStringParameters: params }, {});
};

const send = (method: string, path: string, body?: unknown) =>
  handler({ httpMethod: method, path, headers: {}, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: {} }, {});

// The official figures of the 2024 and 2025 assessments (FA Pankow/Weißensee,
// Bescheide vom 29.10.2026; USt per filed returns). The refund arithmetic in
// the tests below must reconcile exactly to the payouts of 30.10.2026.
const RETURN_2024 = {
  year: 2024,
  closed: true,
  assessed: { incomeTax: 15517.00, soli: 0.00, tradeTax: 10332.00, vat: 8167.40 },
  paid: { incomeTax: 41254.00, soli: 2916.00, tradeTax: 13184.00, vat: 1192.58 },
  refunded: 27729.10,
  refundedOn: '2026-10-30',
  offsets: [
    { amount: 2874.00, target: 'Gewerbesteuer 2025' },
    { amount: 1116.90, target: 'Gewerbesteuer 2025' },
  ],
  notes: [
    'GewSt 2024: 2.852,00 € zu viel gezahlt (13.184,00 € Vorauszahlungen gegen 10.332,00 € Festsetzung) plus 22,00 € Zinsen wurden auf die GewSt 2025 verrechnet, nicht ausgezahlt.',
    'Von der ESt-Gutschrift wurden 1.116,90 € auf die GewSt 2025 verrechnet; ausgezahlt wurden 27.729,10 € am 30.10.2026 (ESt 25.737,00 € + Erstattungszinsen 193,00 € + Soli 2.916,00 € − 1.116,90 €).',
    'USt 2024: laut Erklärung Erstattungsanspruch 28,60 €; Vorauszahlungssoll 1.192,58 €.',
  ],
  sources: [
    'Bescheid vom 29.10.2026 über Einkommensteuer, Solidaritätszuschlag und Zinsen für 2024, FA Pankow/Weißensee (zvE 82.700 €, §-35-Ermäßigung 10.080 €)',
    'Bescheid vom 29.10.2026 über Gewerbesteuer für 2024 (Messbetrag 2.520 € × Hebesatz 410 %)',
    'Bescheid vom 29.10.2026 über den Gewerbesteuermessbetrag für 2024',
    'Umsatzsteuererklärung 2024, Ausfertigung 21.11.2025; FA-Mitteilung über USt 2024 vom 08.12.2025 (Scan)',
    'ILZ Mandantenserver 10059, 03_von_StB/03_JA-StE/2024/02_Bescheide',
  ],
};

const RETURN_2025 = {
  year: 2025,
  closed: true,
  assessed: { incomeTax: 27542.00, soli: 721.37, tradeTax: 17174.90, vat: 13945.51 },
  paid: { incomeTax: 41252.00, soli: 2916.00, tradeTax: 13184.00, vat: 4581.14 },
  refunded: 15904.63,
  refundedOn: '2026-10-30',
  notes: [
    'GewSt 2025: Fehlbetrag 3.990,90 € wurde durch die Guthaben aus den Bescheiden vom 29.10.2026 für 2024 ausgeglichen, keine Zahlung fällig.',
    'Ausgezahlt wurden 15.904,63 € am 30.10.2026 (ESt 13.710,00 € + Soli 2.194,63 €).',
    'Neue Vorauszahlungen ab 2027: ESt 6.951,00 €/Quartal + Soli 160,00 €/Quartal; für 2026 sind keine Vorauszahlungen festgesetzt.',
    'USt 2025: Abschlusszahlung 4.581,14 € laut Erklärung, gezahlt am 13.04.2026.',
  ],
  sources: [
    'Bescheid vom 29.10.2026 über Einkommensteuer und Solidaritätszuschlag für 2025, FA Pankow/Weißensee (zvE 127.811 €, §-35-Ermäßigung 16.756 €)',
    'Bescheid vom 29.10.2026 über Gewerbesteuer für 2025 (Messbetrag 4.189 € × Hebesatz 410 %)',
    'Bescheid vom 29.10.2026 über den Gewerbesteuermessbetrag für 2025',
    'Umsatzsteuererklärung 2025, Ausfertigung 04.03.2026',
    'ILZ Mandantenserver 10059, 03_von_StB/03_JA-StE/2025/02_Bescheide',
  ],
};

describe('§ 32a EStG Grundtarif per year', () => {
  it('is zero at and below the Grundfreibetrag', () => {
    assert.equal(tariflicheEinkommensteuer(2024, 11784), 0);
    assert.equal(tariflicheEinkommensteuer(2025, 12096), 0);
    assert.equal(tariflicheEinkommensteuer(2026, 12348), 0);
    assert.equal(tariflicheEinkommensteuer(2026, 5000), 0);
  });

  it('matches published table anchors at 50.000 € zvE', () => {
    assert.equal(tariflicheEinkommensteuer(2024, 50000), 10872);
    assert.equal(tariflicheEinkommensteuer(2025, 50000), 10691, 'official ESt-Tabelle 2025 anchor');
    assert.equal(tariflicheEinkommensteuer(2026, 50000), 10549);
  });

  it('rounds down in 2024/2025 and up in 2026 (inverted tariff)', () => {
    // VZ 2025 zone 2 at 13.000 €: (932.30·0.0904 + 1400)·0.0904 = 134.276… → 134
    assert.equal(tariflicheEinkommensteuer(2025, 13000), 134);
    // VZ 2026 zone 2 at 13.000 €: (914.51·0.0652 + 1400)·0.0652 = 95.17… → 96
    assert.equal(tariflicheEinkommensteuer(2026, 13000), 96);
  });

  it('stays continuous at the zone transitions within two euros', () => {
    const transitions = {
      2024: [[11784, 11785], [17005, 17006], [66760, 66761], [277825, 277826]],
      2025: [[12096, 12097], [17443, 17444], [68480, 68481], [277825, 277826]],
      2026: [[12348, 12349], [17799, 17800], [69878, 69879], [277825, 277826]],
    };
    for (const [year, pairs] of Object.entries(transitions)) {
      for (const [below, above] of pairs as number[][]) {
        const jump = tariflicheEinkommensteuer(Number(year), above) - tariflicheEinkommensteuer(Number(year), below);
        assert.ok(Math.abs(jump) <= 2, `year ${year} transition ${below}→${above}: jump ${jump}`);
      }
    }
  });

  it('reaches the 42 % and 45 % marginal zones', () => {
    assert.equal(tariflicheEinkommensteuer(2026, 300000), Math.ceil(0.45 * 300000 - INCOME_TARIFFS[2026].z5));
    assert.equal(tariflicheEinkommensteuer(2025, 100000), Math.floor(0.42 * 100000 - INCOME_TARIFFS[2025].z4));
  });

  it('refuses years without an enacted statutory tariff', () => {
    assert.throws(() => tariflicheEinkommensteuer(2027, 50000), /No statutory tariff/);
  });
});

describe('Solidaritätszuschlag (§ 3 Abs. 1 SolzG)', () => {
  it('is zero at and below the year’s Freigrenze', () => {
    assert.equal(solidaritaetszuschlag(2024, 18130), 0);
    assert.equal(solidaritaetszuschlag(2025, 19950), 0);
    assert.equal(solidaritaetszuschlag(2026, 20350), 0);
  });

  it('is 5,5 % of the income tax above the Freigrenze', () => {
    assert.equal(solidaritaetszuschlag(2026, 30000), 530.75);
    assert.equal(solidaritaetszuschlag(2025, 30000), 552.75);
    assert.equal(solidaritaetszuschlag(2026, 28695), 458.98);
  });
});

describe('Gewerbesteuer Berlin (§ 10, § 11 Abs. 2 Nr. 1, § 16 Abs. 4 GewStG)', () => {
  it('is zero at and below the 24.500 € Freibetrag', () => {
    assert.deepEqual(gewerbesteuerBerlin(24500), { messbetrag: 0, steuer: 0 });
    assert.deepEqual(gewerbesteuerBerlin(10000), { messbetrag: 0, steuer: 0 });
  });

  it('applies 3,5 % Messzahl on the profit above the Freibetrag and the 410 % Hebesatz', () => {
    assert.deepEqual(gewerbesteuerBerlin(100000), { messbetrag: 2642.5, steuer: 10834.25 });
    assert.deepEqual(gewerbesteuerBerlin(124500), { messbetrag: 3500, steuer: 14350 });
  });
});

describe('§ 35 Abs. 1 EStG relief', () => {
  it('is 4 × Messbetrag, capped at the actual Gewerbesteuer and the tariff amount', () => {
    const trade = gewerbesteuerBerlin(100000);
    assert.equal(section35Relief(100000, trade.steuer, 30865), 10570);
    // Hebesatz 410 % > 400 %: the relief stays below the Gewerbesteuer itself.
    assert.ok(section35Relief(100000, trade.steuer, 30865) < trade.steuer);
    // At 1 Mio € profit the 4 × Messbetrag cap binds below the Gewerbesteuer.
    const big = gewerbesteuerBerlin(1000000);
    assert.equal(section35Relief(1000000, big.steuer, 430530), 136570);
    // Never more than the income tax itself: tiny profit, no tariff, no relief.
    assert.equal(section35Relief(12000, 0, 0), 0);
  });
});

describe('estimateTaxes for a year', () => {
  it('estimates ESt, Soli, GewSt separately with inputs, formula and sources', () => {
    const e = estimateTaxes(2026, 100000);
    assert.equal(e.zvEEur, 100000);
    assert.equal(e.incomeTax.tariflich, 30865);
    assert.equal(e.incomeTax.section35Relief, 10570);
    assert.equal(e.incomeTax.einkommensteuer, 20295);
    // 20.295 € is below the 20.350 € Soli-Freigrenze of 2026.
    assert.equal(e.soli, 0);
    assert.equal(e.tradeTax.steuer, 10834.25);
    assert.equal(e.totalEstimate, 31129.25);
    assert.ok(e.inputs[0].includes('2026'));
    assert.match(e.inputs[1], /Grundtarif.*Berlin/);
    assert.ok(e.formula.join(' ').includes('§ 32a'));
    assert.ok(e.sources.some((s) => s.includes('gesetze-im-internet.de/estg/__32a.html')));
    assert.match(e.disclaimer, /estimate/i);
  });

  it('charges Soli once the income tax clears the Freigrenze', () => {
    const e = estimateTaxes(2026, 130000);
    assert.equal(e.incomeTax.einkommensteuer, 28695);
    assert.equal(e.soli, 458.98);
    assert.equal(e.tradeTax.steuer, 15139.25);
    assert.equal(e.totalEstimate, 44293.23);
  });

  it('stays at zero for a profit below the Grundfreibetrag', () => {
    const e = estimateTaxes(2026, 10000);
    assert.equal(e.totalEstimate, 0);
    assert.equal(e.incomeTax.einkommensteuer, 0);
    assert.equal(e.soli, 0);
    assert.equal(e.tradeTax.steuer, 0);
  });

  it('floors the profit to whole euros for the tariff', () => {
    const e = estimateTaxes(2025, 50000.99);
    assert.equal(e.zvEEur, 50000);
    assert.equal(e.incomeTax.tariflich, 10691);
  });
});

describe('tax-estimate route', () => {
  it('refuses unsupported years with the supported list', async () => {
    await useTestDatabase();
    const bad = await invoke('/api/finance/tax-estimate?year=2019');
    assert.equal(bad.statusCode, 400);
    assert.match(JSON.parse(bad.body).error, /No statutory tariff for 2019/);
    const malformed = await invoke('/api/finance/tax-estimate');
    assert.equal(malformed.statusCode, 400);
  });

  it('estimates from the ledger profit and the taxes already paid that year', async () => {
    await useTestDatabase();
    const response = await invoke('/api/finance/tax-estimate?year=2026');
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.year, 2026);
    assert.equal(typeof body.profitEur, 'number');
    assert.deepEqual(Object.keys(body.paid).sort(), ['incomeTax', 'tradeTax']);
    assert.equal(body.remaining, Math.round((body.totalEstimate - body.paidTotal) * 100) / 100);
    assert.ok(body.sources.join(' ').includes('§ 32a'));
    assert.equal(body.assessment, null);
    assert.equal(typeof body.planning.ownerPayEur, 'number');
    assert.equal(body.planning.businessBalance.totalEur, null);
    assert.equal(body.planning.safeToWithdrawEur, null);
    assert.equal(body.planning.projectedAfterTaxEur, Math.round((body.profitEur - body.totalEstimate) * 100) / 100);
    assert.ok(body.planning.formula.join(' ').includes('Safe to withdraw'));
  });

  it('computes safe-to-withdraw from the stored business balances', async () => {
    const client = await getClient();
    const today = berlinToday();
    await saveStatement(client, {
      accountId: 'finom', period: today.slice(0, 7), filename: 'synthetic-finom-estimate.csv',
      rows: [{ date: today, amount: '-3.50', currency: 'EUR', counterparty: 'Cafe', reference: 'coffee' }],
      balances: [{ currency: 'EUR', amount: '5000.00', asOf: today }],
    });
    await saveStatement(client, {
      accountId: 'revolut', period: today.slice(0, 7), filename: 'synthetic-revolut-estimate.csv',
      rows: [{ date: today, amount: '-9.90', currency: 'EUR', counterparty: 'Books', reference: 'paperback' }],
      balances: [{ currency: 'EUR', amount: '250.50', asOf: today }],
    });
    const body = JSON.parse((await invoke('/api/finance/tax-estimate?year=2026')).body);
    assert.equal(body.planning.businessBalance.totalEur, 5250.50);
    assert.deepEqual(body.planning.businessBalance.accounts.map((a: { accountId: string }) => a.accountId).sort(), ['finom', 'revolut']);
    assert.equal(body.planning.safeToWithdrawEur, Math.round((5250.50 - body.remaining) * 100) / 100);
    assert.ok(body.planning.formula.join(' ').includes('finom'));
  });
});

describe('stored tax-return records (Bescheid figures per year)', () => {
  it('refuses an invalid record with field-level errors', async () => {
    await useTestDatabase();
    const response = await send('PUT', '/api/finance/tax-returns/2024', { closed: 'yes', assessed: {}, sources: [] });
    assert.equal(response.statusCode, 400);
    const fields = JSON.parse(response.body).fields;
    assert.ok(fields.some((f: string) => f.includes('closed')));
    assert.ok(fields.some((f: string) => f.includes('assessed')));
    assert.ok(fields.some((f: string) => f.includes('sources')));
  });

  it('stores the 2024 record and reconciles the 27.729,10 € payout', async () => {
    const stored = JSON.parse((await send('PUT', '/api/finance/tax-returns/2024', RETURN_2024)).body);
    assert.equal(stored.year, 2024);
    assert.equal(stored.closed, true);
    // Bescheid arithmetic: prepaid ESt 41.254,00 € − assessed 15.517,00 € = credit
    // 25.737,00 €; plus refunded Soli 2.916,00 € and Zinsen 193,00 €, minus the
    // 1.116,90 € carried to GewSt 2025 = the 27.729,10 € payout of 30.10.2026.
    assert.equal(41254.00 - 15517.00 + 2916.00 + 193.00 - 1116.90, 27729.10);
    assert.equal(stored.refunded, 27729.10);

    const estimate = JSON.parse((await invoke('/api/finance/tax-estimate?year=2024')).body);
    assert.equal(estimate.assessment.year, 2024);
    assert.equal(estimate.paid.incomeTax, 44170.00, 'official prepaid ESt 41.254,00 € + Soli 2.916,00 €');
    assert.equal(estimate.paid.tradeTax, 13184.00);
    assert.ok(estimate.assessment.sources.join(' ').includes('Bescheid vom 29.10.2026'));

    const summary = JSON.parse((await invoke('/api/finance/summary?year=2024')).body);
    assert.equal(summary.taxReturn.closed, true);
    assert.equal(summary.taxReturn.assessed.tradeTax, 10332.00);
  });

  it('stores the 2025 record and reconciles the 15.904,63 € payout', async () => {
    await send('PUT', '/api/finance/tax-returns/2025', RETURN_2025);
    // Bescheid arithmetic: prepaid ESt 41.252,00 € − assessed 27.542,00 € = credit
    // 13.710,00 €; plus refunded Soli 2.916,00 € − 721,37 € Soli = the 15.904,63 € payout.
    assert.equal(41252.00 - 27542.00 + 2916.00 - 721.37, 15904.63);

    const estimate = JSON.parse((await invoke('/api/finance/tax-estimate?year=2025')).body);
    assert.equal(estimate.paid.incomeTax, 44168.00, 'official prepaid ESt 41.252,00 € + Soli 2.916,00 €');
    assert.equal(estimate.paid.tradeTax, 13184.00);
    assert.equal(estimate.assessment.assessed.soli, 721.37);

    const summary = JSON.parse((await invoke('/api/finance/summary?year=2025')).body);
    assert.equal(summary.taxReturn.closed, true);
    assert.equal(summary.taxReturn.assessed.vat, 13945.51);
  });

  it('keeps years without a record open', async () => {
    const summary = JSON.parse((await invoke('/api/finance/summary?year=2026')).body);
    assert.equal(summary.taxReturn, null);
  });
});
