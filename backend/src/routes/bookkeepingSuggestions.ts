// Matching suggestions for one transaction: invoices or receipts that are
// not attached to anything yet, and sponsor deals still waiting for money.
// Suggestions only; the operator attaches a document or links a deal payment.
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  getBookkeepingItem,
  getRawDocument,
  listBookkeepingItems,
  setDocumentFacts,
  transactionSponsorDeal,
} from "../db/bookkeeping";
import { extractInvoiceText, pdfText } from "../invoices/extract";
import { financeLedger, type LedgerRow } from "../sponsorFinance/ledger";
import { financeEnabled } from "../sponsorFinance/repository";
import { json, publicDocument, s3 } from "./bookkeepingShared";

type Record_ = Record<string, unknown>;
export type DocumentFacts = {
  transactionDate?: string;
  paidDate?: string;
  amount?: string;
  currency?: string;
  counterparty?: string;
  invoiceNumber?: string;
  method: string;
  reason?: string;
  extractedAt: string;
};

const DAY = 86_400_000;
const days = (a?: unknown, b?: unknown) => {
  const left = Date.parse(String(a || "")), right = Date.parse(String(b || ""));
  return Number.isFinite(left) && Number.isFinite(right) ? Math.round(Math.abs(left - right) / DAY) : null;
};
// Words that say nothing about who the provider is.
const NOISE = new Set([
  "inc", "ltd", "llc", "gmbh", "corp", "the", "and", "for", "limited", "company", "services",
  "service", "online", "payment", "payments", "invoice", "via", "com", "www", "technologies",
]);
export function nameTokens(value: unknown) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !NOISE.has(word)),
  );
}
const sharesName = (left: unknown, right: unknown) => {
  const words = nameTokens(right);
  return [...nameTokens(left)].some((word) => words.has(word));
};
const near = (left: unknown, right: unknown, tolerance: number) => {
  const a = Number(left), b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 && Math.abs(a - b) <= Math.max(0.01, b * tolerance);
};

/** How well an unattached document's facts fit a transaction, with reasons. */
export function scoreDocument(transaction: Record_, facts: DocumentFacts) {
  const reasons: string[] = [];
  let score = 0;
  const original = facts.currency === transaction.currency && near(facts.amount, transaction.amount, 0);
  const converted = facts.currency === "EUR" && near(facts.amount, transaction.amountEur, 0);
  const close = !original && !converted && facts.currency === transaction.currency && near(facts.amount, transaction.amount, 0.02);
  if (original || converted) {
    score += 3;
    reasons.push("same amount");
  } else if (close) {
    score += 1;
    reasons.push("similar amount");
  }
  const named = sharesName(facts.counterparty, `${transaction.counterparty} ${transaction.description}`);
  if (named) {
    score += 2;
    reasons.push("provider matches");
  }
  const gap = [facts.transactionDate, facts.paidDate]
    .map((date) => [transaction.transactionDate, transaction.paidDate].map((other) => days(date, other)))
    .flat()
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)[0];
  if (gap !== undefined) {
    if (gap > 120) return null;
    if (gap <= 5) {
      score += 2;
      reasons.push(gap === 0 ? "same date" : `${gap} day${gap === 1 ? "" : "s"} apart`);
    } else if (gap <= 40) {
      score += 1;
      reasons.push(`${gap} days apart`);
    }
  }
  if (!(original || converted || named) || score < 3) return null;
  return { score, reasons, gap: gap ?? 999 };
}

/** How well a sponsor deal still waiting for payment fits an income transaction. */
export function scoreSponsorDeal(transaction: Record_, row: LedgerRow) {
  if (transaction.entryType !== "income") return null;
  const sameCurrency = row.currency === transaction.currency;
  // A payment recorded from a bank report before its row existed: this row confirms it.
  const recorded = sameCurrency
    ? row.recordedPayments?.find(
        (payment) => near(transaction.amount, payment.amount, 0) && (days(transaction.transactionDate, payment.receivedOn) ?? 99) <= 14,
      )
    : undefined;
  if (!recorded && !["unpaid", "partially-paid"].includes(row.paymentState)) return null;
  const reasons: string[] = [];
  let score = 0;
  const amount = recorded || (sameCurrency && (near(transaction.amount, row.outstanding, 0.01) || near(transaction.amount, row.amountDue, 0.01)));
  if (recorded) {
    score += 3;
    reasons.push(`confirms the payment recorded on ${recorded.receivedOn}`);
  } else if (amount) {
    score += 3;
    reasons.push(row.paymentState === "partially-paid" ? "matches the outstanding amount" : "same amount");
  }
  const named = sharesName(row.organizationName, `${transaction.counterparty} ${transaction.description}`);
  if (named) {
    score += 3;
    reasons.push("sponsor name matches");
  }
  const gap = days(transaction.transactionDate, row.dueOn || row.issuedOn || row.deliveredOn);
  if (!recorded && gap !== null && gap <= 60) {
    score += 1;
    reasons.push("around the due date");
  }
  if (!amount && !named) return null;
  return { score, reasons, ...(recorded ? { replacesPaymentId: recorded.id } : {}) };
}

async function readPdf(document: Record_) {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: process.env.BOOKKEEPING_DOCUMENTS_BUCKET, Key: String(document.s3Key) }),
  );
  if (!object.Body) throw new Error("document-object-missing");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of object.Body as unknown as AsyncIterable<Uint8Array>) {
    size += part.length;
    if (size > Number(process.env.BOOKKEEPING_PDF_MAX_BYTES || 20 * 1024 * 1024)) throw new Error("object-size-limit");
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

/** Read a document's PDF once and keep its date, amount and provider. */
export async function extractDocumentFacts(client: DynamoDBDocumentClient, id: string) {
  const document = await getRawDocument(client, id);
  if (!document || document.status !== "active") return null;
  const facts: DocumentFacts = { method: "unreadable", extractedAt: new Date().toISOString() };
  // A storage failure is retried by the caller; only the PDF itself can be unreadable.
  const bytes = await readPdf(document);
  try {
    const { fields, extraction } = extractInvoiceText(await pdfText(bytes));
    facts.method = extraction.method;
    for (const field of ["transactionDate", "paidDate", "amount", "currency", "counterparty", "invoiceNumber"] as const)
      if (fields[field]) facts[field] = String(fields[field]);
  } catch (error) {
    facts.reason = `${(error as Error).name}: ${String((error as Error).message).slice(0, 120)}`;
    console.error(JSON.stringify({ message: "bookkeeping document unreadable", documentId: id, reason: facts.reason }));
  }
  await setDocumentFacts(client, id, facts);
  return { ...publicDocument(document), facts };
}

export async function transactionSuggestions(client: DynamoDBDocumentClient, transaction: Record_) {
  const documents = (await listBookkeepingItems(client, "document"))
    .filter((document) =>
      document.status === "active" &&
      ["invoice", "receipt"].includes(String(document.documentType)) &&
      !Number(document.linkRefCount || 0) &&
      document.facts,
    )
    .map((document) => ({ document, match: scoreDocument(transaction, document.facts as DocumentFacts) }))
    .filter((entry) => entry.match)
    .sort((a, b) => b.match!.score - a.match!.score || a.match!.gap - b.match!.gap)
    .slice(0, 5)
    .map(({ document, match }) => ({
      id: document.id,
      documentType: document.documentType,
      facts: document.facts,
      score: match!.score,
      reasons: match!.reasons,
    }));
  let sponsor: { linkedDealId: string | null; deals: unknown[] } = { linkedDealId: null, deals: [] };
  if (transaction.entryType === "income" && financeEnabled()) {
    const linkedDealId = await transactionSponsorDeal(client, String(transaction.id));
    const deals = linkedDealId
      ? []
      : (await financeLedger(client)).rows
          .map((row) => ({ row, match: scoreSponsorDeal(transaction, row) }))
          .filter((entry) => entry.match)
          .sort((a, b) => b.match!.score - a.match!.score)
          .slice(0, 3)
          .map(({ row, match }) => ({
            dealId: row.dealId,
            organizationName: row.organizationName,
            dealTitle: row.dealTitle,
            amountDue: row.amountDue,
            outstanding: row.outstanding,
            currency: row.currency,
            dueOn: row.dueOn,
            paymentState: row.paymentState,
            ...(match!.replacesPaymentId ? { replacesPaymentId: match!.replacesPaymentId } : {}),
            score: match!.score,
            reasons: match!.reasons,
          }));
    sponsor = { linkedDealId, deals };
  }
  return { documents, sponsor };
}

export async function handleBookkeepingSuggestionRoutes(
  path: string,
  method: string,
  _event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const suggestions = path.match(/^\/api\/bookkeeping\/transactions\/([^/]+)\/suggestions$/);
  if (suggestions && method === "GET") {
    const transaction = await getBookkeepingItem(client, "bookkeeping", suggestions[1]);
    if (!transaction) return json(404, { error: "Not found" });
    return json(200, await transactionSuggestions(client, transaction));
  }
  const facts = path.match(/^\/api\/bookkeeping\/documents\/([^/]+)\/facts$/);
  if (facts && method === "POST") {
    try {
      const document = await extractDocumentFacts(client, facts[1]);
      return document ? json(200, document) : json(404, { error: "Document not found" });
    } catch (error) {
      console.error(JSON.stringify({ message: "bookkeeping document facts failed", error: String(error) }));
      return json(503, { error: "Document could not be read; retry" });
    }
  }
  return null;
}
