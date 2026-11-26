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
| `note` | Why the case exists and which real draft it was modelled on |
| `hints` | Forwarded email `subject` and `sender` handed to the extractor |
| `reader` | `unused` (the layout must take a template path) or the recorded reader answer |
| `expected.description` | The description to store, or `null` when it must stay empty |
| `expected.method` | Extraction method that must be recorded |
| `expected.needsReview` | Whether a description issue may hold the draft for review |
| `expected.issues` | Extraction issues that must be recorded |

`descriptions.json` runs each case through `extractFinanceText` with the
recorded `reader` answer standing in for the model call.
