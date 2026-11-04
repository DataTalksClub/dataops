# Accountant package file names

Invoice files use `YYYY-MM-DD_company_what_amountCUR.pdf` inside `income/` or
`expenses/`. Date is the accountant report cash date. Company and What come
from the saved report row, including invoice allocations. Amount is the absolute
invoice or allocation amount in its original currency. Invoice numbers remain
in the source document and do not add a file-name component.

Payment proofs use the same four components inside `proofs/`, with
`payment-proof-` before their saved What. Statements use
`YYYY-MM_bank-account_statement.pdf` inside `statements/`; tabular sources keep
their source extension. Statements do not invent transaction amounts or What.

Text components are ASCII slugs of at most 40 characters. Duplicate paths use
`-2`, `-3` before the extension, assigned in source-identity order. The report
content and the original document bytes and metadata are preserved.
