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
  allowEmpty?: boolean;
};

export type ExpenseCategoryValidationResult =
  | { ok: true; category?: string }
  | { ok: false; error: string };

/** Validate expense assignments against the SOP vocabulary; income and unassigned drafts are unrestricted. */
export function validateExpenseCategoryAssignment({
  category,
  entryType,
  allowEmpty = true,
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
      error: `Expense category is required. Allowed categories: ${CANONICAL_EXPENSE_CATEGORIES.join(", ")}`,
    };
  }

  if ((CANONICAL_EXPENSE_CATEGORIES as readonly string[]).includes(trimmed)) {
    return { ok: true, category: trimmed };
  }

  return {
    ok: false,
    error: `Invalid expense category "${trimmed}". Allowed categories: ${CANONICAL_EXPENSE_CATEGORIES.join(", ")}`,
  };
}
