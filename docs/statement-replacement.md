# Statement upload review

Finom and Revolut PDF uploads use one byte-parsed backend import from the CLI
and Finance portal. A statement is identified by bank, printed account identifier,
wallet/currency and calendar month. Account identifiers are fingerprinted from
printed IBAN or account number; a bank name and currency alone do not identify an
account. Sources without a stable account identifier are retained for review and
cannot activate another monthly statement. Email intake reports that review in
its existing issues and finance notification, including recognized tabular bank
sources; those sources are not drafted as invoices.

An overlapping upload shows the existing and candidate issue dates, printed
coverage, counted added/removed operations and balance changes. Repeated equal
operations keep their multiplicity. A different filename, PDF byte sequence or
issue date alone does not count as an operation difference. Identical uploads
still ask whether to replace. The default preserves the selected source.

`dataops reconcile upload --file statement.pdf --preview --json` previews the
batch. `--dry-run` also previews. After review, `--replace` explicitly confirms a
fresh server preview. `import-document` has the same flags. First uploads without
an overlapping active source may commit directly. The explicit-account CLI path
uses the same import, rather than submitting caller-provided parsed rows.

Replacement atomically changes all affected month/wallet selections with version
checks. Stale confirmations fail without partial selection writes. Historical
statement records and source bytes remain available. A wallet absent from the
replacement keeps its previous source; disjoint coverage parts and distinct
accounts remain separate. An explicit selection wins over issue date; when no
selection exists, the earliest retained verified source wins overlapping coverage.

Package generation validates selected original PDFs rather than old derived
coverage metadata. Finom reads Issue date, From/To, opening and closing balances
from the header and checks signed movements at cent precision. Selected Finom
coverage must cover every day from the first through the actual last day of the
month, including day 31. Valid disjoint parts can jointly provide that coverage.
Issue dates are not restricted to a fixed day of the following month. Inactive
history cannot invalidate a confirmed selected source.

This source-selection change preserves existing reconciliation bank-row keys and
manual pair references. It does not migrate historical row identities between
multiple same-bank accounts; that requires a separate audited key migration.
