import type { StatementRecord } from "./service";
import { rowKeys } from "./service";
import { bankKeyFor } from "./month";
import type { StatementRow, StatementBalance } from "./parsers";

export type StatementSelection = Record<string, Array<{ id: string; from: string; to: string }>>;
export const walletKey = (record: Pick<StatementRecord, "accountId" | "bankAccounts" | "id">, row: Pick<StatementRow, "wallet" | "currency">) => `${record.accountId}|${record.bankAccounts?.[`${row.wallet || "main"}|${row.currency}`] || `unverified:${record.id}`}|${row.wallet || "main"}|${row.currency}`;
export const overlaps = (a: { from?: string; to?: string }, b: { from?: string; to?: string }) => !!(a.from && a.to && b.from && b.to && a.from <= b.to && b.from <= a.to);

export class StatementAccountCollisionError extends Error {
  statusCode = 409;
  constructor(readonly identityConflicts: Array<{ kind: "operation" | "balance"; bank: string; currency: string; wallet: string; sourceIds: string[] }>) {
    super("Distinct bank accounts would share an existing reconciliation operation or balance key. No active statement changed. Keep the existing sources; account-key migration is required before activating the additional account.");
  }
}

/** Prevent silent collapse until existing bank-row and balance keys can be migrated safely. */
export function assertNoStatementAccountCollisions(records: StatementRecord[]) {
  const operations = new Map<string, { fingerprint: string; id: string }>();
  const balances = new Map<string, { fingerprint: string; id: string }>();
  const conflicts: ConstructorParameters<typeof StatementAccountCollisionError>[0] = [];
  for (const record of records) {
    const keys = rowKeys(record.rows);
    for (const [index, row] of record.rows.entries()) {
      const fingerprint = record.bankAccounts?.[`${row.wallet || "main"}|${row.currency}`];
      if (!fingerprint) continue;
      const key = bankKeyFor(record.accountId, keys[index]), existing = operations.get(key);
      if (existing && existing.fingerprint !== fingerprint) conflicts.push({ kind: "operation", bank: record.accountId, currency: row.currency, wallet: row.wallet || "main", sourceIds: [existing.id, record.id] });
      else operations.set(key, { fingerprint, id: record.id });
    }
    for (const balance of record.balances || []) {
      const fingerprint = record.bankAccounts?.[`${balance.wallet || "main"}|${balance.currency}`];
      if (!fingerprint) continue;
      const key = `${record.accountId}|${balance.wallet || ""}|${balance.currency}`, existing = balances.get(key);
      if (existing && existing.fingerprint !== fingerprint) conflicts.push({ kind: "balance", bank: record.accountId, currency: balance.currency, wallet: balance.wallet || "main", sourceIds: [existing.id, record.id] });
      else balances.set(key, { fingerprint, id: record.id });
    }
  }
  if (conflicts.length) throw new StatementAccountCollisionError(conflicts);
}

/** Earliest retained source is the default; an explicit month selection wins. */
export function defaultStatementSelection(records: StatementRecord[]): StatementSelection {
  const selected: StatementSelection = {};
  for (const record of [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    for (const key of new Set([...record.rows, ...(record.balances || [])].map((row) => walletKey(record, row)))) {
      const sources = selected[key] ||= [];
      if (!sources.some((source) => overlaps(source, record))) sources.push({ id: record.id, from: record.from!, to: record.to! });
    }
  }
  return selected;
}

export function selectedStatementRecords(records: StatementRecord[], selection: StatementSelection): StatementRecord[] {
  return records.flatMap((record) => {
    const keys = new Set(Object.entries(selection).filter(([, sources]) => sources.some((source) => source.id === record.id)).map(([key]) => key));
    const rows = record.rows.filter((row) => keys.has(walletKey(record, row)));
    const balances = (record.balances || []).filter((row) => keys.has(walletKey(record, row)));
    return rows.length || balances.length ? [{ ...record, rows, balances }] : [];
  });
}

/** Resolve previously unverified selection keys from the source's verified header identity. */
export function verifiedStatementSelection(selection: StatementSelection, before: StatementRecord[], verified: StatementRecord[]): StatementSelection {
  const resolved: StatementSelection = {};
  const refs = Object.entries(selection).flatMap(([key, sources]) => sources.map((source) => ({ key, source })));
  refs.sort((a, b) => Number(a.key.includes("|unverified:")) - Number(b.key.includes("|unverified:"))
    || String(before.find((record) => record.id === a.source.id)?.createdAt || "").localeCompare(String(before.find((record) => record.id === b.source.id)?.createdAt || ""))
    || a.source.id.localeCompare(b.source.id));
  for (const { key, source } of refs) {
    const original = before.find((record) => record.id === source.id), checked = verified.find((record) => record.id === source.id);
    const row = original && [...original.rows, ...(original.balances || [])].find((row) => walletKey(original, row) === key);
    const destination = checked && row ? walletKey(checked, row) : key;
    const candidates = resolved[destination] ||= [];
    const bounds = checked ? { id: source.id, from: checked.from!, to: checked.to! } : source;
    if (!candidates.some((candidate) => overlaps(candidate, bounds))) candidates.push(bounds);
  }
  return resolved;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Compare sorted multisets, preserving repeated equal operations. */
export function statementDifferences(existing: StatementRecord[], candidate: StatementRecord) {
  const before = existing.flatMap((record) => record.rows);
  const counts = (rows: StatementRow[]) => {
    const result = new Map<string, { row: StatementRow; count: number }>();
    for (const row of rows) {
      const key = canonical(row), entry = result.get(key);
      result.set(key, { row, count: (entry?.count || 0) + 1 });
    }
    return result;
  };
  const old = counts(before), next = counts(candidate.rows);
  const removed = [...old].flatMap(([key, item]) => item.count > (next.get(key)?.count || 0) ? [{ row: item.row, count: item.count - (next.get(key)?.count || 0) }] : []);
  const added = [...next].flatMap(([key, item]) => item.count > (old.get(key)?.count || 0) ? [{ row: item.row, count: item.count - (old.get(key)?.count || 0) }] : []);
  const balances = (items: StatementBalance[]) => items.map(canonical).sort();
  const openingBalancesChanged = canonical(existing.flatMap((record) => record.openingBalances || []).map(canonical).sort()) !== canonical((candidate.openingBalances || []).map(canonical).sort());
  const balancesChanged = openingBalancesChanged || canonical(balances(existing.flatMap((record) => record.balances || []))) !== canonical(balances(candidate.balances || []));
  const periodChanged = existing.some((record) => record.from !== candidate.from || record.to !== candidate.to);
  return { identical: !removed.length && !added.length && !balancesChanged && !periodChanged, added, removed, balancesChanged, periodChanged, openingBalancesChanged,
    existing: existing.map((record) => ({ id: record.id, issueDate: record.issueDate, from: record.from, to: record.to, balances: record.balances, openingBalances: record.openingBalances })),
    candidate: { issueDate: candidate.issueDate, from: candidate.from, to: candidate.to, balances: candidate.balances, openingBalances: candidate.openingBalances } };
}

export { canonical as canonicalStatementValue };
