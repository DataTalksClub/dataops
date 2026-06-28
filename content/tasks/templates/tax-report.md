---
id: task-template.tasks.tax-report
aliases: []
title: "Tax Report Task Template"
summary: "Git-backed DataTasks template for the Monthly Tax Report operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
  - google-sheets
  - dropbox
  - finom
  - revolut
  - email
tags:
  - "Tax"
  - "Finance"
  - "task-template"
  - "tax-report"
related_docs:
  - sop.finance.tax-reporting.monthly-tax-report
  - sop.finance.bookkeeping.adding-paid-invoices-to-the-bookkeeping-spreadsheet-and-adding-it-to-dropbox
  - sop.finance.bookkeeping.for-update-converting-usd-to-eur-for-revolut-transcations
  - sop.finance.bookkeeping.creating-bank-statements-in-finom
  - sop.finance.bookkeeping.creating-bank-statements-in-revolut
  - sop.finance.bookkeeping.crosschecking-with-revolut-and-finom
  - sop.finance.bookkeeping.preparing-a-zip-archive-with-invoices-and-send-reports-to-the-accountant
  - sop.finance.bookkeeping.sending-reports-to-accountants-for-bookkeeping
  - template.finance.bookkeeping.sending-reports-to-accountants-for-bookkeeping-email-template
  - reference.finance.invoices-receipts-and-statements
---

# Tax Report Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `tax-report`
- Trigger: automatic
- Task count: 9
- Trigger schedule: `0 9 1 * *`
- Trigger lead days: 0
- Default assignee ID: `00000000-0000-0000-0000-000000000001`
<!-- sop-section-end -->

<!-- sop-section-start: purpose -->
## Purpose

Create the Monthly Tax Report workflow automatically on the first day of each month so the operations manager can reconcile the previous month, gather proof, upload the accountant package, send the accountant email, and close the workflow from DataOps without reconstructing the process from Trello or scattered docs.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Tax reports](https://docs.google.com/document/d/1fuWlBKFxWfupmRz9442En78xAwyXjYw_9Aspf81lhv8/edit)
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- Monthly report/spreadsheet
- Accountant upload/share link
- Accountant email thread
<!-- sop-section-end -->

<!-- sop-section-start: workflow-definition -->
## Workflow Definition

- Template ID: `task-template.tasks.tax-report`
- Runtime type: `tax-report`
- Trigger: automatic monthly creation, `0 9 1 * *`, 0 lead days.
- Anchor date: the first day of the month when the workflow is generated.
- Bundle title pattern: `Tax Report: {month} {year}` or `Tax Report: YYYY-MM`.
- Default owner: `00000000-0000-0000-0000-000000000001`.
- Done criteria: `organize-invoices-folders` reaches `stage: done`; all required links are filled or explicitly skipped by the documented fixed-spreadsheet fallback; required files are uploaded at runtime; accountant handoff proof is present; no reportable transaction still has `TODO`; no waiting follow-up is due.

Stages:

| Phase ID | Phase | Stage |
| - | - | - |
| `report-intake` | Report access and source document review | `preparation` |
| `reconciliation` | Spreadsheet values and bank reconciliation | `preparation` |
| `statements` | Bank statement exports | `preparation` |
| `accountant-handoff` | ZIP package, upload, and accountant notification | `after-event` |
| `cleanup` | Processed folders and workflow closure | `after-event` |
<!-- sop-section-end -->

<!-- sop-section-start: proof-waiting-and-reminder-semantics -->
## Proof, Waiting, And Reminder Semantics

- Due and overdue reminders come from task due dates. With anchor date day 1, tasks are due from day 1 through day 8 of the month.
- Missing-evidence reminders apply to tasks with `requiredLinkName`, `requiresFile`, required `proofRequirement`, or required bundle links.
- Waiting tasks must use status `waiting` with `waitingFor`, `followUpAt`, and a comment. When `followUpAt` arrives, existing work-engine notification behavior surfaces `follow-up-due`.
- Use waiting for missing receipts, invoices, statements, unclear EUR amounts, missing account access, unavailable upload destination, accountant acknowledgment, or cleanup blocked by unresolved files.
- The workflow cannot be considered done while any waiting follow-up is unresolved or due.
- The report link, upload/share confirmation, accountant email thread, Finom statement, Revolut statement, and tax ZIP are runtime evidence. They must not be committed to Git.
<!-- sop-section-end -->

<!-- sop-section-start: data-safety -->
## Data Safety

- Store only process docs, metadata, stable references, and non-secret examples in Git.
- Do not commit real finance files, account secrets, credentials, private monthly report data, or accountant upload URLs.
- Accountant upload destinations are runtime links or operator-provided proof, not hardcoded template secrets.
- Required runtime proof must remain portable through work-engine export/restore: bundle links, task links, task files, waiting fields, follow-up dates, proof requirements, and stage transitions all remain part of workflow state.
<!-- sop-section-end -->

<!-- sop-section-start: reconciliation -->
## Reconciliation Notes

- The Trello-derived reference in `work-engine/docs/templates.md` listed 8 tasks because Finom and Revolut statement export were combined.
- The DataOps runtime template keeps 9 tasks and preserves all existing refs.
- The split bank-statement refs are stable: `create-bank-statements-finom` and `create-bank-statements-revolut`.
- The accountant upload destination is modeled as the runtime bundle link `Accountant upload/share link`; fixed SOP/reference links remain references or instructions.
<!-- sop-section-end -->

<!-- sop-section-start: task-execution-matrix -->
## Task Execution Matrix

| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof / closure | Waiting / follow-up | Systems |
| - | - | - | -: | - | - | - | - | - | - |
| 1 | `open-bookkeeping-report` | report-intake | 0 | 00000000-0000-0000-0000-000000000001 | Open the monthly bookkeeping/tax report and attach the month-specific report or spreadsheet link | sop.finance.tax-reporting.monthly-tax-report | url: Monthly report/spreadsheet, or comment `fixed monthly spreadsheet reused` with the month/range | monthly report access or spreadsheet range confirmation | google-sheets, google-docs |
| 2 | `review-update-todos` | reconciliation | 1 | 00000000-0000-0000-0000-000000000001 | Review Dropbox documents, receipts, invoices, and spreadsheet rows; replace `TODO` values with actual numbers | sop.finance.bookkeeping.adding-paid-invoices-to-the-bookkeeping-spreadsheet-and-adding-it-to-dropbox; reference.finance.invoices-receipts-and-statements | external-status: no reportable transaction has unresolved `TODO`; missing documents are listed | missing receipt, invoice, statement, owner clarification, or source document | google-sheets, dropbox |
| 3 | `convert-currencies` | reconciliation | 2 | 00000000-0000-0000-0000-000000000001 | Convert USD or other non-EUR transactions to EUR using Wise/Revolut evidence and update the spreadsheet | sop.finance.bookkeeping.for-update-converting-usd-to-eur-for-revolut-transcations | comment: conversion source/date or linked conversion evidence recorded | transaction screenshot, Wise/Revolut evidence, or source EUR amount | revolut, wise, google-sheets |
| 4 | `create-bank-statements-finom` | statements | 3 | 00000000-0000-0000-0000-000000000001 | Download/create the Finom bank statement for the month | sop.finance.bookkeeping.creating-bank-statements-in-finom | file: Finom monthly statement file | Finom access or monthly statement export availability | finom, dropbox |
| 5 | `create-bank-statements-revolut` | statements | 3 | 00000000-0000-0000-0000-000000000001 | Download/create the Revolut bank statement for the month | sop.finance.bookkeeping.creating-bank-statements-in-revolut | file: Revolut monthly statement file | Revolut access or monthly statement export availability | revolut, dropbox |
| 6 | `cross-check-revolut-finom` | reconciliation | 4 | 00000000-0000-0000-0000-000000000001 | Cross-check Finom and Revolut transactions against the bookkeeping spreadsheet and add missing income/expenses | sop.finance.bookkeeping.crosschecking-with-revolut-and-finom; reference.finance.invoices-receipts-and-statements | external-status: Finom/Revolut counts and monthly report rows reconciled; unresolved exclusions documented | missing invoice/receipt, income invoice, Alexey clarification, or accounting rule clarification | google-sheets, finom, revolut, dropbox |
| 7 | `prepare-zip-send-accounting` | accountant-handoff | 5 | 00000000-0000-0000-0000-000000000001 | Prepare the `datatalksclub-YYYY-MM.zip` tax package and upload it to the accountant handoff destination | sop.finance.bookkeeping.preparing-a-zip-archive-with-invoices-and-send-reports-to-the-accountant | file: Tax ZIP file; url: Accountant upload/share link | missing required file or accountant upload destination availability | dropbox, accountant-upload, google-sheets |
| 8 | `notify-accountants` | accountant-handoff | 6 | 00000000-0000-0000-0000-000000000001 | Send the accountant email with the monthly report summary and uploaded package reference, cc Alexey | sop.finance.bookkeeping.sending-reports-to-accountants-for-bookkeeping; template.finance.bookkeeping.sending-reports-to-accountants-for-bookkeeping-email-template | url: Accountant email thread, sent-email link, or captured thread proof | accountant acknowledgment or clarification | email, google-sheets, accountant-upload |
| 9 | `organize-invoices-folders` | cleanup | 7 | 00000000-0000-0000-0000-000000000001 | Move processed expense and incoming invoice files into the correct processed folders and close the monthly workflow | sop.finance.bookkeeping.preparing-a-zip-archive-with-invoices-and-send-reports-to-the-accountant step 10 | external-status: processed folders organized and closure criteria met; stage: done | unresolved missing file cleanup blocker | dropbox, dataops |
<!-- sop-section-end -->

<!-- sop-section-start: sample-instantiation -->
## Sample Instantiation

For anchor date `2026-09-01`:

- `open-bookkeeping-report` is due `2026-09-01` and requires the month-specific report link or the fixed-spreadsheet fallback comment.
- `review-update-todos` is due `2026-09-02`.
- `convert-currencies` is due `2026-09-03`.
- `create-bank-statements-finom` and `create-bank-statements-revolut` are due `2026-09-04` and each requires a runtime file.
- `cross-check-revolut-finom` is due `2026-09-05`.
- `prepare-zip-send-accounting` is due `2026-09-06` and requires the ZIP file plus the accountant upload/share link.
- `notify-accountants` is due `2026-09-07` and requires accountant email/thread proof.
- `organize-invoices-folders` is due `2026-09-08` and moves the bundle to `done`.
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `open-bookkeeping-report` | 0 | Open the monthly bookkeeping/tax report and attach the month-specific report or spreadsheet link | link: Monthly report/spreadsheet | [open](https://docs.google.com/document/d/1fuWlBKFxWfupmRz9442En78xAwyXjYw_9Aspf81lhv8/edit) |
| 2 | `review-update-todos` | 1 | Review Dropbox documents, receipts, invoices, and spreadsheet rows; replace `TODO` values with actual numbers | external-status required | [open](https://docs.google.com/document/d/1O9TVl2Q2tTDDFaiZro0XTYXpB8i1r9Q6Ryp-dshGFbQ/edit) |
| 3 | `convert-currencies` | 2 | Convert USD or other non-EUR transactions to EUR using Wise/Revolut evidence and update the spreadsheet | comment required | [open](https://docs.google.com/document/d/1WWhBApSyw2JsvkVL6WdmYYRcd9ETf58D5SmN2JnJCXo/edit) |
| 4 | `create-bank-statements-finom` | 3 | Download/create the Finom bank statement for the month | file required | [open](https://docs.google.com/document/d/198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU/edit) |
| 5 | `create-bank-statements-revolut` | 3 | Download/create the Revolut bank statement for the month | file required | [open](https://docs.google.com/document/d/1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q/edit) |
| 6 | `cross-check-revolut-finom` | 4 | Cross-check Finom and Revolut transactions against the bookkeeping spreadsheet and add missing income/expenses | external-status required | [open](https://docs.google.com/document/d/1Uh6ZQwQ2wBV2S7WZVnph_SauyPQQTQsym5zrrX94vHg/edit) |
| 7 | `prepare-zip-send-accounting` | 5 | Prepare the `datatalksclub-YYYY-MM.zip` tax package and upload it to the accountant handoff destination | file required<br>link: Accountant upload/share link | [open](https://docs.google.com/document/d/1__AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit) |
| 8 | `notify-accountants` | 6 | Send the accountant email with the monthly report summary and uploaded package reference, cc Alexey | link: Accountant email thread | [open](https://docs.google.com/document/d/1AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit) |
| 9 | `organize-invoices-folders` | 7 | Move processed expense and incoming invoice files into the correct processed folders and close the monthly workflow | external-status required<br>stage: done | [open](https://docs.google.com/document/d/1__AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit) |
<!-- sop-section-end -->
