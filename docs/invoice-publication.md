# Invoice review and publication

Invoice email transport and OAuth ownership stay in Dapier. DataOps verifies and imports each original PDF, stages a sensitive expense draft, and exposes the same review actions in Finance, `/api/bookkeeping/invoices`, and `dataops invoices`.

Supported AWS and Stripe invoice/receipt layouts use bounded PDF.js text extraction. Unknown, scanned or ambiguous layouts remain editable manual drafts. Source integrity failures block staging or both publications. A receipt's displayed EUR tax conversion does not establish the bank payment amount. Review requires invoice/account identity, actual payment date, actual EUR amount and an explicit payment evidence note. All drafts require confirmation of their current revision. Rejected or unconfirmed drafts cannot publish or enter the confirmed ledger.

Configure publication through the standard app CI/CD path. Set repository Actions secret `INVOICE_PUBLICATION_CONFIG` to private JSON containing these keys:

```json
{
  "brokerUrl": "https://broker.example.invalid",
  "brokerCredential": "<dedicated machine API credential>",
  "agent": "dataops-invoice-publication",
  "googleConnection": "google-sheets",
  "googleAccountId": "<verified provider account>",
  "dropboxConnection": "dropbox",
  "dropboxAccountId": "<verified provider account>",
  "spreadsheetId": "<verified existing native spreadsheet>",
  "sheetTab": "<reviewed year tab>",
  "dropboxRoot": "/<verified expense archive>",
  "monthFolderPrefix": "workspace-"
}
```

The deploy workflow base64-encodes and masks the parameter to preserve JSON commas through SAM CLI parsing. `InvoicePublicationConfig` is a `NoEcho` parameter; the optional declared `InvoicePublicationSecret` stores that value, and `INVOICE_PUBLICATION_SECRET_NAME` identifies it to the runtime. The runtime decodes the secret, requests bounded short-lived provider tokens from `/api/agent/token`, verifies the configured account IDs and scopes, and keeps refresh tokens in Dapier. No local AWS credentials or runtime infrastructure creation is needed. An empty Actions secret disables publication; ingestion/manual review remain available. Private credentials, account IDs and destinations belong only in the managed configuration, never in docs or issue comments.

Provision a dedicated Dapier agent-bound machine token and only `use` grants for the configured Google and Dropbox connections via their supported Console/CLI/API. Required scopes are `https://www.googleapis.com/auth/spreadsheets`, `files.content.write`, `files.content.read`, and `files.metadata.read`. Existing consent with those scopes needs no renewal. Verify `dataops invoices readiness` under an authenticated DataOps account; broker authentication cannot substitute for DataOps operator authorization. Readiness verifies scoped account tokens, the actual tab headers and configured archive folder without returning secrets.

Current target headers are read dynamically. Required headers are Date sent, Date paid, Provider, What, Price, $, Price, EUR, Statement, Count, Entry Type, Type, Period and Category (the money headers contain literal commas). Optional Comment is mapped when present. Money and count are provider numeric values; expense amounts are negative, and EUR-only records leave USD blank. Writes affect a reserved empty row only. Unrelated rows, formatting, formulas and tabs remain intact. An operation marker and source document reference in Statement provide reconciliation identity.

Archive paths follow the configured `root/YYYY/prefixYYYY-MM/date-vendor-invoiceIdentity.pdf` layout. Each attachment gets its own original PDF. A reviewed recurring-payment archive exception requires `archiveRequired=false` and an explicit reason; it never hardcodes a counterparty. Archive folder creation stays within the configured root. Deterministic filenames refuse overwrite and read-back verifies SHA-256 bytes. Spreadsheet completion requires matching row read-back; timeout outcomes remain unknown until reconciliation. Retry reconciles each destination independently, and atomic invoice identity/revision/publication claims plus durable row reservations prevent duplicate effects. A changed destination configuration blocks publication until the original mapping is restored and reconciled.

Review an existing received email with `dataops invoices process --intake-item-id <id>`, inspect it with `list` and `detail`, correct the current revision with `edit`, then `confirm`. `reject` stops a pending draft; `retry` reconciles a confirmed partial outcome. Finance exposes each action alongside the ledger. Exact CLI flags are listed by `dataops invoices --help`.

Financial state uses the existing managed bookkeeping table and its backups. Portable exports include invoice drafts/audit/publication outcomes, identity claims, row cursors and confirmed ledger projections. Restore clears leases and marks drafts for explicit reconciliation while retaining verified external outcomes. Restore does not publish automatically. Keep the identity claims and row cursors with the restored invoice records.

Agent verification uses sanitized PDFs, mock provider endpoints and a real DynamoDB Local harness (`npm --prefix backend run test:invoice-publication`). Real end-to-end acceptance additionally needs DataOps operator login and one actual forwarded invoice, correction/confirmation, verified archived bytes and exactly one correct spreadsheet row. Intake acknowledgement proves document receipt only.
