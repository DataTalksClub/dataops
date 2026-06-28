---
id: task-template.tasks.book-of-the-week
aliases: []
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
related_docs:
  - reference.overview.events-slack-book-of-the-week
  - reference.social-media.posts-book-of-the-week
  - sop.community.book-of-the-week.reach-out-to-book-authors
  - sop.community.book-of-the-week.have-a-first-contact-with-the-author
  - sop.community.book-of-the-week.change-the-status-to-confirmed
  - sop.community.book-of-the-week.add-books-to-the-airtable-form
  - sop.community.book-of-the-week.adding-an-author-to-book-of-the-week-pages
  - sop.community.book-of-the-week.determining-the-publisher-of-a-book
  - sop.community.book-of-the-week.add-links-and-edit-description
  - sop.community.book-of-the-week.adding-book-covers
  - sop.community.book-of-the-week.announce-book-of-the-week-announcement-on-linkedin
  - sop.community.book-of-the-week.ask-book-authors-to-share-their-the-event-page
  - sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form
  - sop.community.book-of-the-week.schedule-the-announcement-in-slack
  - sop.community.book-of-the-week.announce-the-book-of-the-week-event
  - sop.community.book-of-the-week.select-book-of-the-week-winners
  - sop.community.book-of-the-week.send-winners-emails
  - template.community.book-of-the-week.book-of-the-week-reaching-out-to-authors
  - template.community.book-of-the-week.book-of-the-week-remind-the-guest-about-the-event-template
  - template.community.book-of-the-week.asking-books-authors-to-share-their-event-page
  - template.community.book-of-the-week.book-of-the-week-linkedin-announcement-a-week-before-the-event
  - template.community.book-of-the-week.book-of-the-week-linkedin-announcement
  - template.community.book-of-the-week.book-of-the-week-announcement-template
  - template.community.book-of-the-week.announce-the-book-of-the-week-winners-in-slack
  - template.community.book-of-the-week.selecting-book-of-the-week-winners-template
  - template.community.book-of-the-week.sending-book-of-the-week-winners-to-the-publisher-and-author-via-email-templateent
  - sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block
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

- Author email
- Publisher or sponsor contact
- Book or publisher source link
- Website link
- LinkedIn announcement
- X announcement
- Slack announcement
- Author share proof
- Winner announcement
- Winner email handoff
<!-- sop-section-end -->

<!-- sop-section-start: workflow-definition -->
## Workflow Definition

- Template ID: `task-template.tasks.book-of-the-week`
- Runtime type: `book-of-the-week`
- Trigger: manual.
- Default owner: `00000000-0000-0000-0000-000000000001`.

Stages:

| Phase ID | Phase | Stage |
| - | - | - |
| `author-outreach` | Author outreach and date confirmation | `preparation` |
| `book-and-page-setup` | Book, author, and public page setup | `preparation` |
| `pre-event-promotion` | Newsletter and pre-event promotion | `preparation` |
| `event-week` | Event week announcements and Q&A | `announced` |
| `giveaway-closeout` | Winner selection and publisher handoff | `after-event` |
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof / closure | Waiting / follow-up |
| - | - | - | -: | - | - | - | - | - |
| 1 | `reach-out-to-book-authors` | author-outreach | -21 |  | Reach out to book authors | template.community.book-of-the-week.book-of-the-week-reaching-out-to-authors | comment: Reach out to book authors confirmed | author reply |
| 2 | `agree-on-a-date` | author-outreach | -20 |  | Agree on a date | sop.community.book-of-the-week.have-a-first-contact-with-the-author<br>step 1 | comment: Agree on a date confirmed | author date confirmation |
| 3 | `change-status-confirmed` | author-outreach | -19 |  | Change the status to "confirmed" in the schedule spreadsheet | sop.community.book-of-the-week.change-the-status-to-confirmed<br>step 1 | external-status: Schedule spreadsheet status is confirmed |  |
| 4 | `fill-airtable-form-author` | book-and-page-setup | -18 |  | Fill up the Airtable form for each author of the book | sop.community.book-of-the-week.adding-an-author-to-book-of-the-week-pages<br>step 1 | external-status: Author/person Airtable form submitted and author email captured<br>[HUMAN] Airtable submission uses an external account; accept with Airtable submission confirmation and captured author email. |  |
| 5 | `fill-airtable-form-book` | book-and-page-setup | -17 |  | Fill up the Airtable form for the book | sop.community.book-of-the-week.add-books-to-the-airtable-form<br>step 1 | external-status: Book Airtable form submitted with book, publisher, cover, and description source<br>[HUMAN] Airtable submission uses an external account; accept with Airtable submission confirmation and book/publisher source captured. |  |
| 6 | `create-web-page` | book-and-page-setup | -16 |  | Create a web page from the forms | sop.community.book-of-the-week.add-links-and-edit-description<br>step 1 | url: Website link<br>[HUMAN] Website publication uses the production website; accept only after the public page URL is captured. |  |
| 7 | `announce-event-linkedin` | pre-event-promotion | -7 |  | Announce the event on DTC LinkedIn | template.community.book-of-the-week.book-of-the-week-linkedin-announcement-a-week-before-the-event | url: LinkedIn announcement<br>[HUMAN] LinkedIn publication or scheduling uses a DTC external account; accept with scheduled-post or public post proof. |  |
| 8 | `remind-author-about-event` | pre-event-promotion | -7 |  | Remind the author about the event | template.community.book-of-the-week.book-of-the-week-remind-the-guest-about-the-event-template | comment: Remind the author about the event confirmed | author Slack invite acceptance |
| 9 | `ask-authors-share-event` | pre-event-promotion | -6 |  | Ask book authors to share the event page | template.community.book-of-the-week.asking-books-authors-to-share-their-event-page | comment: Ask book authors to share the event page confirmed | author share confirmation or public share link |
| 10 | `announce-book-event-linkedin` | event-week | 0 |  | Announce the book of the week event on DTC LinkedIn | template.community.book-of-the-week.book-of-the-week-linkedin-announcement | url: LinkedIn announcement<br>[HUMAN] LinkedIn publication uses a DTC external account; accept with the public announcement URL. |  |
| 11 | `comment-from-alexey-linkedin` | event-week | 0 |  | Comment from Alexey's account on LinkedIn | template.community.book-of-the-week.book-of-the-week-linkedin-announcement | comment: Comment from Alexey's account on LinkedIn confirmed<br>[HUMAN] Alexey's LinkedIn account action must be performed by Alexey; accept with a comment note or public proof. |  |
| 12 | `announce-book-event-twitter` | event-week | 0 |  | Announce the book of the week event on DTC Twitter | reference.social-media.posts-book-of-the-week | url: X announcement |  |
| 13 | `invite-author-to-slack` | event-week | 0 |  | Invite the author(s) to Slack | sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form<br>step 1 | comment: Invite the author(s) to Slack confirmed | author Slack join confirmation |
| 14 | `schedule-announcement-slack` | event-week | 0 |  | Schedule the announcement in Slack | sop.community.book-of-the-week.schedule-the-announcement-in-slack<br>step 1 | external-status: Slack announcement scheduled with cover and copied template<br>[HUMAN] Slack scheduling uses a community workspace account; accept with scheduling confirmation. |  |
| 15 | `announce-book-slack-channels` | event-week | 0 |  | Announce the book in the #book-of-the-week and #announcements channel | sop.community.book-of-the-week.announce-the-book-of-the-week-event<br>step 1 | url: Slack announcement<br>[HUMAN] Slack posting uses the community workspace; accept with the Slack announcement proof link. |  |
| 16 | `authors-answer-questions` | event-week | 1 |  | Authors answer questions | reference.overview.events-slack-book-of-the-week | external-status: Author Q&A activity monitored in Slack | author Q&A activity in Slack |
| 17 | `select-winners` | giveaway-closeout | 4 |  | Select winners (ask author) | sop.community.book-of-the-week.select-book-of-the-week-winners<br>step 1 | external-status: Winners selected by author or randomizer |  |
| 18 | `collect-emails-from-winners` | giveaway-closeout | 5 |  | Collect the emails from winners | sop.community.book-of-the-week.select-book-of-the-week-winners<br>step 6 | external-status: Winner emails collected or waiting follow-up recorded | winner email replies |
| 19 | `announce-winners-slack` | giveaway-closeout | 6 |  | Announce the book-of-the-week winners in the Slack community | template.community.book-of-the-week.announce-the-book-of-the-week-winners-in-slack | url: Winner announcement<br>[HUMAN] Slack posting uses the community workspace; accept with the winner announcement proof link. |  |
| 20 | `contact-publisher-give-emails` | giveaway-closeout | 7 |  | Contact the publisher or the authors and give them the emails | template.community.book-of-the-week.sending-book-of-the-week-winners-to-the-publisher-and-author-via-email-templateent | url: Winner email handoff<br>[HUMAN] Publisher or author email handoff uses external email; accept with the sent thread or handoff URL. | publisher or author fulfillment confirmation |
| 21 | `fill-newsletter-announcement` | pre-event-promotion | -8 | 00000000-0000-0000-0000-000000000002 | Fill in the newsletter announcement | sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block | comment: Fill in the newsletter announcement confirmed |  |
<!-- sop-section-end -->
