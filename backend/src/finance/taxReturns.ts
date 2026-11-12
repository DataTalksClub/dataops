import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_BOOKKEEPING } from '../db/tableNames';

/**
 * The official figures of a filed tax year, one TAX_RETURN#<year> item per
 * year, entered from the Bescheide and filed returns once the Finanzamt has
 * assessed them. A stored record marks the year as closed: its numbers are
 * facts, not estimates, and the planning blocks (upcoming debits, balance
 * check, safe-to-withdraw) do not apply to it. Figures in EUR.
 */
export type TaxReturnRecord = {
  year: number;
  /** A closed year has final Bescheide; open years can carry draft figures. */
  closed: boolean;
  assessed: {
    /** Festgesetzte Einkommensteuer and Solidaritätszuschlag. */
    incomeTax: number;
    soli: number;
    /** Festgesetzte Gewerbesteuer. */
    tradeTax: number;
    /** USt from the filed return or the FA Mitteilung. */
    vat: number;
  };
  paid: {
    /** ESt/Soli Vorauszahlungen actually debited for this year. */
    incomeTax: number;
    soli: number;
    /** GewSt Vorauszahlungen actually debited for this year. */
    tradeTax: number;
    /** USt Vorauszahlungssoll plus Abschlusszahlung paid for this year. */
    vat: number;
  };
  /** Cash refunded for this year (ESt+Soli incl. Zinsen, USt Erstattung). */
  refunded: number;
  /** When the refund was paid out to the bank account, if it was. */
  refundedOn?: string;
  /** Overpayments carried to another year instead of being paid out. */
  offsets?: { amount: number; target: string }[];
  notes: string[];
  /** Where every number comes from: Bescheid names and dates. */
  sources: string[];
};

const key = (year: number) => ({ PK: `TAX_RETURN#${year}`, SK: `TAX_RETURN#${year}` });

const isMoney = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
  && Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

function validateMoneyGroup(value: unknown, errors: string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object with incomeTax, soli, tradeTax, vat numbers`);
    return;
  }
  for (const field of ['incomeTax', 'soli', 'tradeTax', 'vat']) {
    if (!isMoney((value as Record<string, unknown>)[field])) errors.push(`${label}.${field} must be a EUR amount ≥ 0`);
  }
}

export function validateTaxReturnRecord(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(value.year) || (value.year as number) < 2024) errors.push('year must be a whole number ≥ 2024');
  if (typeof value.closed !== 'boolean') errors.push('closed must be a boolean');
  validateMoneyGroup(value.assessed, errors, 'assessed');
  validateMoneyGroup(value.paid, errors, 'paid');
  if (!isMoney(value.refunded)) errors.push('refunded must be a EUR amount ≥ 0');
  if (value.refundedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(value.refundedOn))) errors.push('refundedOn must be YYYY-MM-DD');
  if (value.notes !== undefined && (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== 'string'))) errors.push('notes must be an array of strings');
  if (value.offsets !== undefined) {
    if (!Array.isArray(value.offsets)) errors.push('offsets must be an array');
    else for (const offset of value.offsets) {
      if (!offset || typeof offset !== 'object' || !isMoney((offset as Record<string, unknown>).amount) || typeof (offset as Record<string, unknown>).target !== 'string') {
        errors.push('each offset needs an amount and a target');
      }
    }
  }
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.some((source) => typeof source !== 'string')) {
    errors.push('sources must be a non-empty array of strings');
  }
  return errors;
}

export async function listTaxReturns(client: DynamoDBDocumentClient): Promise<TaxReturnRecord[]> {
  const out: TaxReturnRecord[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_BOOKKEEPING,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'TAX_RETURN#' },
      ExclusiveStartKey,
    }));
    for (const { PK: _pk, SK: _sk, version: _version, updatedAt: _at, updatedBy: _by, ...item } of result.Items || []) {
      out.push(item as TaxReturnRecord);
    }
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out.sort((a, b) => a.year - b.year);
}

export async function getTaxReturn(client: DynamoDBDocumentClient, year: number): Promise<TaxReturnRecord | null> {
  const stored = await listTaxReturns(client);
  return stored.find((record) => record.year === year) || null;
}

/** Create or replace one year's record. Replaces without versioning: the Bescheid data is authoritative. */
export async function putTaxReturn(client: DynamoDBDocumentClient, record: TaxReturnRecord, actor = 'unknown'): Promise<TaxReturnRecord> {
  const item = {
    ...key(record.year),
    ...record,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  await client.send(new PutCommand({ TableName: TABLE_BOOKKEEPING, Item: item }));
  const { PK: _pk, SK: _sk, updatedAt: _at, updatedBy: _by, ...stored } = item;
  return stored as TaxReturnRecord;
}
