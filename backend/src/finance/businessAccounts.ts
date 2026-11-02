/**
 * The original setup flow created placeholder business-1/business-2 accounts.
 * They covered statements through September 2026, before the Revolut and Finom
 * accounts became the current statement sources.
 */
const LEGACY_STATEMENT_REQUIRED_THROUGH: Readonly<Record<string, string>> = {
  "business-1": "2026-09",
  "business-2": "2026-09",
};
const CURRENT_STATEMENT_REQUIRED_FROM: Readonly<Record<string, string>> = {
  revolut: "2026-10",
  finom: "2026-10",
};

export type BusinessAccountStatementRequirement = {
  id: string;
  requiredFromMonth?: string;
  requiredThroughMonth?: string;
};

export function statementRequiredThroughMonth(accountId: string): string | undefined {
  return LEGACY_STATEMENT_REQUIRED_THROUGH[accountId];
}

export function businessAccountStatementRequirement(accountId: string): BusinessAccountStatementRequirement {
  const requiredFromMonth = CURRENT_STATEMENT_REQUIRED_FROM[accountId];
  const requiredThroughMonth = statementRequiredThroughMonth(accountId);
  return {
    id: accountId,
    ...(requiredFromMonth ? { requiredFromMonth } : {}),
    ...(requiredThroughMonth ? { requiredThroughMonth } : {}),
  };
}

export function businessAccountRequiresStatement(accountId: string, month: string): boolean {
  const requiredFromMonth = CURRENT_STATEMENT_REQUIRED_FROM[accountId];
  const requiredThroughMonth = statementRequiredThroughMonth(accountId);
  return (requiredFromMonth === undefined || month >= requiredFromMonth)
    && (requiredThroughMonth === undefined || month <= requiredThroughMonth);
}

export function businessAccountStatementMetadata(accountId: string): Record<string, string> {
  const requiredFromMonth = CURRENT_STATEMENT_REQUIRED_FROM[accountId];
  const requiredThroughMonth = statementRequiredThroughMonth(accountId);
  return {
    ...(requiredFromMonth ? { statementRequiredFromMonth: requiredFromMonth } : {}),
    ...(requiredThroughMonth ? { statementRequiredThroughMonth: requiredThroughMonth } : {}),
  };
}
