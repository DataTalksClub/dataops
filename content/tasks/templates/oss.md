---
id: task-template.tasks.oss
aliases: []
title: "Open-Source Spotlight Task Template"
summary: "Git-backed DataTasks template for the Open-Source Spotlight operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
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

| # | Ref ID | Offset | Phase | Operator action | Proof and waiting behavior | Instruction doc |
| - | - | -: | - | - | - | - |
| 1 | `reach-out-github-authors` | -21 | `lead-outreach` | Identify likely maintainers/contributors and start outreach from GitHub or community context. | Capture `Tool GitHub` and outreach channel/comment. If no contact or reply, mark waiting for author/maintainer with follow-up date. | `sop.media.open-source-spotlight.reach-out-to-open-source-spotlight-guests` |
| 2 | `reach-out-tool-author` | -20 | `lead-outreach` | Send the OSS invitation using the outreach template. | Required link: `Guest email`. Waiting/follow-up if author has not replied. | `template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool` |
| 3 | `find-time-calendly` | -19 | `recording-scheduling` | Help the author find a time if Calendly does not work. | Comment/external status with proposed or confirmed time. Waiting/follow-up for author reply. | `reference.overview.events-pre-recorded-open-source-spotlight` |
| 4 | `schedule-recording` | -18 | `recording-scheduling` | Schedule the recording and capture calendar/recording details. | External-status proof that recording/calendar details are confirmed. Waiting/follow-up if confirmation blocks progress. | `reference.overview.events-pre-recorded-open-source-spotlight` |
| 5 | `record-demo` | -14 | `recording-intake` | Record the OSS demo. | External-status proof for recording source or comment if Alexey/author owns the recording handoff. | `reference.overview.events-pre-recorded-open-source-spotlight` |
| 6 | `download-upload-youtube` | -13 | `recording-intake` | Download the Zoom recording and upload/create YouTube draft. | Required link: `YouTube`; capture recording source context. | `reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube` |
| 7 | `editing-video` | -12 | `video-production` | Edit/review video and prepare it for publication. | External-status proof that edit passed review; missing edit output marks workflow at risk. | `sop.media.open-source-spotlight.find-timestamps-for-editing` |
| 8 | `add-timecodes-youtube` | -11 | `video-production` | Add timecodes/links to the YouTube video. | External-status proof that timecodes and description links are updated. | `sop.media.open-source-spotlight.adding-timecodes-for-open-source-spotlight-videos` |
| 9 | `ask-authors-review-codes` | -10 | `video-production` | Ask authors to review generated timecodes/cuts and send required links. | Completion note required. Waiting/follow-up required if author review or links are pending. | `template.media.open-source-spotlight.oss-asking-for-revisions-and-links` |
| 10 | `schedule-youtube-video` | 0 | `publication` | Schedule YouTube video for the anchor date/time and verify playlist/schedule state. | Required link: `YouTube`; milestone moves bundle to `after-event`. | `sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos` |
| 11 | `tell-author-publish-date` | 0 | `publication` | Tell the author when the OSS video will be published. | Completion note or external status required. | `template.media.open-source-spotlight.oss-asking-for-revisions-and-links` |
| 12 | `add-to-oss-playlist` | +1 | `publication` | Confirm the video is in the Open-Source Spotlight playlist after publication. | External-status proof required; missing playlist status is missing evidence. | `sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos` |
| 13 | `ask-guest-share-recording` | +1 | `promotion-follow-up` | Ask guest to share the recording and recommend other OSS authors. | Completion note required. Waiting/follow-up if guest reply/share is expected. | `template.media.open-source-spotlight.oss-ask-the-guests-to-share-the-videos-with-their-networks` |
| 14 | `schedule-social-media` | +2 | `promotion-follow-up` | Schedule or publish social announcement for the OSS video. | Required link: `Social announcement`; stage moves to `done` only after proof and waiting work are resolved. | `reference.social-media.post-oss` |
<!-- sop-section-end -->
