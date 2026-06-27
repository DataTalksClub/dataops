---
id: task-template.tasks.podcast
aliases: []
title: "Podcast Task Template"
summary: "Git-backed DataTasks template for the Podcast operational workflow."
doc_type: task-template
schema_version: 1
source: "work-engine/scripts/seed-templates.ts"
systems:
  - dataops
  - datatasks
tags:
  - "Podcast"
  - "task-template"
  - "podcast"
related_docs:
  - sop.media.podcast.create-podcast-document
---

# Podcast Task Template

<!-- sop-section-start: summary -->
## Summary

- Template type: `podcast`
- Trigger: manual
- Task count: 42

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
- [Events (live) - podcast](https://docs.google.com/document/d/19d_kBOVQJ2p5qZCtGywzWzYeyCv5FWeHApZnEUZIYRg/edit)
<!-- sop-section-end -->

<!-- sop-section-start: required-bundle-links -->
## Required Bundle Links

- Guest email
- Podcast document
- Luma
- Meetup
- Youtube
- Transcription
- Spotify for podcasters link
- Spotify podcast link
- Apple podcasts link
- DTC webpage podcast link
<!-- sop-section-end -->

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Offset | Task | Requirements | Instructions |
| - | - | -: | - | - | - |
| 1 | `obtain-speaker-email` | -28 | Obtain speaker's email | link: Guest email |  |
| 2 | `create-proposed-calendar-invite` | -27 | Create a proposed calendar invite for guest speaker |  | [open](https://docs.google.com/document/d/1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k/edit) |
| 3 | `agree-on-a-date` | -26 | Agree on a date |  | [open](https://docs.google.com/document/d/1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k/edit) |
| 4 | `create-podcast-document` | -25 | Create a podcast document with the questions | link: Podcast document | [open](https://docs.google.com/document/d/1IVNQQs-Hk-8LzZWox8YWbShJ6Y3sl47H5Z2PC2ra9ZU/edit) |
| 5 | `include-johanna-ask-guest-bio` | -24 | Include Johanna and ask the guest their biography and other information |  | [open](https://docs.google.com/document/d/1Ix73NmCJPfYs0HcokxG5sORj0bFxtZsLrZTLHsp_DDM/edit) |
| 6 | `add-guest-as-editor` | -23 | Add the Guest as an Editor on the podcast document |  |  |
| 7 | `share-podcast-document-slack` | -22 | Share the podcast document on the #dtc-podcast-help |  | [open](https://docs.google.com/document/d/1pVL13ku-_zwlqQk8PhmxJkxnRylxzDIKImlzH526k1M/edit) |
| 8 | `create-calendar-invite` | -21 | Create a calendar invite for guest speaker |  | [open](https://docs.google.com/document/d/1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs/edit) |
| 9 | `add-guest-bio-to-document` | -20 | Add a guest bio to the podcast document |  | [open](https://docs.google.com/document/d/1mijZcQ6qRXCscG0DVx6UA9KGgUT_QVTDUSWpQl4aqhE/edit) |
| 10 | `fill-people-form-airtable` | -19 | Fill in the "people" form in Airtable |  | [open](https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit) |
| 11 | `create-banner-figma` | -18 | Create a banner for a podcast event in Figma | file required | [open](https://docs.google.com/document/d/1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI/edit) |
| 12 | `create-event-luma` | -17 | Create an event in Luma | link: Luma | [open](https://docs.google.com/document/d/1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8/edit) |
| 13 | `create-event-meetup` | -16 | Create an event in Meetup | link: Meetup | [open](https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit) |
| 14 | `check-meetup-location` | -16 | Check Meetup if the location is online with the YouTube link |  | [open](https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit) |
| 15 | `create-event-calendar` | -15 | Create event in the DTC community Calendar |  | [open](https://docs.google.com/document/d/1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE/edit) |
| 16 | `announce-event-slack` | -14 | Announce event in Slack in #announcements | stage: announced | [open](https://docs.google.com/document/d/1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ/edit) |
| 17 | `fill-event-form-airtable` | -13 | Fill in the "event" form in Airtable |  | [open](https://docs.google.com/document/d/1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8/edit) |
| 18 | `add-event-to-webpage` | -12 | Add the event to the DataTalks.Club webpage |  | [open](https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit) |
| 19 | `schedule-posts-linkedin-twitter` | -11 | Schedule posts on LinkedIn and Twitter |  | [open](https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit) |
| 20 | `remind-guest-7d` | -7 | Remind the guest about the event | milestone | [open](https://docs.google.com/document/d/1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA/edit) |
| 21 | `remind-guest-1d` | -1 | Remind the guest about the event | milestone | [open](https://docs.google.com/document/d/1JSHCMgOufo0UrUD2XE1D4rLc1H0jROTjZB9ARCGeZrk/edit) |
| 22 | `actual-stream` | 0 | Actual stream | milestone<br>stage: after-event<br>link: Youtube |  |
| 23 | `upload-recording-dropbox` | 1 | Upload the recording to the shared folder in dropbox | assignee: 00000000-0000-0000-0000-000000000003 |  |
| 24 | `update-youtube-cover` | 1 | Update the cover of the YouTube video |  | [open](https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit) |
| 25 | `remove-beginning-recording` | 1 | Remove the beginning of the recording |  | [open](https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit) |
| 26 | `recheck-video-edit` | 2 | Recheck the video if the edit is successful |  |  |
| 27 | `create-transcript-document` | 2 | Create the transcript document | link: Transcription | [open](https://docs.google.com/document/d/1lkvu5T4fVT0nnmjIPolLCT4o4dUc3iZ2b7jWycVrtPU/edit) |
| 28 | `add-to-playlists` | 2 | Add the video to "livestream" and "podcast" playlists on YouTube |  | [open](https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit) |
| 29 | `add-youtube-link-to-website` | 3 | Add the YouTube link of the stream to the website |  | [open](https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit) |
| 30 | `edit-video-description` | 3 | Edit video description |  | [open](https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit) |
| 31 | `include-timecodes` | 3 | Include timecodes extracted from the transcription |  | [open](https://docs.google.com/document/d/1RrTDKmxs9iN2YKnYQ9uSQvdUXRGxPJJ3u7RiQWnCyCw/edit) |
| 32 | `ask-guest-for-links` | 1 | Ask the guest for links after the stream |  | [open](https://docs.google.com/document/d/1tsuI291-eJ8CxK5MHajEKK3ODZ_TOHfX-XZ-csAFX8Y/edit) |
| 33 | `schedule-podcast-spotify` | 4 | Schedule the edited podcast episode with Spotify for Podcasters | link: Spotify for podcasters link | [open](https://docs.google.com/document/d/1moSrrDw501TzG3X_DqreK2ZkhRZ40I_d9lCjhF4agQA/edit) |
| 34 | `moving-podcast-audio-dropbox` | 4 | Moving Podcast Audio in Dropbox |  | [open](https://docs.google.com/document/d/1PTfM18NgBRICm70hPMcYntCEs_uNxh0lYERhmDcusGA/edit) |
| 35 | `add-podcast-episode-airtable` | 4 | Add a podcast episode via Airtable form |  | [open](https://docs.google.com/document/d/1nUvqLRX18fEWgqeJO-9FNuXDX8SBZpjauIjvfXwaL4k/edit) |
| 36 | `create-podcast-page` | 5 | Create a podcast page with the information from the form | link: DTC webpage podcast link | [open](https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit) |
| 37 | `ask-guest-share-podcast-page` | 5 | Ask the guest to share the podcast page |  | [open](https://docs.google.com/document/d/1ojQTnenw5yfKL_hn4LCDzfbVRcNxbvNFfEO_1PiIbDQ/edit) |
| 38 | `move-podcast-documents-archive` | 5 | Move the podcast documents to archive in google drive |  | [open](https://docs.google.com/document/d/1wEs9firI_tlbSNt4jPWTAgTZT1_eaQ6P9VSoDoybu48/edit) |
| 39 | `upload-luma-emails-mailchimp` | 5 | Upload the emails from Luma to Mailchimp |  | [open](https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit) |
| 40 | `add-podcast-webpage-newsletter` | 6 | Add the podcast webpage to the newsletter | assignee: 00000000-0000-0000-0000-000000000002 | [open](https://docs.google.com/document/d/1Q6eKmPKAa7LE8-HZrKV9NOdCJLOwlIqB0Txo6aFZUbg/edit) |
| 41 | `schedule-posts-overview-after-event` | 6 | Schedule posts "overview after the event" on LinkedIn and Twitter |  | [open](https://docs.google.com/document/d/1156ty59e3ZlUW3nPpMTd_2smzW40v0ANt9nojUxZ2Gc/edit) |
| 42 | `schedule-posts-guest-recommendations` | 7 | Schedule posts "Guest recommendations" on LinkedIn and Twitter | milestone<br>stage: done | [open](https://docs.google.com/document/d/1XDOfmUHMjKdtlImd5C5LGalCWD8tChefCbB_dtskfWs/edit) |
<!-- sop-section-end -->
