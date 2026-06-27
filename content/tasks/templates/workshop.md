---
title: "Workshop Task Template"
summary: "Git-backed DataTasks template for the Workshop operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Workshop"
  - "task-template"
  - "workshop"
---

# Workshop Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `workshop`
- Trigger: manual
- Task count: 36

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
- [Events (live) - workshop](https://docs.google.com/document/d/1tbOClURp1j3MolPY5cI9HzA0QUi8rkXWU_M69RP5BcY/edit)
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- Workshop document
- Guest email
- Luma
- Meetup
- LinkedIn
- Youtube
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `initial-contact-speaker` | -30 | Initial contact with the speaker asking for details | link: Guest email | [open](https://docs.google.com/document/d/1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q/edit) |
| 2 | `agree-on-a-date` | -29 | Agree on a date |  |  |
| 3 | `create-workshop-document` | -28 | Create a Workshop Document | link: Workshop document |  |
| 4 | `create-calendar-invites` | -27 | Create calendar invites for workshops |  | [open](https://docs.google.com/document/d/1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs/edit) |
| 5 | `get-event-info` | -26 | Get information about the event: title, subtitle, outline |  | [open](https://docs.google.com/document/d/1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q/edit) |
| 6 | `fill-people-form-airtable` | -25 | Fill in the "people" form in Airtable |  | [open](https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit) |
| 7 | `create-banner-figma` | -24 | Create a banner for a workshop event in Figma | file required | [open](https://docs.google.com/document/d/1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI/edit) |
| 8 | `create-events-luma` | -23 | Create events on Luma | link: Luma | [open](https://docs.google.com/document/d/1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8/edit) |
| 9 | `create-events-meetup` | -22 | Create events on Meetup | link: Meetup | [open](https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit) |
| 10 | `check-meetup-location` | -22 | Check Meetup if the location is online with the YouTube link |  |  |
| 11 | `create-events-linkedin` | -21 | Create events on LinkedIn | link: LinkedIn | [open](https://docs.google.com/document/d/1ZwnCpleU0xQqZV02KVNSO24gu8HIHIrZdbHLGnZx52k/edit) |
| 12 | `create-event-calendar` | -20 | Create event in Calendar |  | [open](https://docs.google.com/document/d/1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE/edit) |
| 13 | `fill-event-form-airtable` | -19 | Fill in the "event" form in Airtable |  | [open](https://docs.google.com/document/d/1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8/edit) |
| 14 | `add-event-to-webpage` | -18 | Add the event to the DataTalks.Club webpage |  | [open](https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit) |
| 15 | `send-luma-link-valeriia` | -17 | Send Luma link to Valeriia for newsletter |  |  |
| 16 | `announce-event-slack` | -16 | Announce event in Slack in #announcements | stage: announced | [open](https://docs.google.com/document/d/1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ/edit) |
| 17 | `announce-event-communities` | -1 | Announce event on different communities | milestone | [open](https://docs.google.com/document/d/1VWitGUErmKn8JfzBEYx3BVa-lSl-tLPB2bLDtPFWi9Q/edit) |
| 18 | `schedule-posts-linkedin-twitter` | -15 | Schedule posts on LinkedIn and Twitter |  | [open](https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit) |
| 19 | `prepare-send-invoice` | -14 | Prepare and send an Invoice for Sponsored Workshop | file required | [open](https://docs.google.com/document/d/1PeLSKvs76XiP-bG4WviQur4pQS0Ie25w9I50CZkJYZs/edit) |
| 20 | `remind-guest-7d` | -7 | Remind the guest about the event | milestone | [open](https://docs.google.com/document/d/1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA/edit) |
| 21 | `remind-guest-1d` | -1 | Remind the guest about the event | milestone | [open](https://docs.google.com/document/d/1rMvF296VSzgMvw5Pmy0azE374ZaRHSak2yXVxJGyyTU/edit) |
| 22 | `actual-stream` | 0 | Actual stream | milestone<br>stage: after-event<br>link: Youtube |  |
| 23 | `update-youtube-cover` | 1 | Update the cover of the YouTube video |  | [open](https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit) |
| 24 | `remove-beginning-recording` | 1 | Remove the beginning of the recording |  | [open](https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit) |
| 25 | `recheck-video-edit` | 2 | Recheck the video if the edit is successful |  |  |
| 26 | `generate-timecodes` | 2 | Generate Timecodes Using Youtube Video Transcripts |  | [open](https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit) |
| 27 | `adding-timecodes-youtube` | 2 | Adding timecodes to YouTube videos |  | [open](https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit) |
| 28 | `add-to-playlists` | 3 | Add the video to "livestream" and "workshop" playlists on YouTube |  | [open](https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit) |
| 29 | `add-youtube-link-to-website` | 3 | Add the YouTube link of the stream to the website |  | [open](https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit) |
| 30 | `publish-social-media-announcement` | 4 | Publish Social Media Announcement |  |  |
| 31 | `ask-guests-share-videos` | 4 | Ask guests to share the videos with their networks |  | [open](https://docs.google.com/document/d/1TYQGVzdcoTH9-ULzFWK-2nGt8X-50ju5kYcnJV4F83M/edit) |
| 32 | `ask-sponsor-feedback` | 5 | For sponsored workshop, ask the sponsor about how did it go |  | [open](https://docs.google.com/document/d/1kdrmpwrvDjYf_cNVJaLo6qhVJ2B7a5As-DrAx_mYWb8/edit) |
| 33 | `upload-luma-emails-mailchimp` | 5 | Upload the emails from Luma to Mailchimp |  | [open](https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit) |
| 34 | `share-emails-with-sponsor` | 5 | For sponsored events - share the list with emails with the sponsor |  | [open](https://docs.google.com/document/d/1qf38niJVSAFYz0hkTXVma_bvM9EpArQLUD4wF4YB_Ok/edit) |
| 35 | `add-links-from-speaker-youtube` | 6 | Add links from the speaker to the YouTube video |  | [open](https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit) |
| 36 | `check-invoice-paid` | 7 | Check if the Sponsored workshop Invoice has been paid | stage: done |  |
<!-- sop-section-end -->
