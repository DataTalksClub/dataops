/**
 * Canonical expense category vocabulary, aligned with the backend and
 * `sop.finance.bookkeeping.monthly-bookkeeping-report-and-reconciliation`.
 */
export const CANONICAL_EXPENSE_CATEGORIES = Object.freeze([
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
]);

export function expenseCategoryFilterOptions(categories) {
  return [...new Set([...CANONICAL_EXPENSE_CATEGORIES, ...categories])].sort((a, b) => a.localeCompare(b));
}
