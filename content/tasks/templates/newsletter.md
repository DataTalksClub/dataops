---
id: task-template.tasks.newsletter
aliases: []
title: "Newsletter Task Template"
summary: "Git-backed DataTasks template for the Newsletter operational workflow."
doc_type: task-template
schema_version: 1
source: "backend/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Newsletter"
  - "task-template"
  - "newsletter"
related_docs:
  - reference.overview.newsletter
  - reference.newsletter.newsletter-sponsorship
  - template.newsletter.create-newsletter-draft-from-template-in-mailchimp
  - sop.newsletter.sponsorship.creating-a-document-for-sponsored-content-for-a-newsletter
  - sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter
  - template.newsletter.communication-with-sponsors
  - template.newsletter.send-sponsorship-document-2-weeks-before
  - template.newsletter.sending-email-on-the-day-of-publication
  - template.newsletter.newsletter-performance
  - sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block
  - sop.newsletter.mailchimp.add-just-published-podcast-page-to-the-newsletter
  - sop.newsletter.mailchimp.schedule-a-newsletter-on-mailchimp
  - sop.newsletter.mailchimp.getting-campaign-performance-stats
  - sop.newsletter.mailchimp.filling-newsletter-statistics
  - sop.finance.bookkeeping.creating-invoices-in-finom
  - sop.social-media.linkedin.schedule-social-media-posts-with-hootsuite-and-post-about-newsletter-promotional-content
  - sop.social-media.linkedin.creating-sponsored-content-for-linkedin-post
  - sop.social-media.twitter.schedule-posts-with-twitter-and-post-about-newsletter-promotional-content
---

# Newsletter Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `newsletter`
- Trigger: automatic
- Task count: 15
- Trigger schedule: `0 9 * * 1`
- Trigger lead days: 14
- Default assignee ID: `00000000-0000-0000-0000-000000000001`
<!-- sop-section-end -->

<!-- sop-section-start: purpose -->
## Purpose

Preserve the canonical task template in Git so the operational process can be reviewed, searched, and restored independently of the runtime task database.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Newsletter](https://docs.google.com/document/d/10sqvW0RqHJ2xQaoJQB0Ce0E21QPPAef5UwWrx0aT2XA/edit)
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- Sponsorship document
- Mailchimp newsletter
- LinkedIn
- X
<!-- sop-section-end -->

<!-- sop-section-start: workflow-definition -->
## Workflow Definition

- Template ID: `task-template.tasks.newsletter`
- Runtime type: `newsletter`
- Trigger: automatic, `0 9 * * 1`, 14 lead days.
- Default owner: `00000000-0000-0000-0000-000000000001`.

Stages:

| Phase ID | Phase | Stage |
| - | - | - |
| `sponsor-intake` | Sponsor document, email, and follow-up | `preparation` |
| `draft-assembly` | Mailchimp draft and content blocks | `preparation` |
| `send-prep` | Final review and scheduling | `preparation` |
| `publication` | Invoice and sponsor live notification | `announced` |
| `promotion` | Sponsored social promotion | `after-event` |
| `performance` | Performance stats and sponsor report | `after-event` |
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof / closure | Waiting / follow-up |
| - | - | - | -: | - | - | - | - | - |
| 1 | `create-sponsorship-document` | sponsor-intake | -14 |  | Create sponsorship document | sop.newsletter.sponsorship.creating-a-document-for-sponsored-content-for-a-newsletter | url: Sponsorship document |  |
| 2 | `email-sponsor` | sponsor-intake | -14 |  | Email the sponsor with the sponsorship document - add Valeriia in communication | template.newsletter.send-sponsorship-document-2-weeks-before | comment: Email the sponsor with the sponsorship document - add Valeriia in communication confirmed | sponsor content, graphics, or Valeriia review |
| 3 | `create-mailchimp-campaign` | draft-assembly | -13 |  | Create a MailChimp campaign | template.newsletter.create-newsletter-draft-from-template-in-mailchimp | url: Mailchimp newsletter |  |
| 4 | `fill-sponsored-block` | draft-assembly | -12 |  | Fill up "Sponsored" block (after sponsorship document is completed) | sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter | external-status: Sponsored block filled or issue confirmed unsponsored | approved sponsor copy, visual, and CTA |
| 5 | `fill-book-of-the-week-block` | draft-assembly | -11 | 00000000-0000-0000-0000-000000000002 | Fill up "Book of the week" block | sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block | comment: Fill up "Book of the week" block confirmed |  |
| 6 | `fill-event-block` | draft-assembly | -10 | 00000000-0000-0000-0000-000000000002 | Fill up "Event" block | template.newsletter.create-newsletter-draft-from-template-in-mailchimp | comment: Fill up "Event" block confirmed |  |
| 7 | `fill-podcast-block` | draft-assembly | -9 | 00000000-0000-0000-0000-000000000002 | Fill up "Podcast" block | sop.newsletter.mailchimp.add-just-published-podcast-page-to-the-newsletter | comment: Fill up "Podcast" block confirmed |  |
| 8 | `fill-article-block` | draft-assembly | -8 | 00000000-0000-0000-0000-000000000002 | Fill up "Article" block | template.newsletter.create-newsletter-draft-from-template-in-mailchimp | comment: Fill up "Article" block confirmed |  |
| 9 | `schedule-email-newsletter` | send-prep | -1 |  | Schedule Email Newsletter | sop.newsletter.mailchimp.schedule-a-newsletter-on-mailchimp | external-status: Mailchimp campaign scheduled |  |
| 10 | `create-invoice` | publication | 0 |  | Create an Invoice | sop.finance.bookkeeping.creating-invoices-in-finom | file: Invoice PDF or invoice proof |  |
| 11 | `send-email-sponsor-publication-live` | publication | 1 |  | Send email to notify sponsor that publication is live | template.newsletter.sending-email-on-the-day-of-publication | comment: Send email to notify sponsor that publication is live confirmed | sponsor contact confirmation or corrected publication link |
| 12 | `schedule-sponsorship-linkedin` | promotion | 2 |  | Schedule Sponsorship content on LinkedIn | sop.social-media.linkedin.schedule-social-media-posts-with-hootsuite-and-post-about-newsletter-promotional-content | url: LinkedIn |  |
| 13 | `schedule-sponsorship-twitter` | promotion | 3 |  | Schedule Sponsorship content on Twitter | sop.social-media.twitter.schedule-posts-with-twitter-and-post-about-newsletter-promotional-content | url: X |  |
| 14 | `add-newsletter-performance` | performance | 7 |  | Add newsletter performance on the spreadsheet | sop.newsletter.mailchimp.filling-newsletter-statistics | external-status: Newsletter, LinkedIn, and X performance stats recorded |  |
| 15 | `send-performance-to-sponsor` | performance | 7 |  | Send the performance of the newsletter to the sponsor | template.newsletter.newsletter-performance | comment: Send the performance of the newsletter to the sponsor confirmed | complete Mailchimp, LinkedIn, and X performance stats |
<!-- sop-section-end -->
