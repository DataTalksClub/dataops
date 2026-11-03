import {
  BOOKKEEPING_AUDIT_PARTITION_PREFIX,
  BOOKKEEPING_AUDIT_STORAGE_VERSION,
  BookkeepingAuditIntegrityError,
  bookkeepingAuditEvents,
  type BookkeepingAuditRow,
} from "../bookkeepingAudit";

export function bookkeepingAuditSnapshotErrors(records: Record<string, unknown>[]): string[] {
  const transactions = new Map<string, Record<string, unknown>>();
  const rowsByTransaction = new Map<string, BookkeepingAuditRow[]>();
  const errors: string[] = [];

  for (const record of records) {
    const pk = String(record.PK || "");
    if (pk.startsWith("BOOKKEEPING#") && record.SK === record.PK) {
      transactions.set(pk.slice("BOOKKEEPING#".length), record);
      continue;
    }
    if (!pk.startsWith(BOOKKEEPING_AUDIT_PARTITION_PREFIX)) continue;
    const transactionId = pk.slice(BOOKKEEPING_AUDIT_PARTITION_PREFIX.length);
    if (!transactionId) {
      errors.push("bookkeeping audit export contains an empty transaction partition");
      continue;
    }
    const rows = rowsByTransaction.get(transactionId) || [];
    rows.push(record as BookkeepingAuditRow);
    rowsByTransaction.set(transactionId, rows);
  }

  for (const [transactionId, rows] of rowsByTransaction) {
    const transaction = transactions.get(transactionId);
    if (!transaction || transaction.auditStorageVersion !== BOOKKEEPING_AUDIT_STORAGE_VERSION) {
      errors.push("bookkeeping audit export contains sidecar rows without a migrated transaction");
    }
  }

  for (const [transactionId, transaction] of transactions) {
    if (transaction.auditStorageVersion === undefined) continue;
    if (transaction.auditStorageVersion !== BOOKKEEPING_AUDIT_STORAGE_VERSION) {
      errors.push("bookkeeping audit export contains an unsupported storage version");
      continue;
    }
    if (transaction.audit !== undefined) {
      errors.push("migrated bookkeeping transaction still contains inline audit data");
      continue;
    }
    try {
      bookkeepingAuditEvents(transaction, rowsByTransaction.get(transactionId) || []);
    } catch (error) {
      if (error instanceof BookkeepingAuditIntegrityError) {
        errors.push("bookkeeping audit export is incomplete or inconsistent");
      } else {
        errors.push("bookkeeping audit export could not be checked");
      }
    }
  }

  return errors;
}
