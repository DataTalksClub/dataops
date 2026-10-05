# Templates Reference — Part 2: Event templates

> Part 2 of 4 of the [templates reference](../templates.md):
> [Part 1](part-1-recurring-publication-templates.md) covers recurring publication templates (Newsletter, Book of the Week, Open-Source Spotlight, Course, Social Media Weekly Posts);
> this part covers event templates (Podcast, Webinar, Workshop);
> [Part 3](part-3-periodic-operations-templates.md) covers periodic operations templates (Tax Report, Maven Lightning Lesson, Office Hours);
> [Part 4](part-4-summary-and-shared-tasks.md) covers the cross-template summary and the shared task lists.

## 3. Podcast

- Trello name: `🎙️ [Podcast] 2026-MMM-DD - Topic - Name`
- Type: podcast
- Display:
  - Emoji: 🎙️
  - Tags: Podcast
  - Title: {TOPIC} - {SPEAKER}
- Anchor date: Live stream date
- Trigger: manual. Created when a podcast guest agrees and a stream date is confirmed

Live podcast recording streamed on YouTube, then edited and published to Spotify and Apple Podcasts. Most complex Trello-derived reference with 40 tasks. The canonical executable DataOps workflow is `content/tasks/templates/podcast.md` and `work-engine/scripts/seed-templates.ts`; it intentionally keeps 42 task refs by making the Dropbox recording upload and Podcast audio move explicit runtime tasks.

Card links:
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

References:
- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Events](https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit)
- [Events (live) - podcast](https://docs.google.com/document/d/19d_kBOVQJ2p5qZCtGywzWzYeyCv5FWeHApZnEUZIYRg/edit)

Tasks (40):

- Obtain speaker's email
- Create a proposed calendar invite for guest speaker
  - instructions: https://docs.google.com/document/d/1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k/edit
- Agree on a date
  - instructions: https://docs.google.com/document/d/1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k/edit
- Create a podcast document with the questions
  - instructions: https://docs.google.com/document/d/1IVNQQs-Hk-8LzZWox8YWbShJ6Y3sl47H5Z2PC2ra9ZU/edit
- Include Johanna and ask the guest their biography and other information
  - instructions: https://docs.google.com/document/d/1Ix73NmCJPfYs0HcokxG5sORj0bFxtZsLrZTLHsp_DDM/edit
- Add the Guest as an Editor on the podcast document
- Share the podcast document on the #dtc-podcast-help
  - instructions: https://docs.google.com/document/d/1pVL13ku-_zwlqQk8PhmxJkxnRylxzDIKImlzH526k1M/edit
- Create a calendar invite for guest speaker
  - instructions: https://docs.google.com/document/d/1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs/edit
- Add a guest bio to the podcast document
  - instructions: https://docs.google.com/document/d/1mijZcQ6qRXCscG0DVx6UA9KGgUT_QVTDUSWpQl4aqhE/edit
- Fill in the "people" form in Airtable
  - instructions: https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit
- Create a banner for a podcast event in Figma
  - instructions: https://docs.google.com/document/d/1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI/edit
- Create an event in Luma
  - instructions: https://docs.google.com/document/d/1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8/edit
- Create an event in Meetup
  - instructions: https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit
- Check Meetup if the location is online with the YouTube link
  - instructions: https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit
- Create event in the DTC community Calendar
  - instructions: https://docs.google.com/document/d/1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE/edit
- Announce event in Slack in #announcements
  - instructions: https://docs.google.com/document/d/1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ/edit
- Fill in the "event" form in Airtable
  - instructions: https://docs.google.com/document/d/1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8/edit
- Add the event to the DataTalks.Club webpage
  - instructions: https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit
- Schedule posts on LinkedIn and Twitter
  - instructions: https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit
- Remind the guest about the event [milestone: -7d]
  - instructions: https://docs.google.com/document/d/1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA/edit
- Remind the guest about the event [milestone: -1d]
  - instructions: https://docs.google.com/document/d/1JSHCMgOufo0UrUD2XE1D4rLc1H0jROTjZB9ARCGeZrk/edit
- Actual stream [milestone: anchor]
- Upload the recording to the shared folder in dropbox (assignee: Alexey)
- Update the cover of the YouTube video
  - instructions: https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit
- Remove the beginning of the recording
  - instructions: https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit
- Recheck the video if the edit is successful
- Create the transcript document
  - instructions: https://docs.google.com/document/d/1lkvu5T4fVT0nnmjIPolLCT4o4dUc3iZ2b7jWycVrtPU/edit
- Add the video to "livestream" and "podcast" playlists on YouTube
  - instructions: https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit
- Add the YouTube link of the stream to the website
  - instructions: https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit
- Edit video description
  - instructions: https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit
- Include timecodes extracted from the transcription
  - instructions: https://docs.google.com/document/d/1RrTDKmxs9iN2YKnYQ9uSQvdUXRGxPJJ3u7RiQWnCyCw/edit
- Ask the guest for links after the stream
  - instructions: https://docs.google.com/document/d/1tsuI291-eJ8CxK5MHajEKK3ODZ_TOHfX-XZ-csAFX8Y/edit
- Schedule the edited podcast episode with Spotify for Podcasters
  - instructions: https://docs.google.com/document/d/1moSrrDw501TzG3X_DqreK2ZkhRZ40I_d9lCjhF4agQA/edit
- Moving Podcast Audio in Dropbox
  - instructions: https://docs.google.com/document/d/1PTfM18NgBRICm70hPMcYntCEs_uNxh0lYERhmDcusGA/edit
- Add a podcast episode via Airtable form
  - instructions: https://docs.google.com/document/d/1nUvqLRX18fEWgqeJO-9FNuXDX8SBZpjauIjvfXwaL4k/edit
- Create a podcast page with the information from the form
  - instructions: https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit
- Ask the guest to share the podcast page
  - instructions: https://docs.google.com/document/d/1ojQTnenw5yfKL_hn4LCDzfbVRcNxbvNFfEO_1PiIbDQ/edit
- Move the podcast documents to archive in google drive
  - instructions: https://docs.google.com/document/d/1wEs9firI_tlbSNt4jPWTAgTZT1_eaQ6P9VSoDoybu48/edit
- Upload the emails from Luma to Mailchimp
  - instructions: https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit
- Add the podcast webpage to the newsletter (assignee: Valeriia)
  - instructions: https://docs.google.com/document/d/1Q6eKmPKAa7LE8-HZrKV9NOdCJLOwlIqB0Txo6aFZUbg/edit
- Schedule posts "overview after the event" on LinkedIn and Twitter
  - instructions: https://docs.google.com/document/d/1156ty59e3ZlUW3nPpMTd_2smzW40v0ANt9nojUxZ2Gc/edit
- Schedule posts "Guest recommendations" on LinkedIn and Twitter [milestone: +7d]
  - instructions: https://docs.google.com/document/d/1XDOfmUHMjKdtlImd5C5LGalCWD8tChefCbB_dtskfWs/edit

---

## 4. Webinar

- Trello name: `📺 [Webinar] 2026-MMM-DD - Topic - Speaker`
- Type: webinar
- Display:
  - Emoji: 📺
  - Tags: Webinar
  - Title: {TOPIC} - {SPEAKER}
- Anchor date: Live stream date
- Trigger: manual. Created when a webinar speaker agrees and a stream date is confirmed

Live webinar streamed on YouTube. Similar workflow to podcast but without the podcast-specific publishing steps.

Card links:
- Guest email
- Luma
- Meetup
- Youtube

References:
- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Events](https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit)
- [Events (live) - webinar](https://docs.google.com/document/d/1x7MJa_K0ZmuWw5NkTbmUFM9welTD8j86evcRl1c7VtY/edit)

Tasks (28):

- Initial contact with the speaker asking for details
  - instructions: https://docs.google.com/document/d/1Hfz6KIIVKDL98t1j0_erGs0RAYCBnJdRjuuFfAxYxHg/edit
- Agree on a date
  - instructions: https://docs.google.com/document/d/1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k/edit
- Create a calendar invite for the guests
  - instructions: https://docs.google.com/document/d/1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs/edit
- Get information about the event: title, subtitle, outline
  - instructions: https://docs.google.com/document/d/1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q/edit
- Fill in the "people" form in Airtable
  - instructions: https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit
- Create a banner for a webinar event in Figma
  - instructions: https://docs.google.com/document/d/1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI/edit
- Create events on Luma
  - instructions: https://docs.google.com/document/d/1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8/edit
- Create events on Meetup
  - instructions: https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit
- Check Meetup if the location is online with the YouTube link
- Create events on LinkedIn
  - instructions: https://docs.google.com/document/d/1ZwnCpleU0xQqZV02KVNSO24gu8HIHIrZdbHLGnZx52k/edit
- Create event in Calendar
  - instructions: https://docs.google.com/document/d/1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE/edit
- Fill in the "event" form in Airtable
  - instructions: https://docs.google.com/document/d/1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8/edit
- Add the event to the DataTalks.Club webpage
  - instructions: https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit
- Send Luma link to Valeriia for newsletter
- Announce event in Slack
  - instructions: https://docs.google.com/document/d/1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ/edit
- Schedule posts on LinkedIn and Twitter
  - instructions: https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit
- Remind the guest about the event [milestone: -7d]
  - instructions: https://docs.google.com/document/d/1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA/edit
- Remind the guest about the event [milestone: -1d]
  - instructions: https://docs.google.com/document/d/1rMvF296VSzgMvw5Pmy0azE374ZaRHSak2yXVxJGyyTU/edit
- Actual stream [milestone: anchor]
- Update the cover of the YouTube video
  - instructions: https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit
- Remove the beginning of the recording
  - instructions: https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit
- Recheck the video if the edit is successful
- Generate Timecodes Using Youtube Video Transcripts
  - instructions: https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit
- Adding timecodes to YouTube videos
  - instructions: https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit
- Add the video to "livestream" and "webinar" playlists on YouTube
  - instructions: https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit
- Add the YouTube link of the stream to the website
  - instructions: https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit
- Upload the emails from Luma to Mailchimp
  - instructions: https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit
- For sponsored events - share the list with emails with the sponsor
  - instructions: https://docs.google.com/document/d/1qf38niJVSAFYz0hkTXVma_bvM9EpArQLUD4wF4YB_Ok/edit
- Ask for speaker recommendations and ask the guest to share the video
  - instructions: https://docs.google.com/document/d/1KuKKupkYHs6V5rdEhbpblIJ2zQcHPJrdauFANX_kA0o/edit
- Add links from the speaker to the YouTube video
  - instructions: https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit
- Fill in the newsletter announcement (assignee: Valeriia)
- Publish social media announcement

---

## 5. Workshop

- Trello name: `🔧 [Workshop] 2026-MMM-DD - Title - Name`
- Type: workshop
- Display:
  - Emoji: 🔧
  - Tags: Workshop
  - Title: {TOPIC} - {SPEAKER}
- Anchor date: Live stream date
- Trigger: manual. Created when a workshop speaker agrees and a stream date is confirmed

Live workshop streamed on YouTube. Can be sponsored. Similar to webinar but includes workshop document creation and potential sponsorship handling.

Card links:
- Workshop document
- Guest email
- Luma
- Meetup
- LinkedIn
- Youtube

References:
- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Events](https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit)
- [Events (live) - workshop](https://docs.google.com/document/d/1tbOClURp1j3MolPY5cI9HzA0QUi8rkXWU_M69RP5BcY/edit)

Tasks (30):

- Initial contact with the speaker asking for details
  - instructions: https://docs.google.com/document/d/1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q/edit
- Agree on a date
- Create a Workshop Document
- Create calendar invites for workshops
  - instructions: https://docs.google.com/document/d/1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs/edit
- Get information about the event: title, subtitle, outline
  - instructions: https://docs.google.com/document/d/1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q/edit
- Fill in the "people" form in Airtable
  - instructions: https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit
- Create a banner for a workshop event in Figma
  - instructions: https://docs.google.com/document/d/1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI/edit
- Create events on Luma
  - instructions: https://docs.google.com/document/d/1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8/edit
- Create events on Meetup
  - instructions: https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit
- Check Meetup if the location is online with the YouTube link
- Create events on LinkedIn
  - instructions: https://docs.google.com/document/d/1ZwnCpleU0xQqZV02KVNSO24gu8HIHIrZdbHLGnZx52k/edit
- Create event in Calendar
  - instructions: https://docs.google.com/document/d/1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE/edit
- Fill in the "event" form in Airtable
  - instructions: https://docs.google.com/document/d/1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8/edit
- Add the event to the DataTalks.Club webpage
  - instructions: https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit
- Send Luma link to Valeriia for newsletter
- Announce event in Slack in #announcements
  - instructions: https://docs.google.com/document/d/1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ/edit
- Announce event on different communities [milestone: -1d]
  - instructions: https://docs.google.com/document/d/1VWitGUErmKn8JfzBEYx3BVa-lSl-tLPB2bLDtPFWi9Q/edit
- Schedule posts on LinkedIn and Twitter
  - instructions: https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit
- Prepare and send an Invoice for Sponsored Workshop
  - instructions: https://docs.google.com/document/d/1PeLSKvs76XiP-bG4WviQur4pQS0Ie25w9I50CZkJYZs/edit
- Remind the guest about the event [milestone: -7d]
  - instructions: https://docs.google.com/document/d/1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA/edit
- Remind the guest about the event [milestone: -1d]
  - instructions: https://docs.google.com/document/d/1rMvF296VSzgMvw5Pmy0azE374ZaRHSak2yXVxJGyyTU/edit
- Actual stream [milestone: anchor]
- Update the cover of the YouTube video
  - instructions: https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit
- Remove the beginning of the recording
  - instructions: https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit
- Recheck the video if the edit is successful
- Generate Timecodes Using Youtube Video Transcripts
  - instructions: https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit
- Adding timecodes to YouTube videos
  - instructions: https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit
- Add the video to "livestream" and "workshop" playlists on YouTube
  - instructions: https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit
- Add the YouTube link of the stream to the website
  - instructions: https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit
- Publish Social Media Announcement
- Ask guests to share the videos with their networks
  - instructions: https://docs.google.com/document/d/1TYQGVzdcoTH9-ULzFWK-2nGt8X-50ju5kYcnJV4F83M/edit
- For sponsored workshop, ask the sponsor about how did it go
  - instructions: https://docs.google.com/document/d/1kdrmpwrvDjYf_cNVJaLo6qhVJ2B7a5As-DrAx_mYWb8/edit
- Upload the emails from Luma to Mailchimp
  - instructions: https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit
- For sponsored events - share the list with emails with the sponsor
  - instructions: https://docs.google.com/document/d/1qf38niJVSAFYz0hkTXVma_bvM9EpArQLUD4wF4YB_Ok/edit
- Add links from the speaker to the YouTube video
  - instructions: https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit
- Check if the Sponsored workshop Invoice has been paid
