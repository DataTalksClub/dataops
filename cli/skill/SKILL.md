---
name: dataops
description: Work in the DataTalks.Club DataOps portal from the command line - find the process docs (SOPs, references) for a task, search and read the knowledge base, list and complete Tasks with proof, create Cards from Templates, plan newsletter issues, and plan podcast episodes. Use when given an operations task, a DataOps Task or Card id, or a question about how an operations process works.
---

# DataOps CLI for agents

`dataops` is a client for the same API the DataOps web portal uses. Anything an
operator does in the web, you can do here, as the user your credential belongs
to, with the same permission checks and the same history attribution.

Run `dataops agent-guide` to print this guide, `dataops --help` for every command
family, and `dataops <family> --help` for flags and examples.

## Setup

There is no separate agent account. The CLI signs in with the device flow, and a
person approves it in the browser; the token then acts as that person.

```bash
dataops login --label "<agent>@<host>"   # prints a code; a human approves it in the browser
dataops whoami                           # confirm identity and role before writing
```

- Label each host's token (`<agent>@<host>`) so it is recognisable in
  `dataops tokens list` and can be revoked alone with `dataops tokens revoke <id>`.
- Tokens expire after 90 days; run `dataops login` again when one does (exit code 3).
- The portal defaults to `https://ops.dtcdev.click`; set `DATAOPS_URL` (or pass
  `--url`) only for another portal.
- The token is stored in `~/.config/dataops/credentials.json` (mode 0600).
  `DATAOPS_TOKEN` overrides it; never put a token on the command line.

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

## Required resources: only take Tasks you can do

Many Tasks need an account or access you may not have: YouTube, Luma, Meetup,
Mailchimp, the DataTalks.Club mailbox, Slack, LinkedIn, the website repo, the
bank. A Task lists them in `requires` (`dataops tasks show` prints it, `--json`
has `requires`); `dataops resources list` gives every id.

Declare what you have once, then list only Tasks you can finish:

```bash
export DATAOPS_CAPABILITIES=youtube,google-docs,website   # what you can log in to
dataops tasks list --mine                     # filtered by DATAOPS_CAPABILITIES
dataops tasks list --can-do youtube,luma      # or say it per command
dataops tasks list --can-do all               # ignore DATAOPS_CAPABILITIES
dataops tasks list --status todo --requires mailchimp   # who needs Mailchimp access
```

A Task can depend on other Tasks of its Card (`dependsOn`; `dataops tasks show`
prints each prerequisite's name and status, `list` marks blocked Tasks). A blocked
Task cannot be completed until every prerequisite is done or skipped. Finish (or,
when it does not apply, skip) the prerequisites first instead of retrying.

If a Task requires something you do not have, leave it for another agent or a
person who has it. Do not attempt it, do not work around the missing access,
and do not mark it waiting or done. A Task with no `requires` needs nothing
beyond DataOps itself. If a Task obviously needs a resource it does not list,
add it: `dataops tasks update <task-id> --requires youtube,luma`.

## Browser requirement: headless machines

`requires` names accounts; the separate `browserRequirement` classifies whether
an interactive browser is needed at all. It is a human-made claim on the Task —
`required` (a browser is needed somewhere) or `headless` (the whole Task can
finish without one) — and it is never inferred from a service name: a Typefully
or YouTube task may have a full API route. An unclassified Task (`show` prints
"not classified") is unknown, not headless-safe.

On a machine without a browser, list only work that is explicitly cleared:

```bash
dataops tasks list --mine --browser headless   # headless mode: classified Tasks only
dataops tasks list --browser unclassified      # triage: classify these next
```

`--browser headless` keeps only Tasks classified `headless`; it filters the
listing and never changes status, due dates, or ownership. Classify a Task you
know: `dataops tasks update <task-id> --browser headless` (or `--browser none`
to clear a wrong classification). Never guess `headless` from a Code view or a
service name alone; classify it only when every step has a headless route.

## Workflow: "here is a task, do it"

1. Find the work item if you were given words instead of an id:
   `dataops tasks list --mine --json` or `dataops cards list --json`. Check its
   `requires` against what you have access to before you start.
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

Task does not apply (cancelled event, self-hosted, duplicate)? Skip it with a reason
instead of faking proof: `dataops tasks skip <task-id> --reason "Self-hosted, no recording"`.
A skipped Task counts as resolved for its Card; `dataops tasks unskip <task-id>` undoes it.

## Workflow: start new work from a Template

```bash
dataops templates list
dataops templates show <type>                 # Task offsets relative to the anchor date
dataops cards create --title "..." --date 2026-11-02 --template <type> [--optional-groups a,b]
dataops cards show <card-id>                  # the generated Tasks
```

`--title` may be left out when the Template has a `card_title` pattern; the
Card is then named from the pattern.

For a one-off Task: `dataops tasks create --description "..." --date 2026-11-02 [--card <card-id>]`.

For a newsletter issue: `dataops newsletter list`. An issue is planned without a Card;
the daily run creates its Card `dataops newsletter card-lead-days` days before the issue
date (CARD shows "due YYYY-MM-DD" until then), and `dataops newsletter create-card <issue-id>`
creates it now. `remove-card <issue-id> --dry-run` shows what removing a Card would move to
the issue and whether it holds work. Book a slot for a
sponsor from the Sponsors tab with `dataops newsletter sponsors` (pick a deal or an
organization) and `dataops newsletter book <issue-id> primary|secondary --deal <id>`;
booking records a deliverable on the deal and adds the slot's Tasks to the Card.
`dataops newsletter release <issue-id> <slot>` frees it again.
`dataops newsletter list --card <card-id>` finds the issue a Card belongs to.

For a podcast episode: `dataops podcast list --status booked` (or `--season N`),
`dataops podcast create --guests "Name[:slug]" --title "..." --recording-date YYYY-MM-DD`,
then `dataops podcast create-card <episode-id>` creates the episode Card from the
podcast Template on the recording date and links it. The episode then moves with
its Card: ticking the recording, audio edit, Spotify scheduling and Spotify
verification Tasks makes it recorded, edited, scheduled and published. Use
`dataops podcast update <episode-id> --status S` only to correct it or cancel it;
`dataops podcast list --card <card-id>` finds the episode a Card belongs to.

For website content: `dataops speakers list` (speaker/author profiles for
`_people` pages; `--name/--slug/--bio/--photo-url/--github/--twitter/--linkedin/--website`)
and `dataops books list` (Book of the Week entries for `_books` pages;
`--title/--authors/--description/--start-date/--end-date/--cover-url/--link "Text=URL"`).
The website script generates the pages from these registers plus the episode register.

## What is on my plate

```bash
dataops tasks list --mine          # the web queue: overdue, follow-ups due, today, waiting
dataops tasks list --overdue --json
dataops notifications list
```

## Anything else

Sponsors (`dataops sponsors`), calendar, recurring schedules, automations
(`dataops automations`), invoices, files and artifacts have their own families. For a web view without a command, call its
route directly: `dataops api GET /api/<route>` (see `dataops api --help`).

## Rules

- Never print, log, or pass the token as an argument.
- Read before you write; prefer the smallest change that completes the Task.
- Do not create Cards or Tasks speculatively; ask when the request is ambiguous.
- Knowledge-base edits (`dataops kb write`) publish immediately for everyone.
