# Templates Reference — Part 3: Periodic operations templates

> Part 3 of 4 of the [templates reference](../templates.md):
> [Part 1](part-1-recurring-publication-templates.md) covers recurring publication templates (Newsletter, Book of the Week, Open-Source Spotlight, Course, Social Media Weekly Posts);
> [Part 2](part-2-event-templates.md) covers event templates (Podcast, Webinar, Workshop);
> this part covers periodic operations templates (Tax Report, Maven Lightning Lesson, Office Hours);
> [Part 4](part-4-summary-and-shared-tasks.md) covers the cross-template summary and the shared task lists.

## 9. Tax Report

- Trello name: `Tax Report (MM/YYYY)`
- Type: tax-report
- Display:
  - Emoji: (none)
  - Tags: Tax, Finance
  - Title: Tax Report
- Anchor date: First day of the month when the workflow is generated
- Trigger: automatic, monthly. Create card at `0 9 1 * *` with `triggerLeadDays: 0` (month must close before report work begins)

Monthly tax/bookkeeping report. Involves reviewing financials, cross-checking bank accounts, and preparing a report for the accountants.

Card links:
- Monthly report/spreadsheet
- Accountant upload/share link
- Accountant email thread

References:
- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Tax reports](https://docs.google.com/document/d/1fuWlBKFxWfupmRz9442En78xAwyXjYw_9Aspf81lhv8/edit)

Runtime notes:
- The canonical executable template is `content/tasks/templates/tax-report.md` and `work-engine/scripts/seed-templates.ts`.
- The runtime template keeps 9 stable task refs by splitting Finom and Revolut statement export into separate required-file tasks.
- Required runtime proof is not stored in Git: month-specific report link, Finom statement file, Revolut statement file, tax ZIP file, accountant upload/share link, and accountant email thread are captured on the generated workflow.
- Waiting work uses status `waiting` with `waitingFor`, `followUpAt`, and a comment; due follow-ups appear through existing `follow-up-due` notifications.
- The final cleanup task moves the card to `done` only after proof gates and unresolved waiting follow-ups are clear.

Tasks (9):

- Open the monthly bookkeeping/tax report and attach the month-specific report or spreadsheet link
  - required link: Monthly report/spreadsheet
- Review Dropbox documents, receipts, invoices, and spreadsheet rows; replace TODO values with actual numbers
  - instructions: https://docs.google.com/document/d/1O9TVl2Q2tTDDFaiZro0XTYXpB8i1r9Q6Ryp-dshGFbQ/edit
  - proof: external status that no reportable transaction has unresolved TODO values
- Convert USD or other non-EUR transactions to EUR using Wise/Revolut evidence and update the spreadsheet
  - instructions: https://docs.google.com/document/d/1WWhBApSyw2JsvkVL6WdmYYRcd9ETf58D5SmN2JnJCXo/edit
  - proof: completion comment with conversion source/date or linked conversion evidence
- Download/create the Finom bank statement for the month
  - instructions: https://docs.google.com/document/d/198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU/edit
  - proof: file required
- Download/create the Revolut bank statement for the month
  - instructions: https://docs.google.com/document/d/1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q/edit
  - proof: file required
- Cross-check Finom and Revolut transactions against the bookkeeping spreadsheet and add missing income/expenses
  - instructions: https://docs.google.com/document/d/1Uh6ZQwQ2wBV2S7WZVnph_SauyPQQTQsym5zrrX94vHg/edit
  - proof: external status that statement counts and report rows were reconciled
- Prepare the datatalksclub-YYYY-MM.zip tax package and upload it to the accountant handoff destination
  - instructions: https://docs.google.com/document/d/1__AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit
  - proof: file required and Accountant upload/share link required
- Send the accountant email with the monthly report summary and uploaded package reference, cc Alexey
  - instructions: https://docs.google.com/document/d/1AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit
  - proof: Accountant email thread required
- Move processed expense and incoming invoice files into the correct processed folders and close the monthly workflow
  - proof: external status that folders were organized; stage: done

---

## 10. Maven Lightning Lesson

- Trello name: `📺 [Maven LL] 2026-MM-DD - Topic - Speaker`
- Type: maven-ll
- Display:
  - Emoji: 📺
  - Tags: Maven, Maven Lightning Lesson
  - Title: {TOPIC} - {SPEAKER}
- Anchor date: Event date
- Trigger: manual. Created when Alexey sends Maven LL content and a date is set

Short-form educational content published on Maven platform. Events are created on Maven (not Luma/Meetup), and video editing involves cutting recordings with ffmpeg.

Card links:
- Guest email
- Maven
- Youtube

Tasks (7):

- Alexey will send content for Maven LL (assignee: Alexey)
- Create a blocker in the Calendar
- Create Lightning Lessons on Maven
  - instructions: https://docs.google.com/document/d/1vINJ7_hVlhvRLzo9aWoIVEk6UXxpvI0IoNTzm5V4O8k/edit
- Create a banner for the event on Canva
  - instructions: https://docs.google.com/document/d/12QPknzYsV2TCRAte5_CCPu3T3rfL7i2EnF018Sv46sw/edit
- Downloading, Uploading and Editing Maven Videos for YouTube
  - instructions: https://docs.google.com/document/d/13-HQdWdx76Zb1cNFZkXIutzenpwGab2-LRjaiSbc8rw/edit
- Cut the videos using ffmpeg
  - instructions: https://docs.google.com/document/d/1VW_M7LXOPZ09IZQ70qALfHNxIJYpI3oalNMDygj37NI/edit
- Send the Youtube link and cut videos to DTC Content team in Telegram

---

## 11. Office Hours

- Trello name: `📺 [Office Hours] 2026-MM-DD - Topic - Alexey Grigorev`
- Type: office-hours
- Display:
  - Emoji: 📺
  - Tags: Office Hours
  - Title: {COURSE} - {WEEK NUMBER}
- Anchor date: Event date
- Trigger: manual. Created when Alexey sends Grace the Zoom recording link after the event

Regular office hours hosted by Alexey. Post-event work involves video processing, summarization, and Maven announcements.

Card links:
- Youtube
- Summary Document

Tasks (5):

- Alexey will send a Zoom video link for Office Hours (assignee: Alexey)
- Downloading and Uploading Office Hours Videos for YouTube
  - instructions: https://docs.google.com/document/d/1pWWERBr2fQDtU7APUpq78qd_cM4gqIuHarEBVkttF70/edit
- Summarizing Video Transcripts For Office Hours
  - instructions: https://docs.google.com/document/d/1QaWt5ePTu9yifyt84-fgGVYProNT28RTVb-PG3a-y1o/edit
- Generating Office Hours Video Description and Timecodes for YouTube
  - instructions: https://docs.google.com/document/d/13-HQdWdx76Zb1cNFZkXIutzenpwGab2-LRjaiSbc8rw/edit
- Making announcements in Maven
  - instructions: https://docs.google.com/document/d/1Se-vZc4iwfLrIskR6L4xaY2fxKE8l_FJ6TFpyDVOVTo/edit
