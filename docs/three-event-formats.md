# Three event formats

DataOps runs events in exactly three formats: **workshop**, **webinar** and
**podcast**. Each format is served by one canonical Git-authored Template, and
each event Card carries only that format's document templates. The newsletter
is a separate recurring publication with its own flows and is not an event
format.

Sponsorship is a deal attribute, never a format: there is no sponsored variant
of any event format, template or document. An event Card that belongs to a
sponsor deal carries an explicit `sponsored: true` flag, settable through the
portal, the CLI (`dataops cards create --sponsored`, `dataops cards update
CARD_ID --sponsored`) and the API. The flag changes nothing else — a sponsored
and a non-sponsored card of the same format get identical document templates
and identical validation.

The platform rejects deviations instead of storing them:

- A custom Template may not claim an event format — neither exactly
  (`workshop`), nor as a variant slug (`sponsored-workshop`,
  `sponsored-webinar`). Creating or updating such a Template fails with a
  clear error. Separate business-unit workflows outside DataTalks.Club's
  three event formats (such as `aishl-workshop`) keep their own workflow.
- An event Card can be created only from its format's canonical Template. A
  card creation whose Template (or `[Workshop]`-style title tag) claims an
  event format served by another Template is rejected.
- A document on an event Card must use that format's document templates:
  `workshop` for workshops, `webinar` for webinars, and `podcast`,
  `podcast-episode-brief`, `podcast-run-sheet`, `podcast-guest-research` for
  podcasts. Creating a document from another template, or switching one to it,
  is rejected with a visible error.
- Saving document content whose keys deviate from the document template's
  schema is rejected on save, in the API, CLI and portal alike.

The policy is enforced in `backend/src/cards/eventFormats.ts`, and every
enforcement point names the canonical alternative in its error.

## Read-only audit

`GET /api/cards/format-audit` (admin) and `dataops cards format-audit`
(`--json` for the full payload) scan every Card, Template and sponsor document
and report everything that deviates from this policy — legacy variant
Templates, cards instantiated from them, and documents whose template does not
belong to their card's format. The audit reports only; it never repairs.
Existing deviations are cleaned up by hand, so the report can name records
that are then fixed or archived deliberately.
