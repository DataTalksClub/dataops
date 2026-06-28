---
id: task-template.tasks.newsletter
aliases: []
title: "Newsletter Task Template"
summary: "Git-backed DataTasks template for the Newsletter operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Newsletter"
  - "task-template"
  - "newsletter"
related_docs: []
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

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `create-sponsorship-document` | -14 | Create sponsorship document | link: Sponsorship document | [open](https://docs.google.com/document/d/1N3tLKK1oDpRep1R5uZ5hhy9b9pDPi21qI_cO44vO7W8/edit) |
| 2 | `email-sponsor` | -14 | Email the sponsor with the sponsorship document - add Valeriia in communication | milestone | [open](https://docs.google.com/document/d/1cgUOAdSp9eqad4MUiEdFBCEb3v0PSB3DiCeYzcJrsrs/edit) |
| 3 | `create-mailchimp-campaign` | -13 | Create a MailChimp campaign | link: Mailchimp newsletter | [open](https://docs.google.com/document/d/1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ/edit) |
| 4 | `fill-sponsored-block` | -12 | Fill up "Sponsored" block (after sponsorship document is completed) |  | [open](https://docs.google.com/document/d/1kuuUAZl0TBlc9jgzH99GxJ9zGGqwDrTZeMzuIlqDKiA/edit) |
| 5 | `fill-book-of-the-week-block` | -11 | Fill up "Book of the week" block | assignee: 00000000-0000-0000-0000-000000000002 | [open](https://docs.google.com/document/d/10y0CCq8ApFbH1Mx7wlh_b_ZudnPib9qk_tDysA99xNg/edit) |
| 6 | `fill-event-block` | -10 | Fill up "Event" block | assignee: 00000000-0000-0000-0000-000000000002 | [open](https://docs.google.com/document/d/1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ/edit) |
| 7 | `fill-podcast-block` | -9 | Fill up "Podcast" block | assignee: 00000000-0000-0000-0000-000000000002 | [open](https://docs.google.com/document/d/1Q6eKmPKAa7LE8-HZrKV9NOdCJLOwlIqB0Txo6aFZUbg/edit) |
| 8 | `fill-article-block` | -8 | Fill up "Article" block | assignee: 00000000-0000-0000-0000-000000000002 | [open](https://docs.google.com/document/d/1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ/edit) |
| 9 | `schedule-email-newsletter` | -1 | Schedule Email Newsletter |  | [open](https://docs.google.com/document/d/1hY7nMMRqooMpmCV0gl0aNfAePUajYLyylW0JUTdiwEM/edit) |
| 10 | `create-invoice` | 0 | Create an Invoice | file required | [open](https://docs.google.com/document/d/1PeLSKvs76XiP-bG4WviQur4pQS0Ie25w9I50CZkJYZs/edit) |
| 11 | `send-email-sponsor-publication-live` | 1 | Send email to notify sponsor that publication is live |  | [open](https://docs.google.com/document/d/1mIm41ciFJ4aF0lUKbJzbeD_dF7vF-gqEti-vQOJ_mTQ/edit) |
| 12 | `schedule-sponsorship-linkedin` | 2 | Schedule Sponsorship content on LinkedIn | link: LinkedIn | [open](https://docs.google.com/document/d/1pHfmmVGnNKGM4i0um3M5yqpgZJlb6sgHGl0eZ1abW-A/edit) |
| 13 | `schedule-sponsorship-twitter` | 3 | Schedule Sponsorship content on Twitter | link: X | [open](https://docs.google.com/document/d/18Pm55ewbv1FoO4Cz_Dx-vWICPa0QhgrXiEsvZX7b6DQ/edit) |
| 14 | `add-newsletter-performance` | 7 | Add newsletter performance on the spreadsheet | milestone | [open](https://docs.google.com/document/d/1A4bsGDNh4MP8WPsrTAo2hVJvlfQNKth9O0q55Xnf0oI/edit) |
| 15 | `send-performance-to-sponsor` | 7 | Send the performance of the newsletter to the sponsor | milestone<br>stage: done | [open](https://docs.google.com/document/d/1oXpq9SlHHcSe5JjDrScPT2yVb4n980uTJX_-F6NNqkU/edit) |
<!-- sop-section-end -->
