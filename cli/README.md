# DataOps CLI

A command line client for the same `/api/*` routes the portal frontend uses.
There is one API and one identity model; the CLI is a second client, not a
second backend.

## Install

```bash
npm link --workspace dataops-cli   # or: node cli/bin/dataops.mjs <command>
```

## Sign in

```bash
dataops login --url https://portal.datatalks.club
```

`login` starts an [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)
device authorization grant. The CLI prints a short code and a URL; open the URL
in a browser **on a machine you already trust**, sign in with the portal's
normal SSO, and confirm the code. The CLI polls until you confirm, then stores a
token.

This works over SSH, where the usual loopback redirect would open a browser on
the wrong machine.

Only confirm a code you started yourself. The approval page shows the machine
label, the requesting IP, and the time so you can check.

## Credentials

Tokens are stored in `~/.config/dataops/credentials.json` with mode `0600`, one
entry per portal URL. `DATAOPS_TOKEN` and `DATAOPS_URL` override the stored
profile, which is what CI should use. A token expires after 90 days and can be
revoked at any time with `dataops logout` or `dataops tokens revoke <id>`.

Tokens act as you: every permission check behaves exactly as it does in the web
UI, and task history records your name.

## Commands

```
dataops login [--url URL] [--label NAME]   Start a device login
dataops logout                             Revoke this machine's token
dataops whoami                             Show the signed-in user
dataops tokens list                        List your API tokens
dataops tokens revoke <id>                 Revoke a token by id

dataops recurring list                     List recurring schedules
dataops recurring create --description D --cron "0 9 * * 1" [--assignee ID]
dataops recurring edit <id> [--description D] [--cron C] [--assignee ID]
dataops recurring pause <id>
dataops recurring resume <id>
dataops recurring delete <id>
dataops recurring generate [--date YYYY-MM-DD]

dataops invoices list | readiness
dataops invoices detail <id> | document <id>
dataops invoices process --intake-item-id ID
dataops invoices edit <id> --revision N --paid-date YYYY-MM-DD --amount-eur N --payment-evidence NOTE
dataops invoices verify <id> --revision N
dataops invoices reject <id> --revision N [--reason NOTE]
dataops invoices retry <id> --revision N
```

Every command accepts `--json` and prints the raw API response, so the CLI
composes with `jq` and scripts.

Invoice details include original-document provenance, extraction method and evidence,
missing payment evidence, review revision, audit history, and separate Dropbox and
spreadsheet results. Verify invoice and actual payment values for the current revision to publish
automatically. Use `edit --verified` to save corrected values and verify the new
revision in one action, or `verify` to verify an unchanged reviewed revision.
Extraction alone never marks values verified. A verified/confirmed response can still contain incomplete publication; inspect
both destination states and use `retry` to reconcile unfinished work. Reprocessing
an intake stages drafts and does not verify fields or publish. `readiness` reports configuration
checks without exposing credentials. `document` returns a short-lived private PDF
URL; treat it as sensitive.

`invoices edit` accepts `--transaction-date`, `--paid-date`, `--counterparty`,
`--description`, `--amount`, `--currency`, `--amount-eur`, `--statement-ref`,
`--quantity`, `--subtype`, `--period`, `--category`, `--comment`, `--payment-evidence`,
`--account-context`, `--invoice-number`, `--archive-required true|false`, and
`--archive-exception-reason`. Supply empty strings to clear a field. The API owns
validation, revision checks, verification, and provider reconciliation.
`--verified` is an explicit declaration that you checked the invoice and actual
payment evidence; it triggers automatic publication only if required evidence
is complete.

## Adding commands

To wrap another route, add a module under `src/commands/` and register it in
`src/cli.mjs`; the
client in `src/api.mjs` already handles auth, errors, and the `/work/api` seam.
