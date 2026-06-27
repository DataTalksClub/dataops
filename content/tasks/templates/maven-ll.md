---
title: "Maven Lightning Lesson Task Template"
summary: "Git-backed DataTasks template for the Maven Lightning Lesson operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Maven"
  - "Maven Lightning Lesson"
  - "task-template"
  - "maven-ll"
---

# Maven Lightning Lesson Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `maven-ll`
- Trigger: manual
- Task count: 7

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

- Guest email
- Maven
- Youtube
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `alexey-send-content` | -7 | Alexey will send content for Maven LL | assignee: 00000000-0000-0000-0000-000000000003 |  |
| 2 | `create-blocker-calendar` | -6 | Create a blocker in the Calendar |  |  |
| 3 | `create-lightning-lessons-maven` | -5 | Create Lightning Lessons on Maven | link: Maven | [open](https://docs.google.com/document/d/1vINJ7_hVlhvRLzo9aWoIVEk6UXxpvI0IoNTzm5V4O8k/edit) |
| 4 | `create-banner-canva` | -4 | Create a banner for the event on Canva | file required | [open](https://docs.google.com/document/d/12QPknzYsV2TCRAte5_CCPu3T3rfL7i2EnF018Sv46sw/edit) |
| 5 | `download-upload-edit-youtube` | 1 | Downloading, Uploading and Editing Maven Videos for YouTube | link: Youtube | [open](https://docs.google.com/document/d/13-HQdWdx76Zb1cNFZkXIutzenpwGab2-LRjaiSbc8rw/edit) |
| 6 | `cut-videos-ffmpeg` | 2 | Cut the videos using ffmpeg |  | [open](https://docs.google.com/document/d/1VW_M7LXOPZ09IZQ70qALfHNxIJYpI3oalNMDygj37NI/edit) |
| 7 | `send-youtube-link-telegram` | 3 | Send the Youtube link and cut videos to DTC Content team in Telegram | stage: done |  |
<!-- sop-section-end -->
