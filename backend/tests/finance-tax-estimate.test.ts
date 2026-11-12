import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTaxes, gewerbesteuerBerlin, section35Relief, solidaritaetszuschlag, tariflicheEinkommensteuer, INCOME_TARIFFS } from '../src/finance/taxEstimate';
import { handler } from '../src/handler';
import { useTestDatabase } from './helpers/db';

// Reference values are computed from the statutory § 32a Abs. 1 EStG zone
// formulas whose coefficients are cited in taxEstimate.ts, cross-checked
// against published tax-table anchors (e.g. VZ 2025, zvE 50.000 € → 10.691 €).

const invoke = (path: string) => {
  const [route, query = ''] = path.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  return handler({ httpMethod: 'GET', path: route, headers: {}, body: null, queryStringParameters: params }, {});
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
  });
});
