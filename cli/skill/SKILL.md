---
name: dataops
description: Work in the DataTalks.Club DataOps portal from the command line - find the process docs (SOPs, references) for a task, search and read the knowledge base, list and complete Tasks with proof, create Cards from Templates, and plan newsletter slots. Use when given an operations task, a DataOps Task or Card id, or a question about how an operations process works.
---

# DataOps CLI for agents

`dataops` is a client for the same API the DataOps web portal uses. Anything an
operator does in the web, you can do here, as the user your credential belongs
to, with the same permission checks and the same history attribution.

Run `dataops agent-guide` to print this guide, `dataops --help` for every command
family, and `dataops <family> --help` for flags and examples.

## Setup (non-interactive)

```bash
export DATAOPS_URL=https://ops.dtcdev.click   # the default; set it for another portal
export DATAOPS_TOKEN=...                      # from your secret store, never on the command line
dataops whoami                                # confirm identity and role before writing
```

Without `DATAOPS_TOKEN` the CLI uses the profile saved by `dataops login`.

## Contract

- Add `--json` to any command for machine-readable output on stdout. Errors go to
  stderr; with `--json` they are a JSON object `{"error": {"message", "exitCode",
  "status", "code"}}`.
- Exit codes: `0` ok, `1` other error, `2` usage (nothing was sent), `3` not
  signed in or forbidden, `4` not found, `5` conflict (the record changed: re-read
  and retry), `6` rejected input (the message says which field), `7` server or
  network unavailable (retry later).
- Writes read the record's current version first, so a write never overwrites a
  change it did not see. On exit code 5, re-read with `show` and decide again.
- Ids are full UUIDs (or slot/doc ids). Copy them from `--json` output.

## Vocabulary

- **Template**: a reusable workflow definition (read-only here; authored in Git).
- **Card**: one instance of work, usually created from a Template on an anchor date.
- **Task**: a checklist item, usually on a Card, with a due date and sometimes a
  required proof (a link, a file, a comment, an external status, an approved artifact).
- **Knowledge base (kb)**: process docs - SOPs, references, playbooks - with stable ids.

## Workflow: "here is a task, do it"

1. Find the work item if you were given words instead of an id:
   `dataops tasks list --mine --json` or `dataops cards list --json`.
2. Find the docs for it:
   `dataops kb related <task-id|card-id>` lists the docs the Task, its Card, and its
   Template link explicitly, then the best search matches for its title.
3. Read the procedure: `dataops kb show <doc-id>` prints the markdown.
4. If nothing is linked, search: `dataops kb search "<what you need to do>" --type sop`.
   Narrow with `--type reference`, `--domain`, `--tag`; widen with `--limit`.
5. Do the work, then close the Task with its proof (next section).

## Workflow: complete a Task with proof

```bash
dataops tasks show <task-id>                 # shows required link / proof type
dataops tasks done <task-id> --link https://... [--comment "what was done"]
dataops tasks done <task-id> --external-status "scheduled in the mail tool"
dataops tasks done <task-id> --file ./evidence.pdf     # uploads to the Task first
```

If the server answers "required card link ... is not filled", fill it on the Card:
`dataops cards link <card-id> "<link name>" <url>`, then run `done` again.
A waiting Task is closed through the follow-up resolve action automatically.

Blocked on someone else? Record it instead of leaving the Task open silently:
`dataops tasks wait <task-id> --for "Who" --follow-up 2026-11-02 --channel email --note "Asked for X"`.
When they answer: `dataops tasks unblock <task-id> --note "Got X"`.

## Workflow: start new work from a Template

```bash
dataops templates list
dataops templates show <type>                 # Task offsets relative to the anchor date
dataops cards create --title "..." --date 2026-11-02 --template <type> [--optional-groups a,b]
dataops cards show <card-id>                  # the generated Tasks
```

For a one-off Task: `dataops tasks create --description "..." --date 2026-11-02 [--card <card-id>]`.

For a newsletter issue: `dataops newsletter list`, then
`dataops newsletter create-card <slot-id>` creates the issue Card from the newsletter
Template on the slot's date and links it. `dataops newsletter list --card <card-id>`
finds the slot a Card belongs to.

## What is on my plate

```bash
dataops tasks list --mine          # the web queue: overdue, follow-ups due, today, waiting
dataops tasks list --overdue --json
dataops notifications list
```

## Anything else

Sponsors (`dataops sponsors`), calendar, recurring schedules, invoices, files and
artifacts have their own families. For a web view without a command, call its
route directly: `dataops api GET /api/<route>` (see `dataops api --help`).

## Rules

- Never print, log, or pass the token as an argument.
- Read before you write; prefer the smallest change that completes the Task.
- Do not create Cards or Tasks speculatively; ask when the request is ambiguous.
- Knowledge-base edits (`dataops kb write`) publish immediately for everyone.
