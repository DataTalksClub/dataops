/**
 * German income- and trade-tax estimate for a sole trader (Grundtarif, single)
 * with a Berlin Gewerbe, from the profit actually earned in a year so far.
 *
 * All rates below are statutory, cited per year — nothing here is invented:
 *
 * Einkommensteuertarif, § 32a EStG (Grundtarif, Abs. 1):
 * - VZ 2024 (Fassung after the mid-2024 Grundfreibetrag raise): Grundfreibetrag
 *   11.784 €; zones 11.785–17.005 / 17.006–66.760 / 66.761–277.825 / ≥277.826;
 *   Steuerbetrag abgerundet. Verbatim zone formulas per the amendment text
 *   (https://www.buzer.de/gesetz/4499/al210146-0.htm, § 32a EStG geändert).
 * - VZ 2025 (§ 32a EStG geändert per Inflationsausgleichsgesetz, verkündet
 *   27.12.2024, same transcription): Grundfreibetrag 12.096 €; zones
 *   12.097–17.443 / 17.444–68.480 / 68.481–277.825 / ≥277.826; abgerundet.
 * - VZ 2026 (current text at https://www.gesetze-im-internet.de/estg/__32a.html,
 *   ab VZ 2026 "Steuerumkehrung"): Grundfreibetrag 12.348 €; zones
 *   12.349–17.799 / 17.800–69.878 / 69.879–277.825 / ≥277.826; Steuerbetrag
 *   aufgerundet.
 *
 * Solidaritätszuschlag, § 3 Abs. 1 SolzG (ab 2021): 5,5 % der festgesetzten
 * Einkommensteuer, soweit sie die Freigrenze übersteigt. Freigrenzen
 * (Grundtarif): 18.130 € (VZ 2024), 19.950 € (VZ 2025), 20.350 € (VZ 2026).
 *
 * Gewerbesteuer: Steuermesszahl 3,5 % (§ 10 GewStG), Freibetrag 24.500 € für
 * natürliche Personen (§ 11 Abs. 2 Nr. 1 GewStG), Hebesatz Berlin 410 %
 * (§ 16 Abs. 4 GewStG i. V. m. dem Berliner Haushaltsgesetz).
 *
 * Anrechnung auf die Einkommensteuer, § 35 Abs. 1 EStG (Fassung ab VZ 2020):
 * die tarifliche Einkommensteuer mindert sich um das Vierfache des
 * Steuermessbetrags, höchstens um die tatsächlich zu zahlende Gewerbesteuer
 * und höchstens um die tarifliche Einkommensteuer selbst.
 */

export type TariffZone = {
  year: number;
  /** Grundfreibetrag: zvE up to this amount pays no tax. */
  gfb: number;
  /** Upper bound of the second (y) zone. */
  y2End: number;
  /** Upper bound of the third (z) zone. */
  z3End: number;
  /** Upper bound of the 42 % zone. */
  z4End: number;
  /** VZ 2026 inverted tariff rounds the tax amount up, earlier years down. */
  roundUp: boolean;
  y2: number;
  z3: number;
  z3Base: number;
  z4: number;
  z5: number;
  source: string;
};

// Coefficients verbatim from the statute texts cited above.
export const INCOME_TARIFFS: Record<number, TariffZone> = {
  2024: {
    year: 2024, gfb: 11784, y2End: 17005, z3End: 66760, z4End: 277825, roundUp: false,
    y2: 954.80, z3: 181.19, z3Base: 991.21, z4: 10636.31, z5: 18971.06,
    source: '§ 32a Abs. 1 EStG, VZ 2024 (Grundfreibetrag 11.784 €; amendment text at buzer.de/gesetz/4499/al210146-0.htm)',
  },
  2025: {
    year: 2025, gfb: 12096, y2End: 17443, z3End: 68480, z4End: 277825, roundUp: false,
    y2: 932.30, z3: 176.64, z3Base: 1015.13, z4: 10911.92, z5: 19246.67,
    source: '§ 32a Abs. 1 EStG, VZ 2025 (Grundfreibetrag 12.096 €; amendment text at buzer.de/gesetz/4499/al210146-0.htm)',
  },
  2026: {
    year: 2026, gfb: 12348, y2End: 17799, z3End: 69878, z4End: 277825, roundUp: true,
    y2: 914.51, z3: 173.10, z3Base: 1034.87, z4: 11135.63, z5: 19470.38,
    source: '§ 32a Abs. 1 EStG, ab VZ 2026 (gesetze-im-internet.de/estg/__32a.html; Grundfreibetrag 12.348 €, Steuerbetrag aufgerundet)',
  },
};

const SOLI_RATE = 0.055; // § 3 Abs. 1 SolzG
const SOLI_FREIGRENZE: Record<number, number> = {
  2024: 18130,
  2025: 19950,
  2026: 20350,
}; // § 3 Abs. 1 SolzG Freigrenzen, Grundtarif (Einzelveranlagung)

// Gewerbesteuer constants: § 10 (Messzahl), § 11 Abs. 2 Nr. 1 (Freibetrag,
// natürliche Personen), § 16 Abs. 4 GewStG (Hebesatz Stadt Berlin).
const TRADE_TAX_MEASSZAHL = 0.035;
const TRADE_TAX_FREIBETRAG = 24500;
const TRADE_TAX_HEBESATZ_BERLIN = 4.1;

const cents = (v: number) => Math.round(v * 100);
/** cents (or a euro float with rounding noise) → euro float with two decimals. */
const euros = (v: number) => Math.round(v) / 100;
const round2 = (v: number) => Math.round(v * 100) / 100;
const floorEuro = (v: number) => Math.floor(Math.round(v * 100) / 100);

/** Tariff amount for one year’s § 32a Abs. 1 EStG Grundtarif on a whole-euro zvE. */
export function tariflicheEinkommensteuer(year: number, zvE: number): number {
  const t = INCOME_TARIFFS[year];
  if (!t) throw new Error(`No statutory tariff for ${year}`);
  if (zvE <= t.gfb) return 0;
  let amount: number;
  if (zvE <= t.y2End) {
    const y = (zvE - t.gfb) / 10000;
    amount = (t.y2 * y + 1400) * y;
  } else if (zvE <= t.z3End) {
    const z = (zvE - t.y2End) / 10000;
    amount = (t.z3 * z + 2397) * z + t.z3Base;
  } else if (zvE <= t.z4End) {
    amount = 0.42 * zvE - t.z4;
  } else {
    amount = 0.45 * zvE - t.z5;
  }
  return t.roundUp ? Math.ceil(amount) : Math.floor(amount);
}

/** § 3 Abs. 1 SolzG: 5,5 % of the income tax above the year’s Freigrenze. */
export function solidaritaetszuschlag(year: number, einkommensteuer: number): number {
  const freigrenze = SOLI_FREIGRENZE[year];
  if (freigrenze === undefined) throw new Error(`No Soli-Freigrenze for ${year}`);
  const above = Math.max(0, cents(einkommensteuer) - cents(freigrenze));
  return euros(above * SOLI_RATE);
}

/** § 10/§ 11 Abs. 2 Nr. 1/§ 16 Abs. 4 GewStG: Messbetrag and Berlin amount. */
export function gewerbesteuerBerlin(profitEur: number): { messbetrag: number; steuer: number } {
  const basis = Math.max(0, cents(profitEur) - cents(TRADE_TAX_FREIBETRAG));
  const messbetragCents = Math.round(basis * TRADE_TAX_MEASSZAHL);
  return { messbetrag: euros(messbetragCents), steuer: euros(messbetragCents * TRADE_TAX_HEBESATZ_BERLIN) };
}

export type TaxEstimate = {
  year: number;
  basis: 'grundtarif-berlin';
  /** Net profit excluding VAT earned so far, the estimate input in EUR. */
  profitEur: number;
  /** Profit floored to whole euros, the zvE the tariff runs on. */
  zvEEur: number;
  incomeTax: { tariflich: number; section35Relief: number; einkommensteuer: number };
  soli: number;
  tradeTax: { messbetrag: number; steuer: number };
  totalEstimate: number;
  inputs: string[];
  formula: string[];
  sources: string[];
  disclaimer: string;
};

/**
 * § 35 Abs. 1 EStG: income tax reduced by 4 × Messbetrag, at most the actual
 * Gewerbesteuer and at most the tariff amount itself.
 */
export function section35Relief(profitEur: number, gewerbesteuer: number, tariflich: number): number {
  const basis = Math.max(0, cents(profitEur) - cents(TRADE_TAX_FREIBETRAG));
  const vierfachMessbetrag = euros(Math.round(basis * TRADE_TAX_MEASSZAHL * 4));
  return Math.min(vierfachMessbetrag, gewerbesteuer, tariflich);
}

export function estimateTaxes(year: number, profitEur: number): TaxEstimate {
  const zvE = Math.max(0, floorEuro(profitEur));
  const tariflich = tariflicheEinkommensteuer(year, zvE);
  const tradeTax = gewerbesteuerBerlin(profitEur);
  const relief = section35Relief(profitEur, tradeTax.steuer, tariflich);
  const einkommensteuer = euros(cents(tariflich) - cents(relief));
  const soli = solidaritaetszuschlag(year, einkommensteuer);
  const total = euros(cents(einkommensteuer) + cents(soli) + cents(tradeTax.steuer));
  const t = INCOME_TARIFFS[year];
  if (!t) throw new Error(`No statutory tariff for ${year}`);
  return {
    year,
    basis: 'grundtarif-berlin',
    profitEur: round2(profitEur),
    zvEEur: zvE,
    incomeTax: { tariflich, section35Relief: relief, einkommensteuer },
    soli,
    tradeTax,
    totalEstimate: total,
    inputs: [
      `Profit earned so far in ${year} (net profit excluding VAT from the finance summary): ${euros(profitEur)} EUR`,
      'Assumption: sole trader, single (Grundtarif), Berlin Gewerbe; profit stands in for the Gewerbeertrag and the taxable income, no other deductions.',
    ],
    formula: [
      `Einkommensteuer: § 32a Abs. 1 EStG Grundtarif on zvE ${zvE} EUR → ${tariflich} EUR, minus § 35 Abs. 1 EStG relief (4 × Messbetrag, max Gewerbesteuer) ${relief} EUR → ${einkommensteuer} EUR.`,
      `Solidaritätszuschlag: 5,5 % of the income tax above the ${SOLI_FREIGRENZE[year].toLocaleString('de-DE')} € Freigrenze → ${soli} EUR.`,
      `Gewerbesteuer: 3,5 % of the profit above the 24.500 € Freibetrag = ${tradeTax.messbetrag} EUR Messbetrag, × Berlin Hebesatz 410 % → ${tradeTax.steuer} EUR.`,
    ],
    sources: [t.source, '§ 3 Abs. 1 SolzG (Freigrenze ' + SOLI_FREIGRENZE[year].toLocaleString('de-DE') + ' €)', '§ 10, § 11 Abs. 2 Nr. 1, § 16 Abs. 4 GewStG (Messzahl 3,5 %, Freibetrag 24.500 €, Hebesatz Berlin 410 %)', '§ 35 Abs. 1 EStG (ab VZ 2020: Vierfaches des Steuermessbetrags)'],
    disclaimer: 'Rough estimate, not a tax return: statutory tariffs applied to the profit booked so far; payments in advance, deductions and TK contributions are not modelled.',
  };
}
