---
id: task-template.tasks.oss
aliases: []
title: "Open-Source Spotlight Task Template"
summary: "Git-backed DataTasks template for the Open-Source Spotlight operational workflow."
doc_type: task-template
schema_version: 1
source: "backend/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Open-Source Spotlight"
  - "task-template"
  - "oss"
related_docs:
  - reference.overview.events
  - reference.overview.events-pre-recorded-open-source-spotlight
  - sop.media.open-source-spotlight.reach-out-to-open-source-spotlight-guests
  - sop.media.open-source-spotlight.joining-open-source-project-communities-and-asking-for-oss-demos
  - sop.media.open-source-spotlight.filling-in-the-open-source-spotlight-airtable-database
  - sop.media.open-source-spotlight.find-timestamps-for-editing
  - sop.media.open-source-spotlight.adding-links-from-the-zoom-chat
  - sop.media.open-source-spotlight.adding-timecodes-for-open-source-spotlight-videos
  - sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos
  - template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool
  - template.media.open-source-spotlight.oss-asking-for-revisions-and-links
  - template.media.open-source-spotlight.oss-ask-the-guests-to-share-the-videos-with-their-networks
  - reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube
  - reference.social-media.post-oss
  - sop.media.video-youtube.add-timecodes-to-youtube-videos
  - sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist
---

# Open-Source Spotlight Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `oss`
- Trigger: manual
- Task count: 14
- Anchor date: planned YouTube publication date
- Anchor time policy: schedule for Wednesday 17:00 Europe/Berlin unless the operator records a source-backed exception.
- Default assignee ID: `00000000-0000-0000-0000-000000000001`
<!-- sop-section-end -->

<!-- sop-section-start: purpose -->
## Purpose

Run one pre-recorded Open-Source Spotlight video from project selection and author outreach through YouTube publication, playlist confirmation, guest follow-up, and social announcement proof.

This is operator work, not a documentation index. Each task carries due offsets from the publication date, phase/stage context, required proof, waiting/follow-up guidance, and a stable instruction document ID when an in-repo process document exists.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Events](https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit)
- [Events (pre-recorded) - Open-Source Spotlight](https://docs.google.com/document/d/1foX7pya-Ywi153LkZWFWBw2nI6HYvcQKS-QQBEUmGZc/edit)

Stable source document IDs:

- `task-template.tasks.oss`
- `reference.overview.events`
- `reference.overview.events-pre-recorded-open-source-spotlight`
- `sop.media.open-source-spotlight.reach-out-to-open-source-spotlight-guests`
- `sop.media.open-source-spotlight.joining-open-source-project-communities-and-asking-for-oss-demos`
- `sop.media.open-source-spotlight.filling-in-the-open-source-spotlight-airtable-database`
- `sop.media.open-source-spotlight.find-timestamps-for-editing`
- `sop.media.open-source-spotlight.adding-links-from-the-zoom-chat`
- `sop.media.open-source-spotlight.adding-timecodes-for-open-source-spotlight-videos`
- `sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos`
- `template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool`
- `template.media.open-source-spotlight.oss-asking-for-revisions-and-links`
- `template.media.open-source-spotlight.oss-ask-the-guests-to-share-the-videos-with-their-networks`
- `reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube`
- `reference.social-media.post-oss`
- `sop.media.video-youtube.add-timecodes-to-youtube-videos`
- `sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist`
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- Guest email
- Tool GitHub
- Recording source
- YouTube
- Author review
- OSS playlist
- Social announcement
<!-- sop-section-end -->

<!-- sop-section-start: phases -->
## Phases And Stages

- `lead-outreach`: preparation. Identify the project, author, contact path, and outreach state.
- `recording-scheduling`: preparation. Coordinate date/time, Calendly fallback, calendar, and recording details.
- `recording-intake`: preparation. Record or receive the demo, then create the YouTube draft.
- `video-production`: preparation. Edit/review the video, add timecodes/links, and ask the author for review.
- `publication`: after-event. Schedule YouTube for the anchor date/time, confirm playlist state, and notify the author.
- `promotion-follow-up`: after-event, then done. Ask the guest to share/recommend authors and publish or schedule the social announcement.
<!-- sop-section-end -->

<!-- sop-section-start: waiting-follow-up -->
## Waiting And Follow-Up Policy

Use `waiting` only for external blockers. Waiting OSS tasks must include `waitingFor`, `followUpAt`, and a comment/note. The seeded task metadata marks outreach, date coordination, recording handoff, author review, and guest-share tasks as waiting-capable so due follow-ups remain visible on the dashboard.

The workflow can move to `after-event` when `schedule-youtube-video` is completed with YouTube proof. It can move to `done` from `schedule-social-media` only after required social proof exists and no required waiting follow-up remains unresolved.
<!-- sop-section-end -->

<!-- sop-section-start: done-criteria -->
## Done Criteria

- Tool/project and author/contact proof are captured.
- Recording source and YouTube draft/public video proof are captured.
- Timecodes, description links, author review request, and author publication notice are recorded.
- YouTube schedule/publication and Open-Source Spotlight playlist status are confirmed.
- Guest share/recommendation follow-up is either completed or explicitly waiting with a follow-up date.
- Social announcement proof or scheduling confirmation is captured.
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof / closure | Waiting / follow-up |
| - | - | - | -: | - | - | - | - | - |
| 1 | `reach-out-github-authors` | lead-outreach | -21 | 00000000-0000-0000-0000-000000000001 | Identify likely maintainers/contributors and start outreach from GitHub or community context. | sop.media.open-source-spotlight.reach-out-to-open-source-spotlight-guests | url: Tool GitHub and outreach channel/comment | author or maintainer contact/reply |
| 2 | `reach-out-tool-author` | lead-outreach | -20 | 00000000-0000-0000-0000-000000000001 | Send the OSS invitation using the outreach template. | template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool | url: Guest email | author reply |
| 3 | `find-time-calendly` | recording-scheduling | -19 | 00000000-0000-0000-0000-000000000001 | Help the author find a time if Calendly does not work. | reference.overview.events-pre-recorded-open-source-spotlight | comment or external-status: proposed or confirmed time | author reply |
| 4 | `schedule-recording` | recording-scheduling | -18 | 00000000-0000-0000-0000-000000000001 | Schedule the recording and capture calendar/recording details. | reference.overview.events-pre-recorded-open-source-spotlight | external-status: recording/calendar details confirmed | recording confirmation |
| 5 | `record-demo` | recording-intake | -14 | 00000000-0000-0000-0000-000000000001 | Record the OSS demo. | reference.overview.events-pre-recorded-open-source-spotlight | external-status: recording source, or comment when Alexey/author owns handoff | recording handoff |
| 6 | `download-upload-youtube` | recording-intake | -13 | 00000000-0000-0000-0000-000000000001 | Download the Zoom recording and upload/create YouTube draft. | reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube | url: YouTube; capture recording source context |  |
| 7 | `editing-video` | video-production | -12 | 00000000-0000-0000-0000-000000000001 | Edit/review video and prepare it for publication. | sop.media.open-source-spotlight.find-timestamps-for-editing | external-status: edit passed review | missing edit output marks workflow at risk |
| 8 | `add-timecodes-youtube` | video-production | -11 | 00000000-0000-0000-0000-000000000001 | Add timecodes/links to the YouTube video. | sop.media.open-source-spotlight.adding-timecodes-for-open-source-spotlight-videos | external-status: timecodes and description links updated |  |
| 9 | `ask-authors-review-codes` | video-production | -10 | 00000000-0000-0000-0000-000000000001 | Ask authors to review generated timecodes/cuts and send required links. | template.media.open-source-spotlight.oss-asking-for-revisions-and-links | comment: author review request sent | author review or links |
| 10 | `schedule-youtube-video` | publication | 0 | 00000000-0000-0000-0000-000000000001 | Schedule YouTube video for the anchor date/time and verify playlist/schedule state. | sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos | url: YouTube; stage: after-event |  |
| 11 | `tell-author-publish-date` | publication | 0 | 00000000-0000-0000-0000-000000000001 | Tell the author when the OSS video will be published. | template.media.open-source-spotlight.oss-asking-for-revisions-and-links | comment or external-status: author notified |  |
| 12 | `add-to-oss-playlist` | publication | +1 | 00000000-0000-0000-0000-000000000001 | Confirm the video is in the Open-Source Spotlight playlist after publication. | sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos | external-status: playlist status confirmed | missing playlist status is missing evidence |
| 13 | `ask-guest-share-recording` | promotion-follow-up | +1 | 00000000-0000-0000-0000-000000000001 | Ask guest to share the recording and recommend other OSS authors. | template.media.open-source-spotlight.oss-ask-the-guests-to-share-the-videos-with-their-networks | comment: guest share request sent | guest reply/share |
| 14 | `schedule-social-media` | promotion-follow-up | +2 | 00000000-0000-0000-0000-000000000001 | Schedule or publish social announcement for the OSS video. | reference.social-media.post-oss | url: Social announcement; stage: done after proof and waiting work are resolved |  |
<!-- sop-section-end -->
