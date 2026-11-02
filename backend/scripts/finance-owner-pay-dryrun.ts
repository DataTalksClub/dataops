/**
 * Dry run: find owner pay (transfers from DTC accounts to the owner) in a
 * transactions export and write a markdown report. Read-only; it never writes
 * to DataOps. Usage:
 *   node --import tsx backend/scripts/finance-owner-pay-dryrun.ts <transactions.json> <owner-name-fragment>[,more] [out.md]
 * The export is a JSON array of ledger rows (or { items: [...] }).
 * Applying the classifications (category "Owner pay" + ownerPayType, and
 * taxType on tax rows) is a separate, reviewed step after the report is read.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { classifyOwnerPayCandidate } from '../src/finance/ownerPay';
import { classifyMandatoryPayment, taxTypeOf } from '../src/finance/mandatoryPayments';

const [file, owners, out = 'owner-pay-dryrun.md'] = process.argv.slice(2);
if (!file || !owners) { console.error('usage: finance-owner-pay-dryrun.ts <transactions.json> <owner-names> [out.md]'); process.exit(2); }
const parsed = JSON.parse(readFileSync(file, 'utf8'));
const rows: Array<Record<string, unknown>> = Array.isArray(parsed) ? parsed : parsed.items || [];
const names = owners.split(',').map((n) => n.trim()).filter(Boolean);
const date = (r: Record<string, unknown>) => String(r.paidDate || r.transactionDate || '');

const found = rows
  .filter((r) => r.entryType === 'expense' && date(r) >= '2024-01-01')
  .map((r) => ({ r, c: classifyOwnerPayCandidate({ ...r, entryType: 'expense' }, names) }))
  .filter((x) => x.c);
const byMonth = new Map<string, Record<string, number>>();
for (const { r, c } of found) {
  const m = date(r).slice(0, 7);
  const bucket = byMonth.get(m) || { salary: 0, draw: 0, reimbursement: 0, unknown: 0 };
  bucket[c!.ownerPayType] += Math.round(Number(r.amountEur || r.amount) * 100) / 100;
  byMonth.set(m, bucket);
}
const taxRows = rows.filter((r) => classifyMandatoryPayment(r) && r.entryType === 'expense').map((r) => ({ r, line: classifyMandatoryPayment(r)!.line }))
  .filter((x) => x.line === 'taxes' || x.line === 'vat').map((x) => ({ r: x.r, type: taxTypeOf(x.r, x.line), current: x.r.category }));

const lines = [
  '# Owner pay dry run', '', `Rows scanned: ${rows.length}. Owner pay candidates since 2024: ${found.length}. Nothing was written.`, '',
  '## Per month (EUR)', '', '| Month | salary | draw | reimbursement | unknown |', '|---|---:|---:|---:|---:|',
  ...[...byMonth.entries()].sort().map(([m, b]) => `| ${m} | ${b.salary.toFixed(2)} | ${b.draw.toFixed(2)} | ${b.reimbursement.toFixed(2)} | ${b.unknown.toFixed(2)} |`),
  '', '## Candidates', '', '| Row | Date | Amount | Type | Why |', '|---|---|---:|---|---|',
  ...found.map(({ r, c }) => `| ${r.id} | ${date(r)} | ${r.amount} ${r.currency || 'EUR'} | ${c!.ownerPayType} | ${c!.reason} |`),
  '', '## Tax rows with a derived tax type', '', '| Row | Date | Amount | Category now | Derived taxType |', '|---|---|---:|---|---|',
  ...taxRows.map(({ r, type, current }) => `| ${r.id} | ${date(r)} | ${r.amount} | ${current} | ${type} |`),
  '',
];
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}: ${found.length} owner pay candidates, ${taxRows.length} tax rows`);
