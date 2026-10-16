# DataOps CLI

A command line client for the same `/api/*` and docs routes the portal frontend
uses. There is one API and one identity model; the CLI is a second client, not a
second backend. It is built to be driven by AI agents as well as people: every
command has `--json` output, a stable exit code, and `--help` with examples.

## Install

```bash
npm link --workspace dataops-cli   # or: node cli/bin/dataops.mjs <command>
```

## Sign in

```bash
dataops login                       # the production portal, https://ops.dtcdev.click
dataops login --url http://localhost:3000
```

`login` starts an [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)
device authorization grant. The CLI prints a short code and a URL; open the URL
in a browser **on a machine you already trust**, sign in with the portal's
normal SSO, and confirm the code. The CLI polls until you confirm, then stores a
token. This works over SSH, where the usual loopback redirect would open a
browser on the wrong machine.

Only confirm a code you started yourself. The approval page shows the machine
label, the requesting IP, and the time so you can check.

## Credentials

Tokens are stored in `~/.config/dataops/credentials.json`, one entry per portal
URL. POSIX systems use mode `0600`; Windows access follows filesystem ACLs.
`DATAOPS_TOKEN` and `DATAOPS_URL` override the stored
profile. Without `DATAOPS_URL` the CLI talks to `https://ops.dtcdev.click`, which
is the right default. A token expires after 90 days; `dataops tokens list` shows
your tokens and `dataops logout` or `dataops tokens revoke <id>` revokes one.

Tokens act as the user who approved them: every permission check behaves
exactly as it does in the web UI, and task history records that user's name.

`DATAOPS_CAPABILITIES=youtube,luma,...` declares the resources this agent can
use; `dataops tasks list` then shows only Tasks whose `requires` it covers
(same as `--can-do`; `--can-do all` ignores it).

## Commands

`dataops --help` lists every family; `dataops <family> --help` shows its
subcommands, flags, and examples.

| Family | What it covers |
| --- | --- |
| `tasks` | the work queue (`list` defaults to the web queue; `--requires`, `--exclude-requires`, `--can-do` filter by required resources), `show`, `create`, `update` (`--depends-on` sets prerequisite Tasks; blocked Tasks cannot be completed), `done` with proof, `reopen`, `wait` / `followed-up` / `unblock`, `assign`, `delete` |
| `resources` | `list` the resource ids a Task can require (youtube, luma, mailchimp, ...) |
| `cards` | `list`, `show` (with Tasks), `create --template`, `update`, `stage`, `link`, `park` / `resume`, `template-update` |
| `templates` | `list`, `show` (read-only; authored in Git) |
| `kb` | knowledge base: `search`, `related <task|card>`, `show`, `tree`, `ls`, `resolve`, `backlinks`, `history`, `write`, `publish` |
| `newsletter` | issues and their sponsor slots: `list`, `show`, `create`, `update`, `delete`, `dismiss-alert` |
| `podcast` | episodes: `list`, `show`, `create`, `update`, `create-card` |
| `speakers` | website speaker/author profiles: `list`, `show`, `create`, `update` |
| `books` | Book of the Week entries: `list`, `show`, `create`, `update` |
| `calendar` | read-only events (Cards, podcast episodes, newsletter issues) and open slots |
| `recurring` | schedules that generate Tasks |
| `automations` | `list` every scheduled or triggered job with its last and next run; `set` the settings they read (admin) |
| `notifications` | `list`, `dismiss`, `dismiss-all` |
| `files`, `artifacts` | Task files and artifacts |
| `sponsors` | CRM records, messages, deal history and finance |
| `invoices` | bookkeeping invoice drafts |
| `bookkeeping` | `sync` transactions from the bookkeeping sheet (dry run unless `--apply`), `classify` missing Type/Category/Period from a provider's history, `facts` reads unattached invoice PDFs for match suggestions |
| `team`, `users` | the team directory (ids for `--assignee`/`--owner`) and the workspace default assignee; adding a person: `add-user` (admin; only added people can sign in); a person leaving: `handover`, `reassign`, `disable-user`, `enable-user`, `delete-user` (admin); accounts (admin) |
| `api` | any other route: `dataops api GET /api/<route>` |
| `secrets` | team secrets store (admin): `list`, `get` (`--field`, `--out`), `set` (`--field KEY=VALUE`, bare `--field KEY` reads stdin, `--from-file`), `delete`; values encrypted at rest, every access audited |
| `login`, `logout`, `whoami`, `tokens` | credentials |
| `agent-guide` | the workflow guide for agents ([skill/SKILL.md](skill/SKILL.md)) |

## Output and exit codes

Human-readable output by default; `--json` prints the result as JSON on stdout.
On failure, the message goes to stderr — as `{"error": {"message", "exitCode",
"status", "code"}}` under `--json`.

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | any other error |
| 2 | usage: unknown command, bad or missing argument; nothing was sent |
| 3 | not signed in, token rejected (401), or the role forbids it (403) |
| 4 | not found (404) |
| 5 | conflict (409): the record changed since it was read; re-read and retry |
| 6 | the API rejected the input (400/422); the message names the problem |
| 7 | server error or network failure; retry later |

Writes read the record's current version first and send it, so a write never
overwrites a change it did not see.

## Knowledge-base search

`dataops kb search` queries the server's docs index (`GET /search`). The index
is built with `zerosearch-node` from the active knowledge publication, kept in
memory for that publication, and rebuilt when a new publication becomes active
(an edit in the web editor, a restore, an import) or a new deployment starts.
The CLI never downloads the corpus.

`dataops kb related <task-id|card-id>` lists the documents the Task, its Card,
and its Template link explicitly, then the best search matches for their
titles.

## Publishing a knowledge-repo commit

`dataops kb publish [--head REV] [--repo DIR] [--dry-run]` makes the DataOps
knowledge store match a commit of a knowledge checkout for every managed file
(`content/`, `_docs/`, `workflow-templates/`, `document-templates/`). It
compares each file's prod sha256 (`GET /knowledge/manifest`) with the commit
and, where they differ, with every version Git ever recorded for that path:

- prod holds a version Git recorded (or never had the file): Git's copy is
  published, including restores of older versions and deletions;
- prod was edited after a version that is still Git's copy: the edit is left
  for the daily mirror to bring into Git (reported as "prod ahead");
- prod was edited and Git changed the file too: it is left untouched,
  reported, and the command exits 5 after publishing everything else.

Prod's side of that comparison comes from `GET /knowledge/history`. Changes
go out in one request (split only above the API's request size), chained by
`expectedRevision` from the revision that was checked. The knowledge
repository's GitHub Action runs this command after its checks pass,
authenticated by the workflow's GitHub OIDC token.

## Agents

Agents use the same device flow; there is no separate agent account. On each
host run `dataops login --label "<agent>@<host>"` and have a person approve the
code in the browser. The token acts as that person, so label it per host to
list and revoke it individually with `dataops tokens`.

Run `dataops agent-guide`, or install [skill/SKILL.md](skill/SKILL.md) as an
agent skill. It covers setup, the output contract, and the
common workflows: find the docs for a task, close a Task with proof, start a
Card from a Template.

## Invoices

Invoice details include original-document provenance, extraction method and
evidence, missing payment evidence, review revision, audit history, and separate
Dropbox and spreadsheet results. Verify invoice and actual payment values for the
current revision to publish automatically. Use `edit --verified` to save
corrected values and verify the new revision in one action, or `verify` to
verify an unchanged reviewed revision. Extraction alone never marks values
verified. A verified/confirmed response can still contain incomplete
publication; inspect both destination states and use `retry` to reconcile
unfinished work. Reprocessing an intake stages drafts and does not verify fields
or publish. `readiness` reports configuration checks without exposing
credentials. `document` returns a short-lived private PDF URL; treat it as
sensitive.

`invoices edit` accepts `--transaction-date`, `--paid-date`, `--counterparty`,
`--description`, `--amount`, `--currency`, `--amount-eur`, `--statement-ref`,
`--quantity`, `--subtype`, `--period`, `--category`, `--comment`, `--payment-evidence`,
`--account-context`, `--invoice-number`, `--archive-required true|false`, and
`--archive-exception-reason`. Supply empty strings to clear a field. The API owns
validation, revision checks, verification, and provider reconciliation.
`--verified` is an explicit declaration that you checked the invoice and actual
payment evidence; it triggers automatic publication only if required evidence
is complete.

Invoice-reader service credentials are separate:
`dataops login --service-token-stdin --url URL` configures the restricted
`invoices:read` service identity.

## Tests

```bash
npm test --workspace dataops-cli            # unit tests against a fake portal
npm run test:e2e --workspace dataops-cli    # the real binary against a local backend
```

## Adding commands

Add a module under `src/commands/` that exports `summary`, `help`, and
`commands`, and register it in `FAMILIES` in `src/cli.mjs`. `apiFor(args)` in
`src/session.mjs` returns the signed-in client; it handles auth, errors, and the
`/work/api` seam.
