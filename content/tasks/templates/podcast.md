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
  - sop.media.podcast.reach-out-to-guests-and-propose-a-date-on-linkedin
  - sop.media.podcast.select-and-propose-a-date-for-events
  - sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event
  - sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma
  - sop.events.meetup.create-events-in-meetup-com
  - sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website
  - sop.events.announce-event-in-slack-in-announcements
  - sop.media.podcast.creating-podcast-transcription-document
  - sop.media.podcast.schedule-podcast-episodes-with-spotify-for-podcaster
  - sop.media.podcast.add-a-podcast-episode-via-airtable-form
  - sop.media.podcast.move-podcast-documents-to-archive-in-google-drive
  - sop.social-media.post-podcast-guest-recommendations
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
- Trigger: manual.
- Default owner: `00000000-0000-0000-0000-000000000001`.

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

<!-- sop-section-start: task-definitions -->
## Task Definitions

| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof / closure | Waiting / follow-up |
| - | - | - | -: | - | - | - | - | - |
| 1 | `obtain-speaker-email` | guest-intake | -28 |  | Obtain speaker's email | sop.events.outreach.how-to-find-emails-of-previous-guests | url: Guest email | speaker email or working contact path |
| 2 | `create-proposed-calendar-invite` | guest-intake | -27 |  | Create a proposed calendar invite for guest speaker | sop.events.calendar.creating-tentative-event-on-google-calendar<br>step 1 | none |  |
| 3 | `agree-on-a-date` | guest-intake | -26 |  | Agree on a date | sop.media.podcast.select-and-propose-a-date-for-events<br>step 1 | none | guest date confirmation |
| 4 | `create-podcast-document` | prep-document | -25 |  | Create a podcast document with the questions | sop.media.podcast.create-podcast-document<br>step 1 | url: Podcast document |  |
| 5 | `include-johanna-ask-guest-bio` | prep-document | -24 |  | Include Johanna and ask the guest their biography and other information | template.media.podcast.podcast-adding-johanna-and-sending-the-podcast-link-to-the-speaker | none | guest bio, links, and prep material |
| 6 | `add-guest-as-editor` | prep-document | -23 |  | Add the Guest as an Editor on the podcast document | sop.media.podcast.create-podcast-document<br>step 6 | none |  |
| 7 | `share-podcast-document-slack` | prep-document | -22 |  | Share the podcast document on the #dtc-podcast-help | template.media.podcast.sending-podcast-document-on-slack-the-dtc-podcast-help-channel | none |  |
| 8 | `create-calendar-invite` | prep-document | -21 |  | Create a calendar invite for guest speaker | sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event<br>step 1 | none |  |
| 9 | `add-guest-bio-to-document` | prep-document | -20 |  | Add a guest bio to the podcast document | sop.media.podcast.add-a-guest-bio-to-the-podcast-document<br>step 1 | none | guest bio and links |
| 10 | `fill-people-form-airtable` | prep-document | -19 |  | Fill in the "people" form in Airtable | sop.events.planning.create-speaker-profiles-via-airtable-form<br>step 1 | none |  |
| 11 | `create-banner-figma` | prep-document | -18 |  | Create a banner for a podcast event in Figma | sop.media.podcast.making-event-announcements-when-topic-bio-or-outline-is-missing | file: Podcast banner or cover |  |
| 12 | `create-event-luma` | event-setup | -17 |  | Create an event in Luma | sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma<br>step 1 | url: Luma | complete topic, bio, outline, banner, and stream details |
| 13 | `create-event-meetup` | event-setup | -16 |  | Create an event in Meetup | sop.events.meetup.create-events-in-meetup-com<br>step 1 | url: Meetup | Luma event and YouTube stream link |
| 14 | `check-meetup-location` | event-setup | -16 |  | Check Meetup if the location is online with the YouTube link | sop.events.meetup.create-events-in-meetup-com | none |  |
| 15 | `create-event-calendar` | event-setup | -15 |  | Create event in the DTC community Calendar | sop.events.luma.creating-events-on-google-calendar | none |  |
| 16 | `announce-event-slack` | event-setup | -14 |  | Announce event in Slack in #announcements | sop.events.announce-event-in-slack-in-announcements<br>step 1 | comment: Announce event in Slack in #announcements confirmed |  |
| 17 | `fill-event-form-airtable` | event-setup | -13 |  | Fill in the "event" form in Airtable | sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website<br>step 1 | none |  |
| 18 | `add-event-to-webpage` | event-setup | -12 |  | Add the event to the DataTalks.Club webpage | sop.media.podcast.update-the-website-with-the-information-from-forms | none |  |
| 19 | `schedule-posts-linkedin-twitter` | event-setup | -11 |  | Schedule posts on LinkedIn and Twitter | template.social-media.template-new-event-announcements-podcasts-webinars-workshops | none |  |
| 20 | `remind-guest-7d` | pre-event-reminders | -7 |  | Remind the guest about the event | template.media.podcast.podcast-remind-about-the-event-in-a-week-share-registration-link-template | comment: Remind the guest about the event confirmed |  |
| 21 | `remind-guest-1d` | pre-event-reminders | -1 |  | Remind the guest about the event | template.media.podcast.podcast-remind-the-guest-about-the-event-a-day-before-template | comment: Remind the guest about the event confirmed |  |
| 22 | `actual-stream` | live-stream | 0 |  | Actual stream | sop.media.podcast.managing-podcast-workflow<br>step 1 | url: YouTube stream/video |  |
| 23 | `upload-recording-dropbox` | post-production | 1 | 00000000-0000-0000-0000-000000000003 | Upload the recording to the shared folder in dropbox | sop.media.podcast.managing-podcast-workflow<br>step 1 | url: Dropbox recording folder |  |
| 24 | `update-youtube-cover` | post-production | 1 |  | Update the cover of the YouTube video | sop.media.podcast.updating-the-cover-of-the-youtube-video<br>step 1 | url: Podcast banner or cover |  |
| 25 | `remove-beginning-recording` | post-production | 1 |  | Remove the beginning of the recording | sop.media.podcast.removing-the-beginning-from-the-youtube-stream<br>step 1 | none |  |
| 26 | `recheck-video-edit` | post-production | 2 |  | Recheck the video if the edit is successful | sop.media.podcast.removing-the-beginning-from-the-youtube-stream | external-status: Edited YouTube video verified |  |
| 27 | `create-transcript-document` | post-production | 2 |  | Create the transcript document | sop.media.podcast.creating-podcast-transcription-document<br>step 1 | url: Transcription | freelancer transcript handoff and returned transcript |
| 28 | `add-to-playlists` | post-production | 2 |  | Add the video to "livestream" and "podcast" playlists on YouTube | sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist | none |  |
| 29 | `add-youtube-link-to-website` | post-production | 3 |  | Add the YouTube link of the stream to the website | sop.media.podcast.add-links-to-youtube-after-the-stream-is-over<br>step 1 | none |  |
| 30 | `edit-video-description` | post-production | 3 |  | Edit video description | sop.media.podcast.add-links-to-youtube-after-the-stream-is-over | none |  |
| 31 | `include-timecodes` | post-production | 3 |  | Include timecodes extracted from the transcription | sop.media.podcast.generate-timecodes-from-docx-transcriptions<br>step 1 | none |  |
| 32 | `ask-guest-for-links` | post-production | 1 |  | Ask the guest for links after the stream | template.media.podcast.podcast-links-after-the-event-is-over | none | guest post-stream links |
| 33 | `schedule-podcast-spotify` | publication | 4 |  | Schedule the edited podcast episode with Spotify for Podcasters | sop.media.podcast.schedule-podcast-episodes-with-spotify-for-podcaster<br>step 1 | url: Spotify for Podcasters | public Spotify and Apple Podcasts publication links |
| 34 | `moving-podcast-audio-dropbox` | publication | 4 |  | Moving Podcast Audio in Dropbox | sop.media.podcast.moving-podcast-audio-in-dropbox<br>step 1 | none |  |
| 35 | `add-podcast-episode-airtable` | publication | 4 |  | Add a podcast episode via Airtable form | sop.media.podcast.add-a-podcast-episode-via-airtable-form<br>step 1 | url: Public Spotify episode |  |
| 36 | `create-podcast-page` | publication | 5 |  | Create a podcast page with the information from the form | sop.media.podcast.update-the-website-with-the-information-from-forms | url: DTC webpage podcast link |  |
| 37 | `ask-guest-share-podcast-page` | follow-up-archive | 5 |  | Ask the guest to share the podcast page | template.media.podcast.podcast-share-the-podcast-page-template | none | guest reply or share confirmation |
| 38 | `move-podcast-documents-archive` | follow-up-archive | 5 |  | Move the podcast documents to archive in google drive | sop.media.podcast.move-podcast-documents-to-archive-in-google-drive<br>step 1 | none |  |
| 39 | `upload-luma-emails-mailchimp` | follow-up-archive | 5 |  | Upload the emails from Luma to Mailchimp | sop.events.luma.downloading-the-csv-file-on-luma | none |  |
| 40 | `add-podcast-webpage-newsletter` | follow-up-archive | 6 | 00000000-0000-0000-0000-000000000002 | Add the podcast webpage to the newsletter | sop.media.podcast.sending-a-podcast-scheduled-email-to-pavel-after-the-event | none |  |
| 41 | `schedule-posts-overview-after-event` | follow-up-archive | 6 |  | Schedule posts "overview after the event" on LinkedIn and Twitter | reference.social-media.post-podcast-overview-after-the-event | none |  |
| 42 | `schedule-posts-guest-recommendations` | follow-up-archive | 7 |  | Schedule posts "Guest recommendations" on LinkedIn and Twitter | sop.social-media.post-podcast-guest-recommendations | comment: Schedule posts "Guest recommendations" on LinkedIn and Twitter confirmed |  |
<!-- sop-section-end -->
