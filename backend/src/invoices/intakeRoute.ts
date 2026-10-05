export const INVOICE_INTAKE_ROUTES = [
  'invoice',
  'receipts',
  'invoice-attachment',
  'invoice-pdf',
] as const;

export type InvoiceIntakeRoute = (typeof INVOICE_INTAKE_ROUTES)[number];

export function isInvoiceIntakeRoute(route: unknown): route is InvoiceIntakeRoute {
  return (INVOICE_INTAKE_ROUTES as readonly string[]).includes(String(route || '').toLowerCase());
}

export function isInvoiceRouteIntake(
  item: { metadata?: Record<string, unknown> } | null | undefined,
): boolean {
  return isInvoiceIntakeRoute(item?.metadata?.recipientRoute);
}
