# Sponsor contract e-signing design decision

Status: design decision for a proposed DataOps feature; implementation and
release still require product and legal review.

Scope: generate a contract from an approved deal snapshot, route it to the
required signers in order, and retain the completed document and evidence with
the deal. The workflow described here is a Simple Electronic Signature (SES)
approach; it does not create an Advanced or Qualified Electronic Signature.

## Decision

Build a minimal SES workflow into DataOps, using the existing deal record,
application runtime, object storage, and email integration. This keeps contract
status and completed documents connected to the deal and avoids a second
signing service and duplicate workflow state.

This is an integration and data-custody decision, not a claim that in-house
development is cheaper. A small hosted plan may cost less than the initial
engineering and long-term maintenance of a custom signing flow. The in-house
choice assumes DataOps owners can maintain the code, protect signing records,
and respond to delivery and security failures. If those duties cannot be
owned, use a hosted provider instead.

Reconsider the decision if a counterparty or applicable law requires an
Advanced or Qualified Electronic Signature, identity proofing, provider-grade
certificates or timestamps, stronger independent evidence, or support that the
DataOps team cannot operate.

## Build versus provider costs

Public prices checked on 2026-11-03. Prices are list prices, may vary by
country, billing cycle, taxes, and offer, and are not vendor quotes.

| Option | Published price or cost basis | Other cost |
| --- | --- | --- |
| Build in DataOps | No separate e-signature seat or envelope fee. Incremental compute, storage, and email charges use existing services and have not been estimated. | Initial engineering plus continuing security fixes, support, evidence exports, and recovery work. This is the largest unpriced cost. |
| DocuSign eSignature | Ireland page lists Personal at €9/month (€108/year) for 5 envelopes/month, and Standard at €23/user/month (€276/year) for 100 envelopes/user/year. SES is included. | Recurring subscription and plan limits; QES is an extra-cost feature. A hosted plan at this volume may be cheaper than building. |
| Dropbox Sign API | The API page lists a free package for up to 3 signature requests/month. Its Essentials plan starts at 50 requests/month; displayed USD prices depend on billing cycle and volume selection. | Recurring plan charge and integration work. The free tier may not cover normal volume; verify a current quote and request definition before choosing it. |
| Self-hosted OpenSign | Source is available under AGPL-3; no self-hosting license price is listed in the repository. | Separate application and persistent database to patch, monitor, back up, restore, and secure, plus email, storage, and staff time. The project notes that its default MongoDB deployment is not persistent and requires a separately configured database for durable data. |

The provider comparison is a cash-price snapshot, not a total-cost comparison.
For a low contract volume, DocuSign's Personal plan is an inexpensive option.
Building in DataOps is justified only if the integration and data-custody
benefits are worth the engineering and ongoing ownership cost. Self-hosting
avoids a per-envelope vendor fee but does not remove operational work.

## eIDAS SES fit and limits

In eIDAS, “electronic signature” is the general category; SES is commonly used
as shorthand for a signature that is neither advanced nor qualified. An SES is
not a separate eIDAS certification or a guarantee of validity. Article 25(1)
of Regulation (EU) No 910/2014 says an electronic signature must not be denied
legal effect or admissibility as evidence solely because it is electronic or
does not meet the requirements for a qualified electronic signature. Article
25(2) gives a Qualified Electronic Signature (QES) the equivalent legal effect
of a handwritten signature.

That distinction matters: eIDAS does not give an SES the handwritten-signature
presumption. The legal effect of a non-qualified signature and any applicable
form requirements depend on the governing national law and circumstances. The
Court of Justice has also explained that Article 25(1) does not prevent a court
from rejecting a signature on grounds other than its electronic form or lack
of QES status. The evidence below can help establish the parties, intent,
attribution, document version, and signing events; it cannot guarantee
enforceability or prevent a court from weighing the evidence differently.

The product assumption is that ordinary sponsorship agreements can use an SES
where the applicable law and contract do not require a particular form. Before
implementation, legal review must confirm this assumption for the governing
law and contract types in scope. If it does not hold, route those contracts to
an appropriate provider and signature level instead of treating the in-house
flow as sufficient.

## Data model

Store contract records in the existing sponsor CRM table (`TABLE_SPONSOR_CRM`)
under a `CONTRACT#` partition-key prefix; no separate table or index is needed
for this design.

- **Contract record:** contract ID, deal ID, organization ID, status
  (`draft | sent | partially_signed | signed | declined | expired | voided`),
  ordered signing workflow, template ID and version, creation and completion
  times, and a summary exposed on the deal.
- **Terms snapshot:** the exact legal entity names, signer details, scope,
  amounts and currency, dates, and approved clauses used to generate the
  document. Preserve the rendered version; later deal edits must not silently
  change a sent contract.
- **Signer records:** signer role and order, display name, email, optional
  title, delivery reference, token hash and expiry, consent-text version,
  and that signer's state and timestamps. Store only a hash of each random,
  single-use signing token.
- **Artifacts:** draft and completed PDF object references, generation time,
  and SHA-256 of the completed file. The hash detects a mismatch against a
  separately protected recorded hash; a hash stored beside a file is not by
  itself proof against an actor who can change both.
- **Events:** append-only records keyed by contract ID and event sequence for
  creation, document presented, invitation sent, link opened, sign intent,
  signed, declined, expired, and completed. Capture UTC time and relevant
  signer, delivery, document-version, and request metadata. Capture IP address
  and user agent only after privacy review establishes a purpose, lawful basis,
  access limits, and retention period.

Deals may carry `contractRequired`. When true, a transition to `agreed` is
allowed only after every required signer has signed and the contract is
`signed`. The deal response should expose the contract ID and status and
authorized download links for the completed PDF and evidence bundle.

## SES evidence checklist

Use this checklist during implementation and legal review. It describes
records to retain; checking every item does not itself certify legal
compliance.

- **Parties and authority:** identify the contracting organizations and each
  individual signer, role, and asserted authority. Record how signer details
  were confirmed. Email possession alone does not prove a person's identity
  or authority to bind an organization.
- **Exact document:** retain the final terms snapshot and the hash of the exact
  document shown to each signer. Record the template/version and any later
  change as a new contract version requiring renewed signatures.
- **Intent and disclosure:** show the document and a clear disclosure that it
  will be signed electronically; require an explicit sign action. Record the
  disclosure version and the signer's affirmative action.
- **Attribution:** send a unique, expiring, single-use link to the recorded
  signer address; record the recipient, send time, delivery result/reference,
  and token use. Do not treat an email address or IP address alone as proof of
  identity.
- **Event chronology:** record UTC timestamps for presentation, invitation,
  link access, sign action, decline, and completion. Keep event order and
  signer association clear. Record IP and user agent only where approved by
  the privacy review.
- **Integrity and completion:** retain the completed PDF, its hash, and the
  evidence bundle. Verify the hash when retrieving or exporting the PDF. A
  hash supports file-integrity comparison; it does not independently attest
  who signed or when. Use a trusted timestamp, electronic seal, or provider
  evidence if a stronger independent integrity assertion is required.
- **Copies and preservation:** provide the completed document to each signer;
  restrict staff access, preserve an auditable download history, define a
  retention period, back up the document and event records, and test that an
  export remains readable and verifiable.
- **Privacy and security:** document the purpose and retention for personal
  data, minimize captured request metadata, protect records and signing links,
  and define deletion and incident handling. Keep tokens out of logs and
  emails other than the intended signer link.
- **Legal exceptions:** confirm governing law and form requirements before
  sending. Do not use this SES flow where law, the counterparty, or approved
  policy requires an advanced, qualified, or otherwise independently verified
  signature.

## References

- [Regulation (EU) No 910/2014 (consolidated text)](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:02014R0910-20240520), especially Articles 3 and 25.
- [Court of Justice, Ekofrukt, Case C-362/21](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62021CJ0362), on Article 25(1) and national-law effects.
- [DocuSign Ireland eSignature pricing](https://ecom.docusign.com/en-IE/plans-and-pricing/esignature).
- [Dropbox Sign API pricing](https://sign.dropbox.com/products/dropbox-sign-api/pricing).
- [OpenSign repository and self-hosting notes](https://github.com/OpenSignLabs/OpenSign).
