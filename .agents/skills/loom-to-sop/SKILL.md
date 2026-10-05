---
name: loom-to-sop
description: Turn a screen recording (Loom share link) into draft SOP documents in the dataops-knowledge repository — one SOP per distinct process, each step backed by a screenshot from the video. Use when the user shares a recording URL and asks to document it as a process document, SOP, or process docs.
---

# Loom to SOP

Convert a task recording into draft SOPs in `../dataops-knowledge`. The
human-facing procedure this packages is
`content/07-internal-operations/manage-systems-library/sops/draft-an-sop-from-a-recorded-task.md`
in dataops-knowledge; both describe the same pipeline, so keep them aligned when
either changes.

Work in a scratch directory outside any repo (`.tmp/loom-sop/` in the dataops
checkout works; it is gitignored). The recording's share URL is the only link
that ever appears in a document — never the scratch copy.

## 1. Fetch the source

```bash
python3 ~/.agents/skills/fetch-loom/loom_subs.py <loom-url>      # timestamped transcript
python3 ~/.agents/skills/fetch-loom/loom_download.py <loom-url>  # MP4 (needs yt-dlp)
```

Both write into `.tmp/` of the cwd with slugified filenames. (The fetch-loom
SKILL.md text says `~/.claude/skills/...`; the scripts actually live at
`~/.agents/skills/fetch-loom/`.)

## 2. Segment the recording

Read the transcript end to end and split the video into distinct processes. For
each, note the trigger, the outcome, and the time segment that shows it. Leave
out segments the presenter marks as one-offs or explicitly excludes, and report
the exclusion instead of documenting it.

## 3. Extract candidate frames

```bash
ffmpeg -ss <start> -to <end> -i video.mp4 -vf fps=1/2 frames/%03d.png
```

Two frames per second is enough for screen recordings. View the frames and pick
one per procedure step: the frame where the UI state and the cursor show the
action, preferably before the click completes so the target is still visible.

## 4. Curate privacy

Before anything is committed: drop frames showing passwords, login screens,
seeds, or personal data the step does not need; prefer frames where a product's
privacy mode already blurs balances and amounts. Set each document's
`confidentiality` to cover its most sensitive surviving screenshot. Convert to
JPG and place the survivors:

```bash
ffmpeg -i frames/042.png -q:v 2 \
  ../dataops-knowledge/content/assets/<business-system>/<doc-slug>/<step-desc>-01.jpg
```

## 5. Draft one SOP per process

Copy the skeleton of an existing SOP (for example
`content/06-finance-and-compliance/manage-bookkeeping/sops/get-invoices-from-mailchimp.md`)
and keep the `sop-section` / `sop-step` / `sop-screenshot` markers. Frontmatter
rules:

- stable `id` using short department and system tokens, e.g.
  `sop.finance.bookkeeping.get-invoices-from-mailchimp`
- `source:` = the recording share URL, and the same URL under
  `training_assets:` (a `loom:` frontmatter key is rejected as deprecated debt)
- `status: proposed` until reviewed
- filename = kebab-case of the title (`align_document_filenames.py` enforces it)

Write steps that stand without the video; fold rules the presenter narrates
(matching rules, settings, date quirks) into the step text rather than trivia.
Replace person-specific values with role names or variables. Captions must not
start with "This screenshot", and image alts must not be blank or TODO
(`validate_content_debt.py` enforces both).

## 6. Validate, index, hand over

```bash
cd ../dataops-knowledge
uv run --with pyyaml --with jsonschema python scripts/build_system_catalog.py
uv run --with pyyaml --with jsonschema python scripts/build_document_index.py
uv run --with pyyaml --with jsonschema python -m unittest discover -s tests
```

Fix every finding that names the new drafts; pre-existing failures elsewhere are
reported, not fixed. Then hand the drafts to the review-and-publication
procedure (`create-and-publish-an-sop.md` in the same directory).

## Gotchas

- Repos on this host can double-execute Bash: on a weird `index.lock` race or
  "cannot stat" mv error, check whether the command actually succeeded before
  retrying.
- If the transcript is inaccurate, trust the frames and correct the passage.
- One SOP per process; link related drafts through `related_docs` and keep
  shared steps duplicated rather than extracted into a partial document.
