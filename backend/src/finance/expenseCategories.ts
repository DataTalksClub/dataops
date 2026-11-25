/**
 * Canonical expense category vocabulary and validation.
 *
 * Sourced from the live canonical bookkeeping SOP:
 * `sop.finance.bookkeeping.monthly-bookkeeping-report-and-reconciliation`
 * (confirmed via intake f92086a5-e7fe-48a4-9190-e2c45a0d8d4b).
 */

export const CANONICAL_EXPENSE_CATEGORIES = [
  "AI Tools",
  "Bank fees",
  "Business Software",
  "Calls",
  "Charity",
  "Compliance & Taxes",
  "Event Tools",
  "Freelance & Contractors",
  "Hardware & Equipment",
  "Health Insurance",
  "Infrastructure",
  "Meals & Community",
  "Newsletter platform",
  "Professional Development",
  "Refund",
  "Social Media & Marketing",
  "Storage",
  "Taxes",
  "Travel",
  "Video recording",
  "Web Hosting & Domains",
] as const;

/**
 * Non-operating / special bookkeeping categories with dedicated VAT,
 * owner-pay, or report-exemption semantics that are preserved alongside
 * the canonical expense categories.
 */
export const SPECIAL_NON_OPERATING_EXPENSE_CATEGORIES = [
  "VAT",
  "Owner pay",
  "Owner withdrawal",
] as const;

export class InvalidExpenseCategoryError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidExpenseCategoryError";
  }
}

export type ExpenseCategoryValidationInput = {
  category?: unknown;
  entryType?: unknown;
  previousCategory?: unknown;
  allowEmpty?: boolean;
  canonicalCategories?: readonly string[];
  specialCategories?: readonly string[];
};

export type ExpenseCategoryValidationResult =
  | { ok: true; category?: string }
  | { ok: false; error: string };

/**
 * Validate an expense category assignment against the closed canonical
 * vocabulary while preserving:
 * - income / non-expense rows,
 * - drafts with no category awaiting verification (`allowEmpty`),
 * - unrelated edits to legacy rows whose category is unchanged,
 * - special VAT, tax, health-insurance, owner-pay, bank-fee, and refund rows.
 */
export function validateExpenseCategoryAssignment({
  category,
  entryType,
  previousCategory,
  allowEmpty = true,
  canonicalCategories = CANONICAL_EXPENSE_CATEGORIES,
  specialCategories = SPECIAL_NON_OPERATING_EXPENSE_CATEGORIES,
}: ExpenseCategoryValidationInput): ExpenseCategoryValidationResult {
  if (entryType === "income") {
    const trimmedIncome = category == null ? "" : String(category).trim();
    return { ok: true, ...(trimmedIncome ? { category: trimmedIncome } : {}) };
  }

  const trimmed = category == null ? "" : String(category).trim();
  if (!trimmed) {
    if (allowEmpty) return { ok: true };
    return {
      ok: false,
      error: `Expense category is required. Allowed categories: ${canonicalCategories.join(", ")}`,
    };
  }

  const prevTrimmed = previousCategory == null ? "" : String(previousCategory).trim();
  if (prevTrimmed && trimmed === prevTrimmed) {
    return { ok: true, category: trimmed };
  }

  if (canonicalCategories.includes(trimmed) || specialCategories.includes(trimmed)) {
    return { ok: true, category: trimmed };
  }

  return {
    ok: false,
    error: `Invalid expense category "${trimmed}". Allowed categories: ${canonicalCategories.join(", ")}`,
  };
}
