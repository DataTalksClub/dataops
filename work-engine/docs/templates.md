# Templates Reference

Extracted from the Trello board export. 11 active templates.

Notes on mapping to our data model:
- Trello has two-level hierarchy: checklists (phases) -> items (tasks). We flatten into a single task list per template.
- Trello has no explicit offset days. We derive them from checklist ordering and timing hints in task names (e.g., "one week before", "2 weeks before").
- Many tasks reference Google Docs process documents via markdown links - these map to `instructionsUrl`.
- Some tasks mention specific assignees (e.g., "– Valeriia", "– Alexey") - these map to per-task `assigneeId`.
- Checklist names become phase groupings - useful for understanding the workflow but flattened in our model.

---

## 1. Newsletter

- Trello name: `📰 [Newsletter] Weekly email #XXX (DD MMM YYYY) -sponsored -book-of-the-week`
- Type: newsletter
- Display:
  - Emoji: 📰
  - Tags: Newsletter
  - Title: Weekly email #{NUMBER}
- Anchor date: Newsletter publish day
- Trigger: automatic, weekly. Create bundle 14 days before publish day (sponsor needs 2 weeks lead time)

Weekly newsletter published via MailChimp. Includes sponsored content, book of the week feature, event announcements, podcast highlights, and articles.

Bundle links:
- Sponsorship document
- Mailchimp newsletter
- LinkedIn
- X

References:
- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Newsletter](https://docs.google.com/document/d/10sqvW0RqHJ2xQaoJQB0Ce0E21QPPAef5UwWrx0aT2XA/edit)

Tasks (15):

- Create sponsorship document
  - instructions: https://docs.google.com/document/d/1N3tLKK1oDpRep1R5uZ5hhy9b9pDPi21qI_cO44vO7W8/edit
- Email the sponsor with the sponsorship document - add Valeriia in communication [milestone: -14d]
  - instructions: https://docs.google.com/document/d/1cgUOAdSp9eqad4MUiEdFBCEb3v0PSB3DiCeYzcJrsrs/edit
- Create a MailChimp campaign
  - instructions: https://docs.google.com/document/d/1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ/edit
- Fill up "Sponsored" block (after sponsorship document is completed)
  - instructions: https://docs.google.com/document/d/1kuuUAZl0TBlc9jgzH99GxJ9zGGqwDrTZeMzuIlqDKiA/edit
- Fill up "Book of the week" block (assignee: Valeriia)
  - instructions: https://docs.google.com/document/d/10y0CCq8ApFbH1Mx7wlh_b_ZudnPib9qk_tDysA99xNg/edit
- Fill up "Event" block (assignee: Valeriia)
  - instructions: https://docs.google.com/document/d/1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ/edit
- Fill up "Podcast" block (assignee: Valeriia)
  - instructions: https://docs.google.com/document/d/1Q6eKmPKAa7LE8-HZrKV9NOdCJLOwlIqB0Txo6aFZUbg/edit
- Fill up "Article" block (assignee: Valeriia)
  - instructions: https://docs.google.com/document/d/1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ/edit
- Schedule Email Newsletter
  - instructions: https://docs.google.com/document/d/1hY7nMMRqooMpmCV0gl0aNfAePUajYLyylW0JUTdiwEM/edit
- Create an Invoice
  - instructions: https://docs.google.com/document/d/1PeLSKvs76XiP-bG4WviQur4pQS0Ie25w9I50CZkJYZs/edit
- Send email to notify sponsor that publication is live
  - instructions: https://docs.google.com/document/d/1mIm41ciFJ4aF0lUKbJzbeD_dF7vF-gqEti-vQOJ_mTQ/edit
- Schedule Sponsorship content on LinkedIn
  - instructions: https://docs.google.com/document/d/1pHfmmVGnNKGM4i0um3M5yqpgZJlb6sgHGl0eZ1abW-A/edit
- Schedule Sponsorship content on Twitter
  - instructions: https://docs.google.com/document/d/18Pm55ewbv1FoO4Cz_Dx-vWICPa0QhgrXiEsvZX7b6DQ/edit
- Add newsletter performance on the spreadsheet [milestone: +7d]
  - instructions: https://docs.google.com/document/d/1A4bsGDNh4MP8WPsrTAo2hVJvlfQNKth9O0q55Xnf0oI/edit
- Send the performance of the newsletter to the sponsor [milestone: +7d]
  - instructions: https://docs.google.com/document/d/1oXpq9SlHHcSe5JjDrScPT2yVb4n980uTJX_-F6NNqkU/edit

---

## 2. Book of the Week

- Trello name: `📚 [Book of the Week] YYYY-MM-DD - Book - Author(s)`
- Type: book-of-the-week
- Display:
  - Emoji: 📚
  - Tags: Book of the Week
  - Title: {BOOK} - {AUTHOR}
- Anchor date: Monday of event week (Mon-Fri)
- Trigger: manual. Created about 21 days before the Monday anchor date after a candidate book/date exists and an author or publisher has agreed

Weekly book feature where authors answer community questions and winners receive free copies. Runs Monday through Friday of the event week. The Monday anchor date drives all task offsets; bundle creation stays manual because each run depends on a confirmed author/book/date.

Bundle links:
- Author email
- Publisher or sponsor contact
- Book or publisher source link
- Website link
- LinkedIn announcement
- X announcement
- Slack announcement
- Author share proof
- Winner announcement
- Winner email handoff

Phases:
- `author-outreach` -> `preparation`
- `book-and-page-setup` -> `preparation`
- `pre-event-promotion` -> `preparation`
- `event-week` -> `announced`
- `giveaway-closeout` -> `after-event`

References:
- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Events](https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit)
- [Events (slack) - book of the week](https://docs.google.com/document/d/1RdxwuKVGRI69phmPbmJbgoO3o8il52LFZhiUu3qaDME/edit)

Tasks (21):

| Ref ID | Offset | Phase | Closure |
|---|---:|---|---|
| `reach-out-to-book-authors` | -21 | `author-outreach` | Record outreach channel/source. If no reply, mark waiting for author with `followUpAt` in 3 business days. |
| `agree-on-a-date` | -20 | `author-outreach` | Confirm Monday-Friday event week. If not confirmed, mark waiting for author and set `followUpAt`. |
| `change-status-confirmed` | -19 | `author-outreach` | Confirm schedule spreadsheet status is `confirmed`; external-status/comment proof is required. |
| `fill-airtable-form-author` | -18 | `book-and-page-setup` | Author/person Airtable form submitted; capture `Author email`; `[HUMAN]` Airtable submission action. |
| `fill-airtable-form-book` | -17 | `book-and-page-setup` | Book Airtable form submitted; capture `Book or publisher source link`; `[HUMAN]` Airtable submission action. |
| `create-web-page` | -16 | `book-and-page-setup` | Required `Website link`; completion is blocked until public page URL exists; `[HUMAN]` website publication action. |
| `fill-newsletter-announcement` | -8 | `pre-event-promotion` | Newsletter Book of the Week block prepared; assignee Valeriia. |
| `announce-event-linkedin` | -7 | `pre-event-promotion` | Required `LinkedIn announcement` link or scheduled-post proof; `[HUMAN]` LinkedIn account action. |
| `remind-author-about-event` | -7 | `pre-event-promotion` | Reminder sent with website link. If Slack invite is not accepted, mark waiting and set `followUpAt`. |
| `ask-authors-share-event` | -6 | `pre-event-promotion` | Capture author-share proof if available; otherwise record waiting/follow-up. |
| `announce-book-event-linkedin` | 0 | `event-week` | Required `LinkedIn announcement`; completion advances bundle stage to `announced`; `[HUMAN]` LinkedIn account action. |
| `comment-from-alexey-linkedin` | 0 | `event-week` | Comment proof or `[HUMAN]` note when Alexey must do it directly. |
| `announce-book-event-twitter` | 0 | `event-week` | Required `X announcement` proof link. |
| `invite-author-to-slack` | 0 | `event-week` | Confirm invite sent/accepted; waiting state if author has not joined. |
| `schedule-announcement-slack` | 0 | `event-week` | Slack announcement scheduled with cover and copied template; `[HUMAN]` external-account action. |
| `announce-book-slack-channels` | 0 | `event-week` | Required `Slack announcement` proof link in `#book-of-the-week` and/or `#announcements`; `[HUMAN]` posting action. |
| `authors-answer-questions` | +1 | `event-week` | Monitor Q&A activity. If inactive, mark waiting for author activity and set `followUpAt`. |
| `select-winners` | +4 | `giveaway-closeout` | Winners selected by author or randomizer; completion advances stage to `after-event`. |
| `collect-emails-from-winners` | +5 | `giveaway-closeout` | Winner emails collected. Missing emails require waiting/follow-up for winners by Tuesday/Wednesday. |
| `announce-winners-slack` | +6 | `giveaway-closeout` | Required `Winner announcement` Slack proof link; `[HUMAN]` posting action. |
| `contact-publisher-give-emails` | +7 | `giveaway-closeout` | Required `Winner email handoff`; completion advances stage to `done`; `[HUMAN]` publisher/author email action. |

---

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

Bundle links:
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

Bundle links:
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

Bundle links:
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

---

## 6. Open-Source Spotlight

- Trello name: `⚙️ [Open-Source Spotlight] - Tool - Name`
- Type: oss
- Display:
  - Emoji: ⚙️
  - Tags: Open-Source Spotlight
  - Title: {TOOL} - {AUTHOR}
- Anchor date: YouTube publish date
- Trigger: manual. Created when a tool author agrees to record a demo

Pre-recorded video showcasing an open-source tool. Unlike live events, this is recorded asynchronously and then published.

Bundle links:
- Guest email
- Tool GitHub
- Youtube

References:
- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Events](https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit)
- [Events (pre-recorded) - Open-Source Spotlight](https://docs.google.com/document/d/1foX7pya-Ywi153LkZWFWBw2nI6HYvcQKS-QQBEUmGZc/edit)

Tasks (14):

- Reach out to github authors
- Reach out to tool author(s)
  - instructions: https://docs.google.com/document/d/1FSJQoMOAZOpiA7EGR2t-xYcu_nEEd2hQSZCC3t5vdq8/edit
- Find time if they can't find anything in calendly
- Schedule the recording
  - instructions: https://docs.google.com/document/d/1GsM_Vlit2bB5MCRUH3AQHZWk3xI96ZZEtEvgzb_CMyY/edit
- Record the demo
- Download the video from zoom and upload to YouTube
  - instructions: https://docs.google.com/document/d/1LU0G3jlcCf19hYIp-TNfz94tDUrjEBvyPJ3_QuJQNvg/edit
- Editing the video
  - instructions: https://docs.google.com/document/d/1hN5STE669QiqwL5oWCIEDP-jbe7W2Aa93UKSQ3iUHEU/edit
- Add timecodes to the YouTube video
  - instructions: https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit
- Ask the authors to review the generated codes
  - instructions: https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit
- Schedule Youtube video [milestone: anchor, publish on Wed at 5PM CET]
  - instructions: https://docs.google.com/document/d/1GsM_Vlit2bB5MCRUH3AQHZWk3xI96ZZEtEvgzb_CMyY/edit
- Tell the Author when the OSS video will be published
  - instructions: https://docs.google.com/document/d/1_jJLDGSTuyRGz6fimgwJLBGyT_dVl_rfr8T50qIqwa8/edit
- Add to the "Open-Source Spotlight" playlist after it's published
- Ask the guest to share the recording with their network
  - instructions: https://docs.google.com/document/d/1JJxAnhoVslGXmjc9Fw3JZrUDD6-srJQcMiHP8rPjMsw/edit
- Schedule for Social Media Announcement
  - instructions: https://docs.google.com/document/d/1BleKsd44Uhhj24D-D5qup0Gf3GcM6cwdAjbZD2jGGuA/edit

---

## 7. Course

- Trello name: `🎓 [Course] Course- YYYY`
- Type: course
- Display:
  - Emoji: 🎓
  - Tags: Course
  - Title: {COURSE NAME}
- Anchor date: Course start date
- Trigger: manual. Created when a course cohort is planned (typically 1-2 months before start)

Free online course promotion. Focus is on marketing and community engagement rather than content creation (course content is prepared separately).

Bundle links:
- [Free courses page](https://datatalks.club/blog/guide-to-free-online-courses-at-datatalks-club.html)
- [Playbook to promote courses](https://docs.google.com/document/d/1ENqjMNPzG4gVTdQzFeDfwyReRbrw2fe2f6AFHrirVBM/edit)

Tasks (8):

- Create an event following the standard process [milestone: -14d, Q&A webinar date]
  - instructions: https://docs.google.com/document/d/1ENqjMNPzG4gVTdQzFeDfwyReRbrw2fe2f6AFHrirVBM/edit
- Prepare the description for the event (assignee: Valeriia)
- Announce the course start [milestone: -30d]
- Announce the Q&A webinar when the event is ready on Luma
- Announce the course start (educational content, carousel, resources) [milestone: -14d]
- Feedback posts [milestone: -7d]
- Reach out to top LinkedIn influencers in the course topic
- Promote the course in relevant LinkedIn, Facebook, Discord, Slack groups, HackerNews, Reddit, Quora

---

## 8. Social Media Weekly Posts

- Trello name: `📱[Social media] Weekly posts (DD MMM 2024)`
- Type: social-media
- Display:
  - Emoji: 📱
  - Tags: Social media
  - Title: Weekly posts
- Anchor date: Week start (Monday)
- Trigger: automatic, weekly. Create bundle on Friday for the following week

Weekly social media content schedule. One post per day, Monday through Friday.

Bundle links:
- Mailchimp Newsletter link
- Sponsorship document

Overview docs (referenced in description):
- [New event announcement](https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit)
- [Overview after the podcast](https://docs.google.com/document/d/1156ty59e3ZlUW3nPpMTd_2smzW40v0ANt9nojUxZ2Gc/edit)
- [Guest recommendations from the podcast](https://docs.google.com/document/d/1XDOfmUHMjKdtlImd5C5LGalCWD8tChefCbB_dtskfWs/edit)
- [Post about all upcoming events](https://docs.google.com/document/d/1NkXUsmaL1JmfX1aO7UbMp349sRGNF6Mu5nd9Dk7Oz2Y/edit)
- [Post about OSS](https://docs.google.com/document/d/1BleKsd44Uhhj24D-D5qup0Gf3GcM6cwdAjbZD2jGGuA/edit)
- [Post about article](https://docs.google.com/document/d/1bj4WnhnRQ_C1L1KJPzUv2REQZOzma9PU8Cz6ZfcV8Fs/edit)

Tasks (5):

- Monday [milestone: anchor]
- Tuesday [milestone: +1d]
- Wednesday - Sponsorship post (Twitter from sponsorship doc, LinkedIn from newsletter) [milestone: +2d]
- Thursday [milestone: +3d]
- Friday [milestone: +4d]

---

## 9. Tax Report

- Trello name: `Tax Report (MM/YYYY)`
- Type: tax-report
- Display:
  - Emoji: (none)
  - Tags: Tax, Finance
  - Title: Tax Report
- Anchor date: Month end date (no specific event day, tasks are sequential)
- Trigger: automatic, monthly. Create bundle on 1st of the following month (month must close before report work begins)

Monthly tax/bookkeeping report. Involves reviewing financials, cross-checking bank accounts, and preparing a report for the accountants.

Bundle links:
- [Upload link](https://tilz.quickconnect.to/sharing/UcXMIHLOH)

References:
- [Process documents](https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit)
- [Tax reports](https://docs.google.com/document/d/1fuWlBKFxWfupmRz9442En78xAwyXjYw_9Aspf81lhv8/edit)

Tasks (8):

- Open the bookkeeping report for the specific month
- Review and update to-dos with actual numbers from Dropbox documents, receipts, and invoices
  - instructions: https://docs.google.com/document/d/1O9TVl2Q2tTDDFaiZro0XTYXpB8i1r9Q6Ryp-dshGFbQ/edit
- Convert any USD or other non-euro currencies to EUR using WISE
  - instructions: https://docs.google.com/document/d/1WWhBApSyw2JsvkVL6WdmYYRcd9ETf58D5SmN2JnJCXo/edit
- Create Bank Statements from Finom and Revolut
  - instructions (Finom): https://docs.google.com/document/d/198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU/edit
  - instructions (Revolut): https://docs.google.com/document/d/1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q/edit
- Cross-check Revolut and Finom for any missing expenses or income
  - instructions: https://docs.google.com/document/d/1Uh6ZQwQ2wBV2S7WZVnph_SauyPQQTQsym5zrrX94vHg/edit
- Prepare a zip archive of the report and send it to accounting
  - instructions: https://docs.google.com/document/d/1__AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit
- Notify the accountants that the report is ready
- Organize invoices folders: Expenses and Incoming Transactions

---

## 10. Maven Lightning Lesson

- Trello name: `📺 [Maven LL] 2026-MM-DD - Topic - Speaker`
- Type: maven-ll
- Display:
  - Emoji: 📺
  - Tags: Maven, Maven Lightning Lesson
  - Title: {TOPIC} - {SPEAKER}
- Anchor date: Event date
- Trigger: manual. Created when Alexey sends Maven LL content and a date is set

Short-form educational content published on Maven platform. Events are created on Maven (not Luma/Meetup), and video editing involves cutting recordings with ffmpeg.

Bundle links:
- Guest email
- Maven
- Youtube

Tasks (7):

- Alexey will send content for Maven LL (assignee: Alexey)
- Create a blocker in the Calendar
- Create Lightning Lessons on Maven
  - instructions: https://docs.google.com/document/d/1vINJ7_hVlhvRLzo9aWoIVEk6UXxpvI0IoNTzm5V4O8k/edit
- Create a banner for the event on Canva
  - instructions: https://docs.google.com/document/d/12QPknzYsV2TCRAte5_CCPu3T3rfL7i2EnF018Sv46sw/edit
- Downloading, Uploading and Editing Maven Videos for YouTube
  - instructions: https://docs.google.com/document/d/13-HQdWdx76Zb1cNFZkXIutzenpwGab2-LRjaiSbc8rw/edit
- Cut the videos using ffmpeg
  - instructions: https://docs.google.com/document/d/1VW_M7LXOPZ09IZQ70qALfHNxIJYpI3oalNMDygj37NI/edit
- Send the Youtube link and cut videos to DTC Content team in Telegram

---

## 11. Office Hours

- Trello name: `📺 [Office Hours] 2026-MM-DD - Topic - Alexey Grigorev`
- Type: office-hours
- Display:
  - Emoji: 📺
  - Tags: Office Hours
  - Title: {COURSE} - {WEEK NUMBER}
- Anchor date: Event date
- Trigger: manual. Created when Alexey sends Grace the Zoom recording link after the event

Regular office hours hosted by Alexey. Post-event work involves video processing, summarization, and Maven announcements.

Bundle links:
- Youtube
- Summary Document

Tasks (5):

- Alexey will send a Zoom video link for Office Hours (assignee: Alexey)
- Downloading and Uploading Office Hours Videos for YouTube
  - instructions: https://docs.google.com/document/d/1pWWERBr2fQDtU7APUpq78qd_cM4gqIuHarEBVkttF70/edit
- Summarizing Video Transcripts For Office Hours
  - instructions: https://docs.google.com/document/d/1QaWt5ePTu9yifyt84-fgGVYProNT28RTVb-PG3a-y1o/edit
- Generating Office Hours Video Description and Timecodes for YouTube
  - instructions: https://docs.google.com/document/d/13-HQdWdx76Zb1cNFZkXIutzenpwGab2-LRjaiSbc8rw/edit
- Making announcements in Maven
  - instructions: https://docs.google.com/document/d/1Se-vZc4iwfLrIskR6L4xaY2fxKE8l_FJ6TFpyDVOVTo/edit

---

## Summary

| # | Template | Type | Tags | Tasks | Trigger | Anchor date |
|---|----------|------|------|-------|---------|-------------|
| 1 | Newsletter | newsletter | Newsletter | 15 | Automatic (weekly, -14d) | Publish day |
| 2 | Book of the Week | book-of-the-week | Book of the Week | 21 | Manual (author/date confirms) | Event week Monday |
| 3 | Podcast | podcast | Podcast | 40 | Manual (guest confirms) | Stream date |
| 4 | Webinar | webinar | Webinar | 28 | Manual (speaker confirms) | Stream date |
| 5 | Workshop | workshop | Workshop | 30 | Manual (speaker confirms) | Stream date |
| 6 | Open-Source Spotlight | oss | Open-Source Spotlight | 14 | Manual (author agrees) | Publish date |
| 7 | Course | course | Course | 8 | Manual (cohort planned) | Course start date |
| 8 | Social Media Weekly | social-media | Social media | 5 | Automatic (weekly, Friday) | Week start (Mon) |
| 9 | Tax Report | tax-report | Tax, Finance | 8 | Automatic (monthly, 1st) | Month end |
| 10 | Maven LL | maven-ll | Maven, Maven Lightning Lesson | 7 | Manual (Alexey sends content) | Event date |
| 11 | Office Hours | office-hours | Office Hours | 5 | Manual (Alexey sends recording) | Event date |

Observations:
- Live event templates (Podcast, Webinar, Workshop) share a common pattern: reach out -> event creation -> announce -> remind -> stream -> video editing -> post-event. These could potentially share common task definitions.
- "Actual stream" is a natural milestone task in all live event templates - fixed to the anchor date.
- Webinar and Workshop are nearly identical - workshop adds a workshop document and sponsored invoice handling.
- Assignee patterns: Valeriia handles newsletter content blocks, social media announcements. Alexey handles podcast uploads, Maven content. Most other tasks are unassigned (available to anyone).

## Shared Tasks Across Templates

Many tasks are repeated (with minor variations) across multiple templates. These represent common workflows that could potentially be standardized.

### Event platform tasks (Podcast, Webinar, Workshop)
- Create event on Luma (same instructions doc)
- Create event on Meetup (same instructions doc)
- Check Meetup location is online with YouTube link
- Create event in Calendar (same instructions doc)
- Fill in "event" form in Airtable (same instructions doc)
- Add event to DataTalks.Club webpage (same instructions doc)

### People & outreach (Podcast, Webinar, Workshop)
- Fill in "people" form in Airtable (same instructions doc)
- Agree on a date
- Create calendar invite for guest (same instructions doc)
- Get event info: title, subtitle, outline

### Social media & announcements (Podcast, Webinar, Workshop, Book of the Week, Course, OSS)
- Schedule posts on LinkedIn and Twitter (same instructions doc)
- Announce event in Slack in #announcements (same instructions doc)
- Publish social media announcement

### Banner creation (Podcast, Webinar, Workshop)
- Create a banner in Figma (same instructions doc, different event type)

### Guest reminders (Podcast, Webinar, Workshop)
- Remind the guest about the event [milestone: -7d] (same/similar instructions)
- Remind the guest about the event [milestone: -1d] (same/similar instructions)

### YouTube video editing (Podcast, Webinar, Workshop)
- Update the cover of the YouTube video (same instructions doc)
- Remove the beginning of the recording (same instructions doc)
- Recheck the video if the edit is successful
- Add timecodes to YouTube videos (same instructions doc)
- Add the video to playlists on YouTube (same instructions doc, different playlist name)
- Add the YouTube link of the stream to the website (same instructions doc)

### Luma email export (Podcast, Webinar, Workshop)
- Upload the emails from Luma to Mailchimp (same instructions doc)

### Newsletter integration (Book of the Week, Webinar, Workshop, Podcast)
- Fill in the newsletter announcement (assignee: Valeriia)

### Sponsored content (Newsletter, Workshop, Webinar)
- Create an Invoice (same instructions doc)
- Share email list with sponsor (same instructions doc)

### Required deliverables (links)
Several tasks produce deliverables that must be captured as bundle links:
- Create event on Luma -> requires filling Luma link
- Create event on Meetup -> requires filling Meetup link
- Create events on LinkedIn -> requires filling LinkedIn link
- Actual stream / YouTube upload -> requires filling Youtube link
- Create sponsorship document -> requires filling Sponsorship document link
- Create a MailChimp campaign -> requires filling Mailchimp newsletter link

### Required deliverables (files)
Some tasks involve creating files/images:
- Create a banner in Figma/Canva -> produces an image (banner)
- Prepare a zip archive of the report -> produces a document (tax report archive)
- Create Bank Statements -> produces documents (bank statements)
- Create an Invoice -> produces a document (invoice)
