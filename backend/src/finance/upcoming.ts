/**
 * Upcoming tax and insurance auto-debits: every scheduled debit in a window,
 * its due date moved past weekends and Berlin public holidays (§108 AO), the
 * total due in the next 30 days, and whether the latest known business
 * account balance covers it. The schedule is data (TAX_SCHEDULE# items,
 * replaced when a new Bescheid or USt-VA arrives); nothing here knows an
 * amount. Pure: the caller loads schedule, ledger, statements and balance.
 */
import { holidaySnapshot } from '../calendar/holidays';

export type TaxType = 'income-tax' | 'trade-tax' | 'vat' | 'health-insurance' | 'other';
export type ScheduleRule =
  | { kind: 'monthly'; day: number }
  | { kind: 'quarterly'; months: number[]; day: number }
  | { kind: 'once'; date: string };
export type ScheduleEntry = {
  id: string;
  label: string;
  taxType: TaxType;
  amount: string;
  currency: 'EUR';
  rule: ScheduleRule;
  source: 'Bescheid' | 'USt-VA' | 'recurring';
  sourceRef?: string;
  // The debit date is only roughly known (an insurer collects "around" a day).
  approximate?: boolean;
  validFrom?: string;
  validUntil?: string;
  notes?: string;
  version?: number;
};
export type Balance = { accountId: string; amount: number; currency: string; asOf: string; source: string };
export type PaidEvidence = { id: string; date: string; amount: number; kind: 'ledger' | 'statement' };

export type Debit = {
  scheduleId: string;
  label: string;
  taxType: TaxType;
  dueDate: string;
  date: string;
  shifted: string | null;
  amount: number;
  currency: 'EUR';
  source: ScheduleEntry['source'];
  sourceRef: string | null;
  approximate: boolean;
  status: 'paid' | 'scheduled' | 'not-seen';
  matched: PaidEvidence | null;
};

export type Upcoming = {
  today: string;
  from: string;
  to: string;
  days: number;
  debits: Debit[];
  dueNext30: number;
  dueInWindow: number;
  balance: (Balance & { stale: boolean; ageDays: number }) | null;
  shortfall: boolean | null;
  warnings: string[];
};

const DAY = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const cents = (value: number) => Math.round(value * 100);
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay(year, month))).padStart(2, '0')}`;

/** Every due date the rule produces between from and to (inclusive). */
export function dueDates(rule: ScheduleRule, from: string, to: string): string[] {
  if (rule.kind === 'once') return rule.date >= from && rule.date <= to ? [rule.date] : [];
  const out: string[] = [];
  const months = rule.kind === 'monthly' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : rule.months;
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1)
    for (const month of months) {
      const date = iso(year, month, rule.day);
      if (date >= from && date <= to) out.push(date);
    }
  return out.sort();
}

/** The next business day on or after date, and why it moved. */
export function businessDay(date: string): { date: string; reason: string | null } {
  const holidays = new Map(holidaySnapshot(shift(date, -1), shift(date, 10))
    .filter((h) => h.kind === 'berlin-public-holiday')
    .map((h) => [h.startDate, h.name]));
  let day = date;
  const reasons: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 6 || weekday === 0) { reasons.push(weekday === 6 ? 'Saturday' : 'Sunday'); day = shift(day, 1); continue; }
    if (holidays.has(day)) { reasons.push(holidays.get(day)!); day = shift(day, 1); continue; }
    break;
  }
  return { date: day, reason: reasons.length ? `due ${date} falls on ${[...new Set(reasons)].join(' / ')}` : null };
}

export function upcomingDebits(input: {
  schedule: ScheduleEntry[];
  today: string;
  days?: number;
  lookbackDays?: number;
  paid?: PaidEvidence[];
  balance?: Balance | null;
  staleAfterDays?: number;
}): Upcoming {
  const days = input.days ?? 60;
  const from = shift(input.today, -(input.lookbackDays ?? 7));
  const to = shift(input.today, days);
  const used = new Set<string>();
  const debits: Debit[] = [];
  for (const entry of input.schedule) {
    // Look a little past the window so a shifted date can still land in it.
    for (const due of dueDates(entry.rule, shift(from, -5), to)) {
      if (entry.validFrom && due < entry.validFrom) continue;
      if (entry.validUntil && due > entry.validUntil) continue;
      const moved = businessDay(due);
      if (moved.date < from || moved.date > to) continue;
      const amount = Number(entry.amount);
      const tolerance = entry.approximate ? 7 : 5;
      const match = (input.paid || []).find((p) => !used.has(p.id) && cents(p.amount) === cents(amount) && Math.abs(daysBetween(moved.date, p.date)) <= tolerance) || null;
      if (match) used.add(match.id);
      debits.push({
        scheduleId: entry.id,
        label: entry.label,
        taxType: entry.taxType,
        dueDate: due,
        date: moved.date,
        shifted: moved.reason,
        amount,
        currency: 'EUR',
        source: entry.source,
        sourceRef: entry.sourceRef || null,
        approximate: !!entry.approximate,
        status: match ? 'paid' : moved.date < input.today ? 'not-seen' : 'scheduled',
        matched: match,
      });
    }
  }
  debits.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  const open = debits.filter((d) => d.status !== 'paid' && d.date >= input.today);
  const sum = (list: Debit[]) => list.reduce((total, d) => total + cents(d.amount), 0) / 100;
  const dueNext30 = sum(open.filter((d) => d.date <= shift(input.today, 30)));
  const dueInWindow = sum(open);

  const warnings: string[] = [];
  const staleAfter = input.staleAfterDays ?? 7;
  let balance: Upcoming['balance'] = null;
  let shortfall: boolean | null = null;
  if (input.balance) {
    const ageDays = daysBetween(input.balance.asOf.slice(0, 10), input.today);
    balance = { ...input.balance, ageDays, stale: ageDays > staleAfter };
    shortfall = cents(input.balance.amount) < cents(dueNext30);
    if (balance.stale) warnings.push(`Balance is ${ageDays} days old (as of ${input.balance.asOf.slice(0, 10)}); upload a current statement before relying on it`);
    if (shortfall) warnings.push(`Balance ${input.balance.amount.toFixed(2)} ${input.balance.currency} is below the ${dueNext30.toFixed(2)} EUR due in the next 30 days`);
  } else {
    warnings.push('No account balance known: upload the latest Finom statement to check the debits are covered');
  }
  for (const d of debits.filter((x) => x.status === 'not-seen'))
    warnings.push(`${d.label} due ${d.date} (${d.amount.toFixed(2)} EUR) is not in the ledger or a statement yet`);
  return { today: input.today, from, to, days, debits, dueNext30, dueInWindow, balance, shortfall, warnings };
}

const TAX_TYPES = new Set(['income-tax', 'trade-tax', 'vat', 'health-insurance', 'other']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Field-level problems with a schedule entry; empty means it can be stored. */
export function validateScheduleEntry(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(value.id)) errors.push('id');
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 120) errors.push('label');
  if (!TAX_TYPES.has(String(value.taxType))) errors.push('taxType');
  if (typeof value.amount !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(value.amount)) errors.push('amount');
  if (value.currency !== 'EUR') errors.push('currency');
  if (!['Bescheid', 'USt-VA', 'recurring'].includes(String(value.source))) errors.push('source');
  for (const name of ['validFrom', 'validUntil'] as const) if (value[name] != null && !DATE.test(String(value[name]))) errors.push(name);
  const rule = value.rule as Record<string, unknown> | undefined;
  const day = Number(rule?.day);
  if (!rule) errors.push('rule');
  else if (rule.kind === 'once') { if (!DATE.test(String(rule.date))) errors.push('rule.date'); }
  else if (rule.kind === 'monthly') { if (!Number.isInteger(day) || day < 1 || day > 31) errors.push('rule.day'); }
  else if (rule.kind === 'quarterly') {
    if (!Number.isInteger(day) || day < 1 || day > 31) errors.push('rule.day');
    if (!Array.isArray(rule.months) || !rule.months.length || rule.months.some((m) => !Number.isInteger(m) || Number(m) < 1 || Number(m) > 12)) errors.push('rule.months');
  } else errors.push('rule.kind');
  return errors;
}
