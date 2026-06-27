---
title: "Book of the Week Task Template"
summary: "Git-backed DataTasks template for the Book of the Week operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Book of the Week"
  - "task-template"
  - "book-of-the-week"
---

# Book of the Week Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `book-of-the-week`
- Trigger: manual
- Task count: 21

- Default assignee ID: `00000000-0000-0000-0000-000000000001`
<!-- sop-section-end -->

<!-- sop-section-start: purpose -->
## Purpose

Preserve the canonical task template in Git so the operational process can be reviewed, searched, and restored independently of the runtime task database.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Events](https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit)
- [Events (slack) - book of the week](https://docs.google.com/document/d/1RdxwuKVGRI69phmPbmJbgoO3o8il52LFZhiUu3qaDME/edit)
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- Guest email
- Publisher link
- Website link
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `reach-out-to-book-authors` | -21 | Reach out to book authors |  | [open](https://docs.google.com/document/d/1rGXg_1qbCmJUQpVxW9w12-BZObWaFBnTEr98eoMAJkk/edit) |
| 2 | `agree-on-a-date` | -20 | Agree on a date |  | [open](https://docs.google.com/document/d/1VC0nV7NVvKw5XaK9xYlLESystohHaaOthgIdyAmBJEo/edit) |
| 3 | `change-status-confirmed` | -19 | Change the status to "confirmed" in the schedule spreadsheet |  |  |
| 4 | `fill-airtable-form-author` | -18 | Fill up the Airtable form for each author of the book |  | [open](https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit) |
| 5 | `fill-airtable-form-book` | -17 | Fill up the Airtable form for the book |  | [open](https://docs.google.com/document/d/11S7hjpIV0N3MnVm75ygBfwqB9c9_huRLaHil9Zzx_xY/edit) |
| 6 | `create-web-page` | -16 | Create a web page from the forms | link: Website link | [open](https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit) |
| 7 | `announce-event-linkedin` | -7 | Announce the event on DTC LinkedIn | milestone |  |
| 8 | `remind-author-about-event` | -7 | Remind the author about the event | milestone | [open](https://docs.google.com/document/d/1OuOW7IrYQYUS4UK3GBJZRWVIgqW9fp_rkp5hw2bwbjY/edit) |
| 9 | `ask-authors-share-event` | -6 | Ask book authors to share the event page |  | [open](https://docs.google.com/document/d/1wnyMlIO3MuW7TwXkX6NYyo7XXp1hKM_lsp9KUgslSpg/edit) |
| 10 | `announce-book-event-linkedin` | 0 | Announce the book of the week event on DTC LinkedIn | milestone<br>stage: announced | [open](https://docs.google.com/document/d/1HeorFgnMhVt2olNGYJNpoeht_-av-G-nFEf7NLKL8Ek/edit) |
| 11 | `comment-from-alexey-linkedin` | 0 | Comment from Alexey's account on LinkedIn |  |  |
| 12 | `announce-book-event-twitter` | 0 | Announce the book of the week event on DTC Twitter |  | [open](https://docs.google.com/document/d/1VCRVVhI7Lo4OOAg7Blkab94gyoJrjNRgBVKw3tjbxW4/edit) |
| 13 | `invite-author-to-slack` | 0 | Invite the author(s) to Slack |  | [open](https://docs.google.com/document/d/1G8XBXPTQpX8nf873TQmNpkFee3mDueGoVvPGcE54Eho/edit) |
| 14 | `schedule-announcement-slack` | 0 | Schedule the announcement in Slack |  | [open](https://docs.google.com/document/d/1yf1f8ZLzePv-bFHjTlXmLydEzxGpuIG38BJwkqxAMbI/edit) |
| 15 | `announce-book-slack-channels` | 0 | Announce the book in the #book-of-the-week and #announcements channel | milestone |  |
| 16 | `authors-answer-questions` | 1 | Authors answer questions |  |  |
| 17 | `select-winners` | 4 | Select winners (ask author) | milestone<br>stage: after-event | [open](https://docs.google.com/document/d/1S2CwgVZ9-7v_-9HIMk2CdODlkNqMejxqCOcs2bEo9G8/edit) |
| 18 | `collect-emails-from-winners` | 5 | Collect the emails from winners |  | [open](https://docs.google.com/document/d/14QzlXTP1FLHnNAn_ZyTGKlsst-H_hZKSnurzTy8D9TY/edit) |
| 19 | `announce-winners-slack` | 6 | Announce the book-of-the-week winners in the Slack community |  | [open](https://docs.google.com/document/d/1JxtqGk1UamUGp3PxtD3-YCJJagJdJK00CGBEPVd4VH8/edit) |
| 20 | `contact-publisher-give-emails` | 7 | Contact the publisher or the authors and give them the emails | stage: done | [open](https://docs.google.com/document/d/1szidymIamDfTI0LpkmwlRz7AX0qsRcPEVrcKtaFz_hs/edit) |
| 21 | `fill-newsletter-announcement` | -8 | Fill in the newsletter announcement | assignee: 00000000-0000-0000-0000-000000000002 | [open](https://docs.google.com/document/d/10y0CCq8ApFbH1Mx7wlh_b_ZudnPib9qk_tDysA99xNg/edit) |
<!-- sop-section-end -->
