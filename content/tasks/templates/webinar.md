---
id: task-template.tasks.webinar
aliases: []
title: "Webinar Task Template"
summary: "Git-backed DataTasks template for the Webinar operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Webinar"
  - "task-template"
  - "webinar"
related_docs: []
---

# Webinar Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `webinar`
- Trigger: manual
- Task count: 32

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
- [Events (live) - webinar](https://docs.google.com/document/d/1x7MJa_K0ZmuWw5NkTbmUFM9welTD8j86evcRl1c7VtY/edit)
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- Guest email
- Luma
- Meetup
- Youtube
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `initial-contact-speaker` | -28 | Initial contact with the speaker asking for details | link: Guest email | [open](https://docs.google.com/document/d/1Hfz6KIIVKDL98t1j0_erGs0RAYCBnJdRjuuFfAxYxHg/edit) |
| 2 | `agree-on-a-date` | -27 | Agree on a date |  | [open](https://docs.google.com/document/d/1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k/edit) |
| 3 | `create-calendar-invite` | -26 | Create a calendar invite for the guests |  | [open](https://docs.google.com/document/d/1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs/edit) |
| 4 | `get-event-info` | -25 | Get information about the event: title, subtitle, outline |  | [open](https://docs.google.com/document/d/1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q/edit) |
| 5 | `fill-people-form-airtable` | -24 | Fill in the "people" form in Airtable |  | [open](https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit) |
| 6 | `create-banner-figma` | -23 | Create a banner for a webinar event in Figma | file required | [open](https://docs.google.com/document/d/1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI/edit) |
| 7 | `create-events-luma` | -22 | Create events on Luma | link: Luma | [open](https://docs.google.com/document/d/1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8/edit) |
| 8 | `create-events-meetup` | -21 | Create events on Meetup | link: Meetup | [open](https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit) |
| 9 | `check-meetup-location` | -21 | Check Meetup if the location is online with the YouTube link |  |  |
| 10 | `create-events-linkedin` | -20 | Create events on LinkedIn |  | [open](https://docs.google.com/document/d/1ZwnCpleU0xQqZV02KVNSO24gu8HIHIrZdbHLGnZx52k/edit) |
| 11 | `create-event-calendar` | -19 | Create event in Calendar |  | [open](https://docs.google.com/document/d/1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE/edit) |
| 12 | `fill-event-form-airtable` | -18 | Fill in the "event" form in Airtable |  | [open](https://docs.google.com/document/d/1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8/edit) |
| 13 | `add-event-to-webpage` | -17 | Add the event to the DataTalks.Club webpage |  | [open](https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit) |
| 14 | `send-luma-link-valeriia` | -16 | Send Luma link to Valeriia for newsletter |  |  |
| 15 | `announce-event-slack` | -15 | Announce event in Slack | stage: announced | [open](https://docs.google.com/document/d/1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ/edit) |
| 16 | `schedule-posts-linkedin-twitter` | -14 | Schedule posts on LinkedIn and Twitter |  | [open](https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit) |
| 17 | `remind-guest-7d` | -7 | Remind the guest about the event | milestone | [open](https://docs.google.com/document/d/1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA/edit) |
| 18 | `remind-guest-1d` | -1 | Remind the guest about the event | milestone | [open](https://docs.google.com/document/d/1rMvF296VSzgMvw5Pmy0azE374ZaRHSak2yXVxJGyyTU/edit) |
| 19 | `actual-stream` | 0 | Actual stream | milestone<br>stage: after-event<br>link: Youtube |  |
| 20 | `update-youtube-cover` | 1 | Update the cover of the YouTube video |  | [open](https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit) |
| 21 | `remove-beginning-recording` | 1 | Remove the beginning of the recording |  | [open](https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit) |
| 22 | `recheck-video-edit` | 2 | Recheck the video if the edit is successful |  |  |
| 23 | `generate-timecodes` | 2 | Generate Timecodes Using Youtube Video Transcripts |  | [open](https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit) |
| 24 | `adding-timecodes-youtube` | 2 | Adding timecodes to YouTube videos |  | [open](https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit) |
| 25 | `add-to-playlists` | 3 | Add the video to "livestream" and "webinar" playlists on YouTube |  | [open](https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit) |
| 26 | `add-youtube-link-to-website` | 3 | Add the YouTube link of the stream to the website |  | [open](https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit) |
| 27 | `upload-luma-emails-mailchimp` | 4 | Upload the emails from Luma to Mailchimp |  | [open](https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit) |
| 28 | `share-emails-with-sponsor` | 4 | For sponsored events - share the list with emails with the sponsor |  | [open](https://docs.google.com/document/d/1qf38niJVSAFYz0hkTXVma_bvM9EpArQLUD4wF4YB_Ok/edit) |
| 29 | `ask-speaker-recommendations` | 5 | Ask for speaker recommendations and ask the guest to share the video |  | [open](https://docs.google.com/document/d/1KuKKupkYHs6V5rdEhbpblIJ2zQcHPJrdauFANX_kA0o/edit) |
| 30 | `add-links-from-speaker-youtube` | 5 | Add links from the speaker to the YouTube video |  | [open](https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit) |
| 31 | `fill-newsletter-announcement` | 6 | Fill in the newsletter announcement | assignee: 00000000-0000-0000-0000-000000000002 |  |
| 32 | `publish-social-media-announcement` | 7 | Publish social media announcement | stage: done |  |
<!-- sop-section-end -->
