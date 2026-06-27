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
  - sop.media.podcast.managing-podcast-workflow
  - sop.media.podcast.creating-podcast-transcription-document
  - sop.media.podcast.schedule-podcast-episodes-with-spotify-for-podcaster
  - sop.media.podcast.add-a-podcast-episode-via-airtable-form
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
- YouTube stream/video
- Transcription
- Spotify for Podcasters
- Public Spotify episode
- Apple Podcasts episode
- DTC webpage podcast link
- Dropbox recording folder
- Podcast banner or cover
<!-- sop-section-end -->

<!-- sop-section-start: workflow-definition -->
## Workflow Definition

- Template ID: `task-template.tasks.podcast`
- Runtime type: `podcast`
- Trigger: manual creation after a podcast guest agrees and the live stream date is confirmed.
- Anchor date: the live stream date.
- Bundle title variables: `date`, `topic`, `speaker`. Title format: `Podcast: {date} - {topic} - {speaker}`.
- Default owner: `00000000-0000-0000-0000-000000000001`.
- Done criteria: the final social follow-up task reaches `stage: done`, all required bundle links are present, required proof is attached to required-proof tasks, no waiting follow-up is due, and archive/social/newsletter follow-up tasks are complete.

Stages:

| Phase ID | Phase | Stage |
| - | - | - |
| `guest-intake` | Guest intake and date confirmation | `preparation` |
| `prep-document` | Podcast prep document and guest collaboration | `preparation` |
| `event-setup` | Event setup and announcements | `preparation` |
| `pre-event-reminders` | Pre-event reminders | `announced` |
| `live-stream` | Live stream | `announced` |
| `post-production` | Recording, transcript, and YouTube production | `after-event` |
| `publication` | Podcast publication | `after-event` |
| `follow-up-archive` | Guest follow-up, newsletter, social, and archive | `after-event` |
<!-- sop-section-end -->

<!-- sop-section-start: reconciliation -->
## Reconciliation Notes

- The Trello-derived reference in `work-engine/docs/templates.md` lists 40 Podcast tasks.
- The current DataOps git-backed runtime template intentionally keeps 42 tasks.
- Intentional additions relative to the 40-task reference:
  - `upload-recording-dropbox` is explicit because the recording handoff is operational evidence.
  - `moving-podcast-audio-dropbox` is explicit because publication needs the audio file moved to the Podcast Dropbox area.
- No current 42-row task was removed. Existing task refs remain stable.
<!-- sop-section-end -->

<!-- sop-section-start: reminder-risk-and-waiting-semantics -->
## Reminder, Risk, And Waiting Semantics

Default reminders:

- Every task appears in today/overdue views from its due date.
- Required-proof tasks emit `missing-evidence` when completion is attempted or the task is due without the named proof.
- Waiting tasks require `waitingFor`, `followUpAt`, and a short note. They remain active and appear as `follow-up-due` when `followUpAt` arrives.
- Pre-event guest reminders are fixed at 7 days and 1 day before the live stream date.
- Post-event tasks appear from their positive offsets after the live stream date.

At-risk conditions:

- Missing podcast document or unresolved Podcast Assistant TODOs.
- Missing Luma, Meetup, or YouTube stream/video links before the event is announced.
- Missing recording upload, transcript, or YouTube production evidence after the stream.
- Missing Spotify for Podcasters, public Spotify, Apple Podcasts, or DTC podcast page links.
- Any overdue required-proof task or waiting follow-up whose `followUpAt` has passed.
<!-- sop-section-end -->

<!-- sop-section-start: assistant-integration -->
## Assistant Integration

- Raw guest/source material can be collected through the Podcast Assistant and attached to the workflow as `assistant-job.podcast-prep-draft`.
- The expected assistant artifact is `artifact.podcast-assistant-draft` with type `podcast-prep-draft`.
- The operator reviews and accepts the assistant draft inside `create-podcast-document`.
- Accepted assistant output can satisfy the podcast-prep proof when linked or attached to the podcast document.
- Unresolved assistant TODOs become waiting/follow-up work with `waitingFor`, `followUpAt`, and a note.
- Live Telegram, Groq, and Heru execution stays out of this workflow definition; those integrations remain credential-gated follow-up work.
<!-- sop-section-end -->

<!-- sop-section-start: task-execution-matrix -->
## Task Execution Matrix

| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof | Waiting / follow-up | Systems |
| - | - | - | -: | - | - | - | - | - | - |
| 1 | `obtain-speaker-email` | guest-intake | -28 | 00000000-0000-0000-0000-000000000001 | Obtain speaker's email | sop.events.outreach.how-to-find-emails-of-previous-guests | url: Guest email | speaker email or working contact path | email, linkedin, google-search |
| 2 | `create-proposed-calendar-invite` | guest-intake | -27 | 00000000-0000-0000-0000-000000000001 | Create a proposed calendar invite for guest speaker | sop.events.calendar.creating-tentative-event-on-google-calendar | none |  | google-calendar, email |
| 3 | `agree-on-a-date` | guest-intake | -26 | 00000000-0000-0000-0000-000000000001 | Agree on a date | sop.media.podcast.select-and-propose-a-date-for-events | none | guest date confirmation | email, google-calendar |
| 4 | `create-podcast-document` | prep-document | -25 | 00000000-0000-0000-0000-000000000001 | Create a podcast document with the questions | sop.media.podcast.create-podcast-document | url: Podcast document |  | google-drive, google-docs, github, linkedin, twitter, assistant |
| 5 | `include-johanna-ask-guest-bio` | prep-document | -24 | 00000000-0000-0000-0000-000000000001 | Include Johanna and ask the guest their biography and other information | template.media.podcast.podcast-adding-johanna-and-sending-the-podcast-link-to-the-speaker | none | guest bio, links, and prep material | email, google-docs |
| 6 | `add-guest-as-editor` | prep-document | -23 | 00000000-0000-0000-0000-000000000001 | Add the Guest as an Editor on the podcast document | sop.media.podcast.create-podcast-document | none |  | google-docs, email |
| 7 | `share-podcast-document-slack` | prep-document | -22 | 00000000-0000-0000-0000-000000000001 | Share the podcast document on the #dtc-podcast-help | template.media.podcast.sending-podcast-document-on-slack-the-dtc-podcast-help-channel | none |  | slack, google-docs |
| 8 | `create-calendar-invite` | prep-document | -21 | 00000000-0000-0000-0000-000000000001 | Create a calendar invite for guest speaker | sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event | none |  | google-calendar, youtube |
| 9 | `add-guest-bio-to-document` | prep-document | -20 | 00000000-0000-0000-0000-000000000001 | Add a guest bio to the podcast document | sop.media.podcast.add-a-guest-bio-to-the-podcast-document | none | guest bio and links | google-docs, email |
| 10 | `fill-people-form-airtable` | prep-document | -19 | 00000000-0000-0000-0000-000000000001 | Fill in the "people" form in Airtable | sop.events.planning.create-speaker-profiles-via-airtable-form | none |  | airtable |
| 11 | `create-banner-figma` | prep-document | -18 | 00000000-0000-0000-0000-000000000001 | Create a banner for a podcast event in Figma | sop.media.podcast.making-event-announcements-when-topic-bio-or-outline-is-missing | file: Podcast banner or cover |  | figma, google-docs |
| 12 | `create-event-luma` | event-setup | -17 | 00000000-0000-0000-0000-000000000001 | Create an event in Luma | sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma | url: Luma | complete topic, bio, outline, banner, and stream details | luma, google-calendar, youtube |
| 13 | `create-event-meetup` | event-setup | -16 | 00000000-0000-0000-0000-000000000001 | Create an event in Meetup | sop.events.meetup.create-events-in-meetup-com | url: Meetup | Luma event and YouTube stream link | meetup, luma, youtube |
| 14 | `check-meetup-location` | event-setup | -16 | 00000000-0000-0000-0000-000000000001 | Check Meetup if the location is online with the YouTube link | sop.events.meetup.create-events-in-meetup-com | none |  | meetup, youtube |
| 15 | `create-event-calendar` | event-setup | -15 | 00000000-0000-0000-0000-000000000001 | Create event in the DTC community Calendar | sop.events.luma.creating-events-on-google-calendar | none |  | google-calendar, luma |
| 16 | `announce-event-slack` | event-setup | -14 | 00000000-0000-0000-0000-000000000001 | Announce event in Slack in #announcements | sop.events.announce-event-in-slack-in-announcements | comment: Announce event in Slack confirmed |  | slack, luma |
| 17 | `fill-event-form-airtable` | event-setup | -13 | 00000000-0000-0000-0000-000000000001 | Fill in the "event" form in Airtable | sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website | none |  | airtable, luma |
| 18 | `add-event-to-webpage` | event-setup | -12 | 00000000-0000-0000-0000-000000000001 | Add the event to the DataTalks.Club webpage | sop.media.podcast.update-the-website-with-the-information-from-forms | none |  | github, website, airtable |
| 19 | `schedule-posts-linkedin-twitter` | event-setup | -11 | 00000000-0000-0000-0000-000000000001 | Schedule posts on LinkedIn and Twitter | template.social-media.template-new-event-announcements-podcasts-webinars-workshops | none |  | linkedin, twitter, hootsuite |
| 20 | `remind-guest-7d` | pre-event-reminders | -7 | 00000000-0000-0000-0000-000000000001 | Remind the guest about the event | template.media.podcast.podcast-remind-about-the-event-in-a-week-share-registration-link-template | comment: 7-day reminder sent |  | email, luma |
| 21 | `remind-guest-1d` | pre-event-reminders | -1 | 00000000-0000-0000-0000-000000000001 | Remind the guest about the event | template.media.podcast.podcast-remind-the-guest-about-the-event-a-day-before-template | comment: 1-day reminder sent |  | email, luma |
| 22 | `actual-stream` | live-stream | 0 | 00000000-0000-0000-0000-000000000001 | Actual stream | sop.media.podcast.managing-podcast-workflow | url: YouTube stream/video |  | youtube, streamyard, google-calendar |
| 23 | `upload-recording-dropbox` | post-production | 1 | 00000000-0000-0000-0000-000000000003 | Upload the recording to the shared folder in dropbox | sop.media.podcast.managing-podcast-workflow | url: Dropbox recording folder |  | dropbox, youtube |
| 24 | `update-youtube-cover` | post-production | 1 | 00000000-0000-0000-0000-000000000001 | Update the cover of the YouTube video | sop.media.podcast.updating-the-cover-of-the-youtube-video | url: Podcast banner or cover |  | youtube, figma |
| 25 | `remove-beginning-recording` | post-production | 1 | 00000000-0000-0000-0000-000000000001 | Remove the beginning of the recording | sop.media.podcast.removing-the-beginning-from-the-youtube-stream | none |  | youtube |
| 26 | `recheck-video-edit` | post-production | 2 | 00000000-0000-0000-0000-000000000001 | Recheck the video if the edit is successful | sop.media.podcast.removing-the-beginning-from-the-youtube-stream | external-status: Edited YouTube video verified |  | youtube |
| 27 | `create-transcript-document` | post-production | 2 | 00000000-0000-0000-0000-000000000001 | Create the transcript document | sop.media.podcast.creating-podcast-transcription-document | url: Transcription | freelancer transcript handoff and returned transcript | google-docs, dropbox, email |
| 28 | `add-to-playlists` | post-production | 2 | 00000000-0000-0000-0000-000000000001 | Add the video to "livestream" and "podcast" playlists on YouTube | sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist | none |  | youtube |
| 29 | `add-youtube-link-to-website` | post-production | 3 | 00000000-0000-0000-0000-000000000001 | Add the YouTube link of the stream to the website | sop.media.podcast.add-links-to-youtube-after-the-stream-is-over | none |  | github, website, youtube |
| 30 | `edit-video-description` | post-production | 3 | 00000000-0000-0000-0000-000000000001 | Edit video description | sop.media.podcast.add-links-to-youtube-after-the-stream-is-over | none |  | youtube |
| 31 | `include-timecodes` | post-production | 3 | 00000000-0000-0000-0000-000000000001 | Include timecodes extracted from the transcription | sop.media.podcast.generate-timecodes-from-docx-transcriptions | none |  | youtube, google-docs |
| 32 | `ask-guest-for-links` | post-production | 1 | 00000000-0000-0000-0000-000000000001 | Ask the guest for links after the stream | template.media.podcast.podcast-links-after-the-event-is-over | none | guest post-stream links | email, google-docs |
| 33 | `schedule-podcast-spotify` | publication | 4 | 00000000-0000-0000-0000-000000000001 | Schedule the edited podcast episode with Spotify for Podcasters | sop.media.podcast.schedule-podcast-episodes-with-spotify-for-podcaster | url: Spotify for Podcasters | public Spotify and Apple Podcasts publication links | spotify, apple-podcasts |
| 34 | `moving-podcast-audio-dropbox` | publication | 4 | 00000000-0000-0000-0000-000000000001 | Moving Podcast Audio in Dropbox | sop.media.podcast.moving-podcast-audio-in-dropbox | none |  | dropbox |
| 35 | `add-podcast-episode-airtable` | publication | 4 | 00000000-0000-0000-0000-000000000001 | Add a podcast episode via Airtable form | sop.media.podcast.add-a-podcast-episode-via-airtable-form | url: Public Spotify episode |  | airtable, spotify, apple-podcasts |
| 36 | `create-podcast-page` | publication | 5 | 00000000-0000-0000-0000-000000000001 | Create a podcast page with the information from the form | sop.media.podcast.update-the-website-with-the-information-from-forms | url: DTC webpage podcast link |  | github, website, airtable |
| 37 | `ask-guest-share-podcast-page` | follow-up-archive | 5 | 00000000-0000-0000-0000-000000000001 | Ask the guest to share the podcast page | template.media.podcast.podcast-share-the-podcast-page-template | none | guest reply or share confirmation | email, website |
| 38 | `move-podcast-documents-archive` | follow-up-archive | 5 | 00000000-0000-0000-0000-000000000001 | Move the podcast documents to archive in google drive | sop.media.podcast.move-podcast-documents-to-archive-in-google-drive | none |  | google-drive |
| 39 | `upload-luma-emails-mailchimp` | follow-up-archive | 5 | 00000000-0000-0000-0000-000000000001 | Upload the emails from Luma to Mailchimp | sop.events.luma.downloading-the-csv-file-on-luma | none |  | luma, mailchimp |
| 40 | `add-podcast-webpage-newsletter` | follow-up-archive | 6 | 00000000-0000-0000-0000-000000000002 | Add the podcast webpage to the newsletter | sop.media.podcast.sending-a-podcast-scheduled-email-to-pavel-after-the-event | none |  | mailchimp, website |
| 41 | `schedule-posts-overview-after-event` | follow-up-archive | 6 | 00000000-0000-0000-0000-000000000001 | Schedule posts "overview after the event" on LinkedIn and Twitter | reference.social-media.post-podcast-overview-after-the-event | none |  | linkedin, twitter, hootsuite |
| 42 | `schedule-posts-guest-recommendations` | follow-up-archive | 7 | 00000000-0000-0000-0000-000000000001 | Schedule posts "Guest recommendations" on LinkedIn and Twitter | sop.social-media.post-podcast-guest-recommendations | comment: Guest recommendations scheduled |  | linkedin, twitter, hootsuite |
<!-- sop-section-end -->

<!-- sop-section-start: sample-instantiation -->
## Sample Instantiation

For anchor date `2026-08-17`:

- `create-podcast-document` is due `2026-07-23`.
- `remind-guest-7d` is due `2026-08-10`.
- `remind-guest-1d` is due `2026-08-16`.
- `actual-stream` is due `2026-08-17` and moves the bundle to `after-event` when completed with the YouTube link.
- `schedule-podcast-spotify` is due `2026-08-21` and requires Spotify for Podcasters, public Spotify, and Apple Podcasts evidence.
- `schedule-posts-guest-recommendations` is due `2026-08-24` and moves the bundle to `done`.
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
| 22 | `actual-stream` | 0 | Actual stream | milestone<br>stage: after-event<br>link: YouTube stream/video |  |
| 23 | `upload-recording-dropbox` | 1 | Upload the recording to the shared folder in dropbox | assignee: 00000000-0000-0000-0000-000000000003<br>link: Dropbox recording folder |  |
| 24 | `update-youtube-cover` | 1 | Update the cover of the YouTube video | link: Podcast banner or cover | [open](https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit) |
| 25 | `remove-beginning-recording` | 1 | Remove the beginning of the recording |  | [open](https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit) |
| 26 | `recheck-video-edit` | 2 | Recheck the video if the edit is successful |  |  |
| 27 | `create-transcript-document` | 2 | Create the transcript document | link: Transcription | [open](https://docs.google.com/document/d/1lkvu5T4fVT0nnmjIPolLCT4o4dUc3iZ2b7jWycVrtPU/edit) |
| 28 | `add-to-playlists` | 2 | Add the video to "livestream" and "podcast" playlists on YouTube |  | [open](https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit) |
| 29 | `add-youtube-link-to-website` | 3 | Add the YouTube link of the stream to the website |  | [open](https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit) |
| 30 | `edit-video-description` | 3 | Edit video description |  | [open](https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit) |
| 31 | `include-timecodes` | 3 | Include timecodes extracted from the transcription |  | [open](https://docs.google.com/document/d/1RrTDKmxs9iN2YKnYQ9uSQvdUXRGxPJJ3u7RiQWnCyCw/edit) |
| 32 | `ask-guest-for-links` | 1 | Ask the guest for links after the stream |  | [open](https://docs.google.com/document/d/1tsuI291-eJ8CxK5MHajEKK3ODZ_TOHfX-XZ-csAFX8Y/edit) |
| 33 | `schedule-podcast-spotify` | 4 | Schedule the edited podcast episode with Spotify for Podcasters | link: Spotify for Podcasters | [open](https://docs.google.com/document/d/1moSrrDw501TzG3X_DqreK2ZkhRZ40I_d9lCjhF4agQA/edit) |
| 34 | `moving-podcast-audio-dropbox` | 4 | Moving Podcast Audio in Dropbox |  | [open](https://docs.google.com/document/d/1PTfM18NgBRICm70hPMcYntCEs_uNxh0lYERhmDcusGA/edit) |
| 35 | `add-podcast-episode-airtable` | 4 | Add a podcast episode via Airtable form | link: Public Spotify episode | [open](https://docs.google.com/document/d/1nUvqLRX18fEWgqeJO-9FNuXDX8SBZpjauIjvfXwaL4k/edit) |
| 36 | `create-podcast-page` | 5 | Create a podcast page with the information from the form | link: DTC webpage podcast link | [open](https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit) |
| 37 | `ask-guest-share-podcast-page` | 5 | Ask the guest to share the podcast page |  | [open](https://docs.google.com/document/d/1ojQTnenw5yfKL_hn4LCDzfbVRcNxbvNFfEO_1PiIbDQ/edit) |
| 38 | `move-podcast-documents-archive` | 5 | Move the podcast documents to archive in google drive |  | [open](https://docs.google.com/document/d/1wEs9firI_tlbSNt4jPWTAgTZT1_eaQ6P9VSoDoybu48/edit) |
| 39 | `upload-luma-emails-mailchimp` | 5 | Upload the emails from Luma to Mailchimp |  | [open](https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit) |
| 40 | `add-podcast-webpage-newsletter` | 6 | Add the podcast webpage to the newsletter | assignee: 00000000-0000-0000-0000-000000000002 | [open](https://docs.google.com/document/d/1Q6eKmPKAa7LE8-HZrKV9NOdCJLOwlIqB0Txo6aFZUbg/edit) |
| 41 | `schedule-posts-overview-after-event` | 6 | Schedule posts "overview after the event" on LinkedIn and Twitter |  | [open](https://docs.google.com/document/d/1156ty59e3ZlUW3nPpMTd_2smzW40v0ANt9nojUxZ2Gc/edit) |
| 42 | `schedule-posts-guest-recommendations` | 7 | Schedule posts "Guest recommendations" on LinkedIn and Twitter | milestone<br>stage: done | [open](https://docs.google.com/document/d/1XDOfmUHMjKdtlImd5C5LGalCWD8tChefCbB_dtskfWs/edit) |
<!-- sop-section-end -->
