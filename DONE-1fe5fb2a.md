# DONE evidence — task 1fe5fb2a (webinar speaker materials form, like the podcast guest form)

Verified against origin/main `ebf0fb18` (2026-11-05) in a dedicated worktree
(`fix/speaker-form-verify`, `.tmp/worktrees/speaker-form/dataops`). The task
asked for a webinar speaker materials form modeled on the podcast guest form.

## Verdict

**DONE** on origin/main. The webinar speaker materials form is implemented
end-to-end: template + validation, guest-code portal form at `/webinar-docs/:id`,
staff review surface on the Card, Markdown/DOCX export, speaker invitation
email draft, the `dataops webinar doc` CLI family, and backend + e2e + CLI
tests — all present and passing. The template is live in prod (read-only
check below); no webinar document has been created in prod yet, so the
feature is shipped and awaiting first use.

One small parity gap against the podcast guest form was found and is fixed
in this PR: the webinar form had no free-text notes field (details below).

## Verification table

| Capability | Evidence | Status |
| --- | --- | --- |
| Template definition | `backend/src/sponsorDocs/templates.ts:449-491` — `webinar` key in `SponsorDocTemplateKey` (`:3-12`), registered in `SPONSOR_DOC_TEMPLATE_KEYS` (`:69`); sections: talk (`talkTitle` required, `summary` optional, `outline` bullets 3–4 required), speaker (`bio` required), links (`linkedinUrl`/`twitterUrl`/`githubUrl`/`websiteUrl`, `format: 'url'`), notes (`sponsorNotes`, added by this PR) | Present |
| Validation | `validateSubmittedContent` `templates.ts:1172-1196` — required fields (`:1176-1178`), bullet min/max (`:1179-1183`), http(s) URL format check (`:1186-1192`); `SponsorDocValidationError` carries per-field errors (`:1165-1169`) | Present |
| Portal form route (guest-code access, like podcast) | `backend/src/routes/sponsorDocs.ts:154` — canonical page `/webinar-docs/:id`; anonymous access allowed for `GET/PUT /api/sponsor-docs/:id` + export (`isAnonymousSponsorDocRequest :179-189`, assets `:195-209`); per-doc access code verified constant-time (`verifyExternalCodeForDoc`, `GET :945-954`, `PUT :1008-1023`); code supplied via header/query/body (`extractProvidedAccessCode :211-220`) and stripped from the URL after first load | Present |
| Staff review surface | Card page button "Create speaker materials form" (`frontend/src/surfaces/work-detail/webinar-materials.js:5,21-36`, POSTs `{cardId, template:'webinar'}`); Card summary link "Speaker materials" → `/webinar-docs/` (`frontend/src/surfaces/work-detail/card-summary.js:150-154`); staff doc view with access code, email draft, rotate (`routes/sponsorDocs.ts:929-943,853-922`); speaker name inferred from `card.people[0]` (`routes/sponsorDocs.ts:656-657`); template auto-inferred for webinar-type cards (`inferTemplateForCard :223-264`) | Present |
| Export | `GET /api/sponsor-docs/:id/export` (`routes/sponsorDocs.ts:788-851`) — json/markdown/txt/docx; webinar Markdown renderer `templates.ts:1333-1344`; export labels the person "Speaker" and edits "speaker" (`:1234,1237`); speaker sees only non-internal content (`speakerContentView :1158-1164`) | Present |
| Invitation email | `renderSponsorEmailDraft` webinar branch `templates.ts:1542-1555`; auto-send eligible (`backend/src/sponsorDocs/emailDelivery.ts:95-102`); `POST …/send-email` records Gmail message id on the linked task (`routes/sponsorDocs.ts:853-903`) | Present |
| CLI family | `dataops webinar doc <create|show|list|update|submit|reopen|export|email|send-email|rotate-code|templates|delete>` — `cli/src/cli.mjs:103`, `cli/src/commands/sponsorDocs.mjs:73-92` (help), `:565-596` (`domainDocCommand`), speaker-domain guard `:20,210-214` | Present |
| Backend tests | `backend/tests/webinar-speaker-materials.test.ts` — 3 tests (required/optional fields, 3–4 bullets + URL validation, export + invite wording without sponsor jargon); HTTP flow also covered in `backend/tests/sponsor-docs.test.ts:1014+` ("links webinar materials, saves speaker drafts, validates submission and exposes the saved export on the card") and webinar→workshop type switch `:1160+` | Pass |
| E2E tests | `backend/e2e/webinar-speaker-materials.spec.js` — one full browser test: staff creates the form on the Card, anonymous speaker opens `/webinar-docs/:id?code=…` on a 390px phone viewport, gate says "Speaker access", validation errors, save draft + reload persistence, submit, status "Submitted / Ready", staff export assertions | Pass |
| CLI tests | `cli/test/webinar.test.mjs` — 3 tests (create + invitation draft, update/submit/list parity, help documents required fields + rejects newsletter flags) | Pass |
| Prod (read-only) | `dataops api GET /api/sponsor-docs/templates` → `webinar` template present with label "Webinar — Speaker Materials", defaultLinkType "Speaker materials", and exactly the fields above; `dataops api GET /api/sponsor-docs` → 16 docs, 0 with template `webinar` (feature shipped, no webinar doc created yet) | Confirmed |

## Parity table: podcast guest form vs webinar speaker form

| Capability | Podcast guest form | Webinar speaker form | Gap? |
| --- | --- | --- | --- |
| Guest/speaker-code portal page | `/podcast-docs/:id` + legacy aliases (`/sponsor-docs/`, `/guest-docs/`) | `/webinar-docs/:id` (all prefixes serve any doc id — `routes/sponsorDocs.ts:197`) | No |
| Per-doc access code gate, code stripped from URL | Yes | Yes (e2e asserts `search === ''`, spec `:34`) | No |
| Save draft / submit / reopen + last-edited tracking | Yes | Yes (same PUT + status machine) | No |
| Required-field + URL-format validation | Yes | Yes (plus bullets 3–4 count) | No |
| Speaker/guest-appropriate wording (no "sponsor") | Yes ("Guest") | Yes ("Speaker"; e2e `:36`, unit test `:33`) | No |
| Export (json/md/txt/docx) with humanized content | Yes (slot choice humanized) | Yes (all fields + placeholders) | No |
| Invitation email draft + send-email + rotate-code | Yes | Yes | No |
| CLI family | `dataops podcast doc` (4 templates) | `dataops webinar doc` (1 template) | No |
| Scheduling slot picker (radio, hydrated free Mon/Tue slots) | Yes (`hydratePodcastGuestSlotOptions`, `templates.ts:1061`) | No — webinar time is set by the team; the form is materials-only | No (by design; podcast-specific scheduling) |
| Guest identity field (`guestName`) | Yes (guest types name/role) | No — speaker taken from `card.people[0]` (`routes/sponsorDocs.ts:656-657`) | No (by design; speaker is known) |
| Collapsible optional sections | Yes (story + notes) | No (sections are short) | No (cosmetic) |
| Free-text notes field (`sponsorNotes`) | Yes — "6) Additional Notes (Optional)" (`templates.ts:695-708` pre-PR) | **Missing** | **Yes — fixed in this PR** |

## Parity gap fixed in this PR

The podcast guest form and the workshop form both give the external person a
free-text channel to the team (`sponsorNotes`), and the shared export block
already renders it with a per-template heading (`templates.ts:1493-1496`).
The webinar form was the only speaker/guest-facing form without it — a
speaker could not flag anything outside the fixed fields. Unambiguous and
small, so it was implemented per the task's criterion 4:

- `backend/src/sponsorDocs/templates.ts` — webinar section
  `4) Notes for the DataTalks.Club Team (optional)` with `sponsorNotes`
  (`:484-490`), mirroring the workshop wording; intro updated to
  "Summary, links, and notes are optional."
- `backend/src/sponsorDocs/templates.ts:1494-1495` — export heading for
  webinar is `## Notes from the Speaker` (not "Notes from Sponsor", keeping
  the no-sponsor-jargon rule the webinar tests enforce).
- `backend/tests/webinar-speaker-materials.test.ts` — asserts the field
  exists and is optional, and that a filled note exports under
  "## Notes from the Speaker" while the export still contains no
  sponsor/hub wording.
- `backend/e2e/webinar-speaker-materials.spec.js` — fills
  `#sponsor-field-sponsorNotes` in the browser round trip and asserts the
  staff-side Markdown export contains the note.
- `cli/src/commands/sponsorDocs.mjs` — `webinarDocHelp` lists
  `sponsorNotes` among optional fields; `cli/test/webinar.test.mjs` asserts
  the help mentions it.

No backend route or frontend change was needed: `sanitizeTemplateContent`
(`templates.ts:1136-1160`) and the portal form renderer handle sections
generically, and there are zero webinar docs in prod to migrate.

## Test results (this worktree, Node v24)

- `backend` targeted: `webinar-speaker-materials.test.ts` — 3/3 pass
  (after the fix; same 3/3 before it on pristine origin/main).
- `backend` regression: `podcast-guest-form.test.ts` 8/8 pass;
  `sponsor-docs.test.ts` 21/21 pass (includes the webinar HTTP flow and the
  webinar→workshop switch); frontend `sponsor-docs.test.mjs` 9/9 pass.
- `cli` targeted: `cli/test/webinar.test.mjs` — 3/3 pass (after the fix).
- E2E targeted: `npx playwright test e2e/webinar-speaker-materials.spec.js`
  (isolated test server, `DATAOPS_E2E_SERVER_PORT=3217`) — 1/1 passed (5.5s).

## Prod evidence (read-only)

- `dataops api GET /api/sponsor-docs/templates` returns the `webinar`
  template matching the repo definition (required: talkTitle, outline, bio;
  optional: summary + four url-format links; defaultLinkType "Speaker
  materials"). Prod runs the pre-PR template (no `sponsorNotes` yet) — this
  PR's change reaches prod on the next backend deploy.
- `dataops api GET /api/sponsor-docs` (metadata only): 16 docs —
  7 podcast, 3 podcast-guest-research, 2 podcast-episode-brief,
  1 podcast-run-sheet, 1 newsletter-main, 1 newsletter-standalone,
  1 workshop; **0 webinar**.
