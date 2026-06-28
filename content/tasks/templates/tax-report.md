---
id: task-template.tasks.tax-report
aliases: []
title: "Tax Report Task Template"
summary: "Git-backed DataTasks template for the Tax Report operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Tax"
  - "Finance"
  - "task-template"
  - "tax-report"
related_docs: []
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

Preserve the canonical task template in Git so the operational process can be reviewed, searched, and restored independently of the runtime task database.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Tax reports](https://docs.google.com/document/d/1fuWlBKFxWfupmRz9442En78xAwyXjYw_9Aspf81lhv8/edit)
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- Upload link
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `open-bookkeeping-report` | 0 | Open the bookkeeping report for the specific month |  |  |
| 2 | `review-update-todos` | 1 | Review and update to-dos with actual numbers from Dropbox documents, receipts, and invoices |  | [open](https://docs.google.com/document/d/1O9TVl2Q2tTDDFaiZro0XTYXpB8i1r9Q6Ryp-dshGFbQ/edit) |
| 3 | `convert-currencies` | 2 | Convert any USD or other non-euro currencies to EUR using WISE |  | [open](https://docs.google.com/document/d/1WWhBApSyw2JsvkVL6WdmYYRcd9ETf58D5SmN2JnJCXo/edit) |
| 4 | `create-bank-statements-finom` | 3 | Create Bank Statements from Finom | file required | [open](https://docs.google.com/document/d/198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU/edit) |
| 5 | `create-bank-statements-revolut` | 3 | Create Bank Statements from Revolut | file required | [open](https://docs.google.com/document/d/1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q/edit) |
| 6 | `cross-check-revolut-finom` | 4 | Cross-check Revolut and Finom for any missing expenses or income |  | [open](https://docs.google.com/document/d/1Uh6ZQwQ2wBV2S7WZVnph_SauyPQQTQsym5zrrX94vHg/edit) |
| 7 | `prepare-zip-send-accounting` | 5 | Prepare a zip archive of the report and send it to accounting | link: Upload link<br>file required | [open](https://docs.google.com/document/d/1__AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit) |
| 8 | `notify-accountants` | 6 | Notify the accountants that the report is ready |  |  |
| 9 | `organize-invoices-folders` | 7 | Organize invoices folders: Expenses and Incoming Transactions | stage: done |  |
<!-- sop-section-end -->
