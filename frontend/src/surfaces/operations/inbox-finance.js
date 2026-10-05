export const INVOICE_INTAKE_ROUTES = [
  "invoice",
  "receipts",
  "invoice-attachment",
  "invoice-pdf",
];

export function isInvoiceRouteIntake(item) {
  return INVOICE_INTAKE_ROUTES.includes(
    String(item?.metadata?.recipientRoute || "").toLowerCase(),
  );
}
