# DONE evidence — intake 71ebec45 (sponsor contract e-signing, eIDAS, gating deal agreed)

## Verdict

Already implemented on `main` across a series of commits referencing this
intake (`88c3f2b5`, `ad234b51`, `63936419`, `566c49ee`, `b1b1bc77`, and the
`sponsorContracts`/`contractSigning` backend modules). Verified live in prod on
2026-11-05. The 2026-10-31 handoff snapshot was stale: no provider purchase or
process switch is needed — DataOps runs its own eIDAS-SES signing flow.

## What exists (file:line on current main)

- **Record model** `backend/src/sponsorContracts/types.ts`: statuses
  `draft → sent → viewed → signed | declined`; per-signer
  `signedAt/viewedAt/declinedAt/tokenUsedAt`; `draftPdf` + `signedPdf` (with
  `sha256`); counter-signer and signing-order support. The code comment at
  line 7 records the legal analysis: *"eIDAS leaves these B2B contracts at a
  Simple Electronic Signature"* — which is the level eIDAS requires for
  B2B service contracts (no QES needed).
- **Signing flow** `backend/src/routes/sponsorContracts.ts`:
  `handleSigningRequest` (line 374) implements anonymous, token-gated,
  single-use, expiring signer links with rate limiting (IP-hashed),
  signer-email binding, in-order signing (sponsor → counter-signer),
  viewed/signed/declined states with IP + user-agent captured per event, and
  signing lead-time validation (rejects signing after terms lapse — see also
  commit `053e0669` for the backdating guard).
- **Final signed document**: on the last signature the backend renders a
  flattened signed PDF with an audit page, stores it, and records its SHA-256
  for tamper checks.
- **Staff surface**: `POST /send|resend` emails each signer their unique link
  in signing order; `GET /pdf?which=draft|signed`; `GET /audit` per-event
  trail; `POST /verify` recomputes the stored SHA-256 and records
  `verified`/`tamper-detected` in the audit log. Portal contract dialog on the
  deal page + standalone signing page
  (`frontend/src/contract-sign-page.js`, `surfaces/operations/contract-sign.js`).
- **CLI**: `dataops sponsors contract create|send|resend|status|audit|verify`
  (`cli/src/commands/sponsors.mjs:99-110, 680+`).
- **Gating deal agreed**: contract records hang off CRM deals
  (`dealId` required, 422 on invalid deal reference).

## Tests

- `backend/tests/sponsor-contracts.test.ts` — 15 tests.
- `frontend/test/sponsor-contract-dialog.test.mjs` (deal-page dialog).
- Backend typecheck clean on current main.

## Prod evidence (read-only, 2026-11-05)

- `dataops api GET /api/sponsor-crm/contracts` (authenticated) →
  `{"items":[],"nextCursor":null}` — endpoint live in prod, no contracts
  created yet.
- Signing page asset served: `GET /src/contract-sign-page.js` → HTTP 200.
- Unauthenticated `POST /api/sponsor-crm/contracts/test/sign` →
  `{"error":"Unauthorized"}` — token/auth gates hold.

## Why not Google eSignature (Alexey's question, 2026-11-05)

Google Workspace eSignature exists and is included in Business Standard and
higher at no extra cost; it satisfies eIDAS SES — the same legal level this
system already provides. Switching would be a net loss:

- Workspace eSignature has no API/webhooks: status, signed-PDF retrieval and
  the deal gating/audit chain would become manual, while the built flow
  already automates send → view → sign → countersign → signed PDF →
  tamper check → CRM gating.
- The signed document lives in Drive instead of next to the deal with its
  audit trail.

Google eSignature remains a sensible fallback for one-off documents that are
not sponsor deals (no integration needed). For the sponsor contract process,
keep the built-in flow; the only genuine follow-up is running the first real
contract through it end-to-end.

## Remaining gap

None in code. First live end-to-end run (real sponsor contract) is an
operational milestone, not a code change.
