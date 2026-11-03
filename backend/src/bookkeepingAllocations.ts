import { canonicalBookkeepingCounterparty } from "./bookkeepingVendors";

export interface BookkeepingInvoiceAllocation {
  id: string;
  documentId: string;
  invoiceId?: string;
  invoiceNumber?: string;
  counterparty: string;
  counterpartyCanonical: string;
  description: string;
  amount: string;
  currency: string;
  amountEur?: string;
  vatAmount?: string;
  vatCurrency?: string;
  category?: string;
  subtype?: string;
  transactionDate?: string;
  paidDate?: string;
}

export class AllocationValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AllocationValidationError";
    this.status = status;
  }
}

const STRICT_TWO_DECIMAL_RE = /^\d+(?:\.\d{1,2})?$/;
const MORE_THAN_TWO_DECIMALS_RE = /^\d+\.\d{3,}$/;

export function parseStrictAllocationCents(
  rawValue: unknown,
  fieldLabel = "amount",
): { cents: number; formatted: string } {
  if (typeof rawValue === "number") {
    if (!Number.isFinite(rawValue)) {
      throw new AllocationValidationError(`Invalid ${fieldLabel}: must be a finite amount.`);
    }
    if (rawValue <= 0) {
      throw new AllocationValidationError(`Invalid ${fieldLabel}: amount must be greater than zero.`);
    }
    const text = String(rawValue);
    if (/[eE]/.test(text) || MORE_THAN_TWO_DECIMALS_RE.test(text)) {
      throw new AllocationValidationError(
        `Invoice allocation rejected due to rounding ambiguity in ${fieldLabel} "${text}": amounts must have at most 2 decimal places.`,
      );
    }
    const scaled = rawValue * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) {
      throw new AllocationValidationError(
        `Invoice allocation rejected due to rounding ambiguity in ${fieldLabel} "${text}": sub-cent precision is not allowed.`,
      );
    }
    return { cents: rounded, formatted: centsToFixed(rounded) };
  }

  const trimmed = String(rawValue ?? "").trim();
  if (!trimmed) {
    throw new AllocationValidationError(`Missing required ${fieldLabel}.`);
  }
  if (trimmed.startsWith("-")) {
    throw new AllocationValidationError(`Invalid ${fieldLabel} "${trimmed}": allocation amounts must be positive.`);
  }
  if (/[eE]/.test(trimmed) || MORE_THAN_TWO_DECIMALS_RE.test(trimmed)) {
    throw new AllocationValidationError(
      `Invoice allocation rejected due to rounding ambiguity in ${fieldLabel} "${trimmed}": amounts must have at most 2 decimal places.`,
    );
  }
  if (!STRICT_TWO_DECIMAL_RE.test(trimmed)) {
    throw new AllocationValidationError(`Invalid ${fieldLabel} "${trimmed}": expected decimal amount like 399.00.`);
  }
  const [wholePart, fracPart = ""] = trimmed.split(".");
  const cents = Number(wholePart) * 100 + Number((fracPart + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new AllocationValidationError(`Invalid ${fieldLabel} "${trimmed}": amount must be greater than zero.`);
  }
  return { cents, formatted: centsToFixed(cents) };
}

export function parseOptionalStrictNonNegativeCents(
  rawValue: unknown,
  fieldLabel: string,
): { cents: number; formatted: string } | undefined {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return undefined;
  }
  if (typeof rawValue === "number") {
    if (!Number.isFinite(rawValue) || rawValue < 0) {
      throw new AllocationValidationError(`Invalid ${fieldLabel}: must be a non-negative amount.`);
    }
    const text = String(rawValue);
    if (/[eE]/.test(text) || MORE_THAN_TWO_DECIMALS_RE.test(text)) {
      throw new AllocationValidationError(
        `Invoice allocation rejected due to rounding ambiguity in ${fieldLabel} "${text}": amounts must have at most 2 decimal places.`,
      );
    }
    const scaled = rawValue * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) {
      throw new AllocationValidationError(
        `Invoice allocation rejected due to rounding ambiguity in ${fieldLabel} "${text}": sub-cent precision is not allowed.`,
      );
    }
    return { cents: rounded, formatted: centsToFixed(rounded) };
  }
  const trimmed = String(rawValue).trim();
  if (trimmed.startsWith("-")) {
    throw new AllocationValidationError(`Invalid ${fieldLabel} "${trimmed}": must be non-negative.`);
  }
  if (/[eE]/.test(trimmed) || MORE_THAN_TWO_DECIMALS_RE.test(trimmed)) {
    throw new AllocationValidationError(
      `Invoice allocation rejected due to rounding ambiguity in ${fieldLabel} "${trimmed}": amounts must have at most 2 decimal places.`,
    );
  }
  if (!STRICT_TWO_DECIMAL_RE.test(trimmed)) {
    throw new AllocationValidationError(`Invalid ${fieldLabel} "${trimmed}": expected decimal amount.`);
  }
  const [wholePart, fracPart = ""] = trimmed.split(".");
  const cents = Number(wholePart) * 100 + Number((fracPart + "00").slice(0, 2));
  return { cents, formatted: centsToFixed(cents) };
}

export function centsToFixed(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

export interface AllocationDocumentContext {
  id: string;
  status?: string;
  documentType?: string;
  sha256?: string;
  originalFilename?: string;
  voidStatus?: string;
  facts?: Record<string, unknown>;
}

export interface ValidateAllocationsOptions {
  transaction: Record<string, unknown>;
  rawAllocations: unknown;
  documentsById: Map<string, AllocationDocumentContext>;
  otherAllocatedDocIds?: Map<string, string>;
  otherAllocatedInvoiceIds?: Map<string, string>;
  otherAllocatedSha256s?: Map<string, string>;
}

function normalizeInvoiceNo(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function validateAndNormalizeAllocations(
  options: ValidateAllocationsOptions,
): BookkeepingInvoiceAllocation[] {
  const {
    transaction,
    rawAllocations,
    documentsById,
    otherAllocatedDocIds = new Map(),
    otherAllocatedInvoiceIds = new Map(),
    otherAllocatedSha256s = new Map(),
  } = options;

  if (!Array.isArray(rawAllocations) || rawAllocations.length === 0) {
    throw new AllocationValidationError("At least one invoice allocation is required.");
  }

  const parentCurrency = String(transaction.currency || "EUR").trim().toUpperCase();
  const parentAmountParsed = parseStrictAllocationCents(transaction.amount, "transaction amount");
  const parentAmountEurParsed = parseOptionalStrictNonNegativeCents(
    transaction.amountEur,
    "transaction amountEur",
  );
  const parentCategory = String(transaction.category || "").trim();
  const parentSubtype = String(transaction.subtype || "").trim();
  const parentTxDate = String(transaction.transactionDate || transaction.paidDate || "").trim();
  const parentPaidDate = String(transaction.paidDate || transaction.transactionDate || "").trim();

  const seenDocumentIds = new Set<string>();
  const seenInvoiceIds = new Set<string>();
  const seenSha256s = new Set<string>();
  const seenVendorInvoiceNumbers = new Set<string>();

  const normalized: BookkeepingInvoiceAllocation[] = [];
  let sumCents = 0;
  let sumEurCents = 0;
  let explicitEurCount = 0;

  for (let index = 0; index < rawAllocations.length; index += 1) {
    const raw = rawAllocations[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AllocationValidationError(`Allocation #${index + 1} must be an object.`);
    }
    const item = raw as Record<string, unknown>;

    if (
      item.percentage !== undefined ||
      item.share !== undefined ||
      item.ratio !== undefined ||
      item.weight !== undefined
    ) {
      throw new AllocationValidationError(
        `Invoice allocation #${index + 1} rejected due to rounding ambiguity: specify exact invoice amounts instead of percentages or shares.`,
      );
    }

    const documentId = String(item.documentId || item.pdfDocumentId || "").trim();
    const invoiceId = String(item.invoiceId || "").trim() || undefined;
    if (!documentId) {
      throw new AllocationValidationError(
        `Allocation #${index + 1} is missing required documentId (each invoice row requires its own PDF document).`,
      );
    }

    if (seenDocumentIds.has(documentId)) {
      throw new AllocationValidationError(
        `Duplicate source allocation: document ${documentId} is allocated more than once.`,
      );
    }
    seenDocumentIds.add(documentId);

    if (invoiceId) {
      if (seenInvoiceIds.has(invoiceId)) {
        throw new AllocationValidationError(
          `Duplicate source allocation: invoice ${invoiceId} is allocated more than once.`,
        );
      }
      seenInvoiceIds.add(invoiceId);
    }

    const otherTxForDoc = otherAllocatedDocIds.get(documentId);
    if (otherTxForDoc) {
      throw new AllocationValidationError(
        `Duplicate source allocation: document ${documentId} is already allocated to transaction ${otherTxForDoc}.`,
        409,
      );
    }
    if (invoiceId) {
      const otherTxForInv = otherAllocatedInvoiceIds.get(invoiceId);
      if (otherTxForInv) {
        throw new AllocationValidationError(
          `Duplicate source allocation: invoice ${invoiceId} is already allocated to transaction ${otherTxForInv}.`,
          409,
        );
      }
    }

    const doc = documentsById.get(documentId);
    if (!doc) {
      throw new AllocationValidationError(`Allocated document ${documentId} not found.`, 404);
    }
    if (doc.status !== "active") {
      throw new AllocationValidationError(`Allocated document ${documentId} is not active.`, 409);
    }
    if (doc.voidStatus === "voided") {
      throw new AllocationValidationError(`Allocated document ${documentId} is voided.`, 409);
    }
    if (doc.documentType === "bank-statement" || doc.documentType === "private-account-statement") {
      throw new AllocationValidationError(
        `Allocated document ${documentId} is a statement (${doc.documentType}); invoice allocations require invoice/receipt PDFs.`,
      );
    }

    const sha256 = String(doc.sha256 || "").trim();
    if (sha256) {
      if (seenSha256s.has(sha256)) {
        throw new AllocationValidationError(
          `Duplicate source allocation: document ${documentId} shares identical PDF content (sha256) with another allocated invoice.`,
        );
      }
      seenSha256s.add(sha256);

      const otherTxForSha = otherAllocatedSha256s.get(sha256);
      if (otherTxForSha) {
        throw new AllocationValidationError(
          `Duplicate source allocation: PDF content for ${documentId} is already allocated to transaction ${otherTxForSha}.`,
          409,
        );
      }
    }

    const facts = doc.facts && typeof doc.facts === "object" ? doc.facts : {};
    const rawCurrency = String(item.currency || parentCurrency).trim().toUpperCase();
    if (rawCurrency !== parentCurrency) {
      throw new AllocationValidationError(
        `Allocation #${index + 1} currency ${rawCurrency} does not match payment currency ${parentCurrency}.`,
      );
    }

    const parsedAmount = parseStrictAllocationCents(
      item.amount,
      `allocation #${index + 1} amount`,
    );
    sumCents += parsedAmount.cents;

    const counterparty = String(
      item.counterparty ?? facts.counterparty ?? "",
    ).trim();
    if (!counterparty) {
      throw new AllocationValidationError(
        `Allocation #${index + 1} (${documentId}) requires a non-empty counterparty.`,
      );
    }
    const counterpartyCanonical = canonicalBookkeepingCounterparty(counterparty);

    const description = String(
      item.description ?? facts.description ?? "",
    ).trim();
    if (!description) {
      throw new AllocationValidationError(
        `Allocation #${index + 1} (${documentId}) requires a non-empty description.`,
      );
    }

    const invoiceNumber = String(
      item.invoiceNumber ?? facts.invoiceNumber ?? "",
    ).trim() || undefined;

    if (invoiceNumber) {
      const vendorInvKey = `${counterpartyCanonical.toLowerCase()}#${normalizeInvoiceNo(invoiceNumber)}`;
      if (seenVendorInvoiceNumbers.has(vendorInvKey)) {
        throw new AllocationValidationError(
          `Duplicate source allocation: invoice number ${invoiceNumber} for ${counterparty} is allocated more than once.`,
        );
      }
      seenVendorInvoiceNumbers.add(vendorInvKey);
    }

    const parsedAmountEur = parseOptionalStrictNonNegativeCents(
      item.amountEur,
      `allocation #${index + 1} amountEur`,
    );
    let amountEurFormatted: string | undefined;
    if (parsedAmountEur !== undefined) {
      if (parsedAmountEur.cents <= 0) {
        throw new AllocationValidationError(
          `Invalid allocation #${index + 1} amountEur: must be greater than zero.`,
        );
      }
      if (parentCurrency === "EUR" && parsedAmountEur.cents !== parsedAmount.cents) {
        throw new AllocationValidationError(
          `Allocation #${index + 1} amountEur (${parsedAmountEur.formatted}) must equal EUR amount (${parsedAmount.formatted}).`,
        );
      }
      amountEurFormatted = parsedAmountEur.formatted;
      sumEurCents += parsedAmountEur.cents;
      explicitEurCount += 1;
    } else if (parentCurrency === "EUR" && parentAmountEurParsed !== undefined) {
      amountEurFormatted = parsedAmount.formatted;
      sumEurCents += parsedAmount.cents;
      explicitEurCount += 1;
    } else if (parentCurrency !== "EUR" && parentAmountEurParsed !== undefined) {
      const numerator = parsedAmount.cents * parentAmountEurParsed.cents;
      if (numerator % parentAmountParsed.cents !== 0) {
        throw new AllocationValidationError(
          `Invoice allocation #${index + 1} rejected due to rounding ambiguity: foreign-currency payment requires explicit 2-decimal amountEur on each allocation when EUR conversion is not exact.`,
        );
      }
      const derivedEurCents = numerator / parentAmountParsed.cents;
      amountEurFormatted = centsToFixed(derivedEurCents);
      sumEurCents += derivedEurCents;
      explicitEurCount += 1;
    }

    const parsedVat = parseOptionalStrictNonNegativeCents(
      item.vatAmount,
      `allocation #${index + 1} vatAmount`,
    );
    const vatCurrency = parsedVat
      ? String(item.vatCurrency || parentCurrency).trim().toUpperCase()
      : undefined;

    const category = String(item.category ?? parentCategory).trim() || undefined;
    const subtype = String(item.subtype ?? parentSubtype).trim() || undefined;
    const transactionDate =
      String(item.transactionDate ?? item.date ?? facts.invoiceDate ?? parentTxDate).trim() ||
      undefined;
    const paidDate = String(item.paidDate ?? parentPaidDate).trim() || undefined;

    normalized.push({
      id: String(item.id || `alloc-${index + 1}`),
      documentId,
      ...(invoiceId ? { invoiceId } : {}),
      ...(invoiceNumber ? { invoiceNumber } : {}),
      counterparty,
      counterpartyCanonical,
      description,
      amount: parsedAmount.formatted,
      currency: parentCurrency,
      ...(amountEurFormatted !== undefined ? { amountEur: amountEurFormatted } : {}),
      ...(parsedVat !== undefined ? { vatAmount: parsedVat.formatted, vatCurrency } : {}),
      ...(category ? { category } : {}),
      ...(subtype ? { subtype } : {}),
      ...(transactionDate ? { transactionDate } : {}),
      ...(paidDate ? { paidDate } : {}),
    });
  }

  if (sumCents !== parentAmountParsed.cents) {
    throw new AllocationValidationError(
      `Allocation sum mismatch: allocations total ${centsToFixed(sumCents)} ${parentCurrency} does not match payment amount ${parentAmountParsed.formatted} ${parentCurrency}.`,
    );
  }

  if (explicitEurCount > 0 && explicitEurCount !== normalized.length) {
    throw new AllocationValidationError(
      "Invoice allocation rejected due to rounding ambiguity: provide amountEur on all allocations or none.",
    );
  }

  if (parentAmountEurParsed !== undefined && explicitEurCount > 0) {
    if (sumEurCents !== parentAmountEurParsed.cents) {
      throw new AllocationValidationError(
        `Allocation EUR sum mismatch: allocations EUR total ${centsToFixed(sumEurCents)} EUR does not match payment EUR amount ${parentAmountEurParsed.formatted} EUR.`,
      );
    }
  }

  return normalized;
}

export function readTransactionAllocations(
  transaction: Record<string, unknown> | null | undefined,
): BookkeepingInvoiceAllocation[] {
  if (!transaction || !Array.isArray(transaction.allocations)) return [];
  const result: BookkeepingInvoiceAllocation[] = [];
  const fallbackCurrency = String(transaction.currency || "EUR").trim().toUpperCase();
  for (let index = 0; index < transaction.allocations.length; index += 1) {
    const raw = transaction.allocations[index];
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const documentId = String(item.documentId || "").trim();
    const counterparty = String(item.counterparty || "").trim();
    const description = String(item.description || "").trim();
    const amount = String(item.amount || "").trim();
    if (!documentId || !counterparty || !description || !amount) continue;
    const currency = String(item.currency || fallbackCurrency).trim().toUpperCase();
    result.push({
      id: String(item.id || `alloc-${index + 1}`),
      documentId,
      ...(item.invoiceId ? { invoiceId: String(item.invoiceId).trim() } : {}),
      ...(item.invoiceNumber ? { invoiceNumber: String(item.invoiceNumber).trim() } : {}),
      counterparty,
      counterpartyCanonical:
        String(item.counterpartyCanonical || "").trim() ||
        canonicalBookkeepingCounterparty(counterparty),
      description,
      amount,
      currency,
      ...(item.amountEur !== undefined && String(item.amountEur).trim() !== ""
        ? { amountEur: String(item.amountEur).trim() }
        : {}),
      ...(item.vatAmount !== undefined && String(item.vatAmount).trim() !== ""
        ? { vatAmount: String(item.vatAmount).trim() }
        : {}),
      ...(item.vatCurrency ? { vatCurrency: String(item.vatCurrency).trim() } : {}),
      ...(item.category ? { category: String(item.category).trim() } : {}),
      ...(item.subtype ? { subtype: String(item.subtype).trim() } : {}),
      ...(item.transactionDate ? { transactionDate: String(item.transactionDate).trim() } : {}),
      ...(item.paidDate ? { paidDate: String(item.paidDate).trim() } : {}),
    });
  }
  return result;
}
