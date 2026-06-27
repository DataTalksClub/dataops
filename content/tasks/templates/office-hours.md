---
title: "Office Hours Task Template"
summary: "Git-backed DataTasks template for the Office Hours operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Office Hours"
  - "task-template"
  - "office-hours"
---

# Office Hours Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `office-hours`
- Trigger: manual
- Task count: 5

- Default assignee ID: `00000000-0000-0000-0000-000000000001`
<!-- sop-section-end -->

<!-- sop-section-start: purpose -->
## Purpose

Preserve the canonical task template in Git so the operational process can be reviewed, searched, and restored independently of the runtime task database.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

- None configured.
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- Youtube
- Summary Document
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `alexey-send-zoom-link` | 0 | Alexey will send a Zoom video link for Office Hours | assignee: 00000000-0000-0000-0000-000000000003 |  |
| 2 | `download-upload-youtube` | 1 | Downloading and Uploading Office Hours Videos for YouTube | link: Youtube | [open](https://docs.google.com/document/d/1pWWERBr2fQDtU7APUpq78qd_cM4gqIuHarEBVkttF70/edit) |
| 3 | `summarize-transcripts` | 2 | Summarizing Video Transcripts For Office Hours | link: Summary Document | [open](https://docs.google.com/document/d/1QaWt5ePTu9yifyt84-fgGVYProNT28RTVb-PG3a-y1o/edit) |
| 4 | `generate-description-timecodes` | 3 | Generating Office Hours Video Description and Timecodes for YouTube |  | [open](https://docs.google.com/document/d/13-HQdWdx76Zb1cNFZkXIutzenpwGab2-LRjaiSbc8rw/edit) |
| 5 | `make-announcements-maven` | 4 | Making announcements in Maven | stage: done | [open](https://docs.google.com/document/d/1Se-vZc4iwfLrIskR6L4xaY2fxKE8l_FJ6TFpyDVOVTo/edit) |
<!-- sop-section-end -->
