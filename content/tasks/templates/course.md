---
title: "Course Task Template"
summary: "Git-backed DataTasks template for the Course operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Course"
  - "task-template"
  - "course"
---

# Course Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `course`
- Trigger: manual
- Task count: 8

- Default assignee ID: `00000000-0000-0000-0000-000000000001`
<!-- sop-section-end -->

<!-- sop-section-start: purpose -->
## Purpose

Preserve the canonical task template in Git so the operational process can be reviewed, searched, and restored independently of the runtime task database.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

- [Free courses page](https://datatalks.club/blog/guide-to-free-online-courses-at-datatalks-club.html)
- [Playbook to promote courses](https://docs.google.com/document/d/1ENqjMNPzG4gVTdQzFeDfwyReRbrw2fe2f6AFHrirVBM/edit)
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- None configured.
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `create-event-standard-process` | -14 | Create an event following the standard process | milestone | [open](https://docs.google.com/document/d/1ENqjMNPzG4gVTdQzFeDfwyReRbrw2fe2f6AFHrirVBM/edit) |
| 2 | `prepare-description-event` | -14 | Prepare the description for the event | assignee: 00000000-0000-0000-0000-000000000002 |  |
| 3 | `announce-course-start` | -30 | Announce the course start | milestone<br>stage: announced |  |
| 4 | `announce-qa-webinar` | -15 | Announce the Q&A webinar when the event is ready on Luma |  |  |
| 5 | `announce-course-start-educational` | -14 | Announce the course start (educational content, carousel, resources) | milestone |  |
| 6 | `feedback-posts` | -7 | Feedback posts | milestone |  |
| 7 | `reach-out-linkedin-influencers` | -10 | Reach out to top LinkedIn influencers in the course topic |  |  |
| 8 | `promote-course-groups` | -7 | Promote the course in relevant LinkedIn, Facebook, Discord, Slack groups, HackerNews, Reddit, Quora | stage: done |  |
<!-- sop-section-end -->
