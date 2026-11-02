# Sponsor contract e-signing (eIDAS) design note

Intake: Hub 71ebec45-7b8e-47ea-be64-3c608cf4cf30 (project dataops, version 6).
Scope: sponsor contracts generated from deal data, sent to the sponsor contact
as a unique expiring signing link, signed in a configurable order (sponsor
first, or DataTalks.Club counter-signature first), with the signed PDF and
its audit trail stored on the deal. A deal flagged contract_required cannot
move to status agreed without a signed contract.

## Build vs provider decision

Options considered: a hosted e-signature provider (DocuSign, Dropbox Sign,
OpenSign), a self-hosted open-source stack, and building the minimal flow
into DataOps itself.

Cost. Hosted providers are priced per envelope or per user per month (a
single DocuSign seat is roughly EUR 40 per month at list price). DataTalks.Club
signs a handful of sponsor contracts per month; a subscription is
disproportionate at that volume. A self-hosted stack adds a second
always-on service (hosting, upgrades, backups) that nobody operates today.
Building on the existing DataOps backend costs only the code and reuses
storage, email delivery and the CRM that already exist.

EU eIDAS fit. Sponsorship deals are B2B contracts. Under EU regulation
910/2014 (eIDAS) a Simple Electronic Signature (SES) is sufficient for these
contracts to be valid; Advanced (AdES) or Qualified (QES) signatures are not
required and would force counterparty identity verification that neither
side wants for this value range. Our flow captures the evidence courts look
at for an SES: who was invited (email address), that the signer opened the
link (view event), when and from which IP and user agent the signature
happened, and a tamper-evident PDF whose SHA-256 is stored at signing time.
A provider would buy us nothing here unless we needed QES, which we do not.

Ops burden. A provider is one more vendor, account, invoice and data
processor agreement; self-hosting is one more service to patch. The built-in
flow keeps all sponsor data inside the existing DynamoDB/S3 boundary and
reuses the existing email path (the Dapier-held Google token for
orin@datatalks.club that sponsor content forms already use).

Decision: build the minimal SES flow in DataOps. Revisit a provider only if
contract volume grows or a counterparty demands a Qualified Electronic
Signature.

## Data model

Contract records are a new record kind in the existing sponsor CRM table
(TABLE_SPONSOR_CRM), PK prefix CONTRACT#, so no new table or index is
needed. Fields: dealId, organizationId, status (draft | sent | viewed |
signed | declined), signingOrder (sponsor-first | counter-first), terms
(company, legalPayer, payerCountry, scope, priceEur, currency, startDate,
endDate, VAT rule: DE adds 19 percent VAT, other EU business customers
reverse charge; cancellation clause: 50 percent of the fee after signing;
minimum one month lead time between signing and the start date), signers[]
(one sponsor signer, one counter signer; each with name, email, order,
per-signer token hash and expiry, viewedAt, signedAt, ip, userAgent,
emailSentTo), draft and signed PDF locations (the signed one with its
SHA-256), and a per-event audit trail stored as CONTRACT#id history entries
(created, sent, viewed, signed, declined, completed) using the same
append-only history pattern the CRM already uses for deal status changes.

Deals gain an optional contractRequired flag. The API refuses moving such a
deal to status agreed (on create and on update) while no contract for the
deal is in status signed; the refusal is a 422 with code
signed_contract_required. The deal payload carries a contract summary
(status and id) so the UI and the CLI can render it and link to the signed
PDF and audit trail downloads.

## Legal checklist (SES evidence captured)

- Identify the parties: the contract names the sponsor company and the legal
  payer, generated from deal data.
- Intent to sign: the signer takes an explicit Sign action on a page reached
  through a unique expiring link.
- Attribution: the link is delivered to the signer email address recorded on
  the CRM contact; the send records which address was used.
- Timestamps: every event (sent, viewed, signed, declined, completed) is
  stored in UTC.
- IP address and user agent are captured per signing event.
- Integrity: the final PDF is flattened (no editable fields), embeds an audit
  page listing every event, and its SHA-256 hash is stored on the contract
  record; a verify endpoint recomputes the hash from stored bytes so
  tampering is detectable.
- Consent: the signing page states that signing happens electronically under
  eIDAS using a Simple Electronic Signature.
- Copies: the signed PDF and the audit trail stay downloadable from the deal
  by staff.

## Send flow

Staff create the contract from a deal (terms validated: at least one month
lead time to the start date, DE-only VAT rule derived from the payer
country), then send it. Sending mints an expiring token per signer (only
the SHA-256 token hash is stored), emails the sponsor signer their link
through the existing orin@ mailbox path, and marks the contract sent. The
counter-signer link stays retrievable by staff (CLI or UI) instead of being
emailed. Opening the link marks the contract viewed. Signing order is
configurable per contract: sponsor-first (sponsor signs, then DataTalks.Club
counter-signs) or counter-first (Alexey signs first). The contract becomes
signed once every signer has signed; at that point the final flattened PDF
with the audit page is rendered, hashed and stored.
