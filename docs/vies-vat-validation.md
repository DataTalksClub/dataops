# EU VAT (USt-ID) validation against VIES

DataOps validates the VAT IDs of EU B2B customers against the European
Commission's VIES service at three points: when a customer's VAT data is
written, when an outbound invoice is issued, and when the monthly
bookkeeping report is assembled. The goal is that a reverse-charge invoice
never leaves with a missing or unusable VAT ID.

## Where VAT data lives

- **Customer** VAT data sits on sponsor CRM organizations: `country`
  (ISO 3166-1 alpha-2) and `vatId` (`DK12345678` — member-state prefix plus
  national number). Both are optional; writes are format-checked, and a
  register number without its member-state prefix (a bare Danish CVR, for
  example) is rejected with a naming error.
- The **last VIES outcome** for each VAT ID is stored in the sponsor CRM
  table, one `vies-check` record per normalized VAT ID: status (`valid`,
  `invalid`, `not-found`, `unavailable`), registered name/address when VIES
  returns them, and `checkedAt`. A changed VAT ID is a different record, so
  the cache misses and VIES runs again — recheck-on-change needs no extra
  machinery.
- The **issuer's** own VAT ID stays on the company profile
  (`SETTINGS#company`, `tax.vatId`).

## Validation service

`backend/src/vies/` splits into structure (`format.ts`), transport
(`client.ts`), storage (`store.ts`) and policy (`service.ts`). Structure
checks reject values that cannot be VIES identifiers without a network
call. The REST client maps answers to valid, not-found and unavailable;
service trouble (timeouts, rate limits, unavailable member-state systems)
is never treated as a validity answer. Outcomes persist per normalized VAT
ID; `unavailable` outcomes are always re-checked.

A VAT check is **required** for a customer with a known EU member state
other than Germany, or with any VAT ID at all. Everyone else is out of
scope.

## Hook points

- **Invoice issue** (`POST /api/sponsor-crm/deals/:id/finance/issue`) and
  **invoice link** (`.../invoice`): the deal's customer VAT state is
  evaluated before the mutation executes. Missing, malformed, invalid or
  unregistered IDs stop the invoice with a 422 naming the problem; VIES
  being unreachable degrades to a warning instead.
- **Finance projection** (`GET .../finance`): carries the customer's `vat`
  view (`vatId`, country, last check, blocking or warning reason), so a
  stored deal whose VAT became invalid stays visible.
- **Monthly report** (snapshot and archive endpoints): responses carry a
  `vatPreflight` summary — every in-scope customer with a flagged VAT
  state, cached-only so assembling a pack never waits on the network.
- **Organization reads** (`GET .../organizations/:id`): the recorded
  `viesCheck` rides along for display.

## CLI

```
dataops vies check <vat-id> [--force]   # one VAT ID, live verdict
dataops vies preflight [--refresh]      # EU customer VAT report; exit 1 while blocking flags remain
```

`preflight --refresh` re-runs VIES for flagged entries first (bounded per
call); the plain report reads recorded state only. Run the preflight before
uploading the monthly pack; a non-zero exit means VAT data needs attention.

## Testing

Unit and API tests run a local HTTP server that mimics the VIES REST
answers (`VIES_BASE_URL` points the client at it); CI never calls the real
service. The reverse-charge invoice gate runs through real transactions in
`scripts/test-sponsor-finance-transaction.sh`
(`tests/vies-invoice-gate.ddb.ts`). A live smoke against production VIES is
opt-in and asserts a definitive answer, not a specific verdict:

```
npm --prefix backend run test:vies:live
```
