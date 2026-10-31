# Extraction gold set (public, synthetic)

Each `*.json` case is a document whose correct reading has been verified by a
person, plus the fields the extractor must return. The eval harness and the
regression tests read these files.

This repository is public, so every case here is a **synthetic twin**: the
layout, the text-layer quirks and the traps of a real document are kept, while
the counterparty, amounts that identify a deal, payment-card digits and
personal details are replaced. The real documents and their hand-verified
values live in the private gold set, outside this repository; `source` names
the DataOps artifact or draft a case was modelled on, so the two can be
matched.

Fields (all optional unless noted):

| Field | Meaning |
|---|---|
| `id` | Case id (required) |
| `source` | DataOps ids of the real document this twin reproduces |
| `text` | The PDF text layer exactly as `pdfText` returns it (`\u0000` kept) |
| `expected.docType` | `invoice`, `receipt` or `credit_note` |
| `expected.direction` | `income` or `expense`, as recorded in the ledger |
| `expected.amount`, `expected.currency` | Amount to the cent and ISO currency |
| `expected.net`, `expected.vat`, `expected.vatRate`, `expected.reverseCharge` | VAT breakdown when the document states it |
| `expected.invoiceNumber` | Full document number including suffixes |
| `expected.counterparty`, `expected.date` | Issuer and issue date |
| `expected.descriptionFrom` | `document`: must not come from the email subject |
| `expected.paymentChannel` | `card`, `paypal`, `bank-transfer`, `direct-debit` or `platform` |
| `traps` | Values the extractor must **not** return, with why |
