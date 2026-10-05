# Templates Reference — Part 4: Summary and shared tasks

> Part 4 of 4 of the [templates reference](../templates.md):
> [Part 1](part-1-recurring-publication-templates.md) covers recurring publication templates (Newsletter, Book of the Week, Open-Source Spotlight, Course, Social Media Weekly Posts);
> [Part 2](part-2-event-templates.md) covers event templates (Podcast, Webinar, Workshop);
> [Part 3](part-3-periodic-operations-templates.md) covers periodic operations templates (Tax Report, Maven Lightning Lesson, Office Hours);
> this part covers the cross-template summary and the shared task lists.

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
| 9 | Tax Report | tax-report | Tax, Finance | 9 | Automatic (monthly, 1st) | First day of month |
| 10 | Maven LL | maven-ll | Maven, Maven Lightning Lesson | 7 | Manual (Alexey sends content) | Event date |
| 11 | Office Hours | office-hours | Office Hours | 5 | Manual (Alexey sends recording) | Event date |

Observations:
- Live event templates (Podcast, Webinar, Workshop) share a common pattern: reach out -> event creation -> announce -> remind -> stream -> video editing -> post-event. These could potentially share common task definitions.
- "Actual stream" is a natural milestone task in all live event templates - fixed to the anchor date.
- Webinar and Workshop are nearly identical - workshop adds a workshop document and sponsored invoice handling.
- Assignee patterns: Valeriia handles newsletter content blocks, social media announcements. Alexey handles podcast uploads, Maven content. Most other tasks are unassigned (available to anyone).

---

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
Several tasks produce deliverables that must be captured as card links:
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
