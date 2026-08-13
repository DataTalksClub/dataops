/**
 * Google Doc -> internal SOP mapping.
 *
 * Every task instruction in the DataTasks templates originally pointed at a
 * Google Doc inherited from the Trello board. Internal process docs under
 * `content/` are now canonical; the Google Doc IDs are retained here only as
 * migration provenance so an operator can trace where a process doc came from.
 *
 * Two lookup shapes live here because the migration is not one-to-one:
 *
 * - `GOOGLE_DOC_SOPS` maps a Google Doc ID to every internal doc derived from
 *   it. Several large Google Docs were split into multiple focused SOPs, so the
 *   value is a list.
 * - `TASK_INSTRUCTION_DOCS` resolves a single template task to the one internal
 *   doc that task should open. This is required wherever a Google Doc was split:
 *   the Google Doc ID alone cannot say which half a given task needs.
 *
 * `npm run build:google-doc-map -w backend` renders
 * `content/internal-admin/documentation/reference/google-doc-to-internal-sop-map.md`
 * from this module and fails if any internal doc ID no longer resolves.
 */

export interface GoogleDocMapping {
  /** Human label the Trello card used for this link, for operator recognition. */
  label: string;
  /** Internal doc IDs derived from this Google Doc. Empty means unresolved. */
  docIds: string[];
  /** Set when the mapping still needs a human decision. */
  unresolved?: string;
}

/**
 * Google Doc ID -> internal process docs derived from it.
 *
 * Only covers Google Docs referenced by the DataTasks templates. Board-wide
 * Google Docs that no template references are intentionally out of scope.
 */
export const GOOGLE_DOC_SOPS: Record<string, GoogleDocMapping> = {
  // --- Hub / overview documents used as template-level references ---
  '1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII': {
    label: 'Process documents',
    docIds: ['reference.internal-admin.documentation.process-documents-overview'],
  },
  '1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ': {
    label: 'Events',
    docIds: ['reference.overview.events'],
  },
  '10sqvW0RqHJ2xQaoJQB0Ce0E21QPPAef5UwWrx0aT2XA': {
    label: 'Newsletter',
    docIds: ['reference.overview.newsletter'],
  },
  '1RdxwuKVGRI69phmPbmJbgoO3o8il52LFZhiUu3qaDME': {
    label: 'Events (slack) - book of the week',
    docIds: ['reference.overview.events-slack-book-of-the-week'],
  },
  '19d_kBOVQJ2p5qZCtGywzWzYeyCv5FWeHApZnEUZIYRg': {
    label: 'Events (live) - podcast',
    docIds: ['reference.overview.events-live-podcast'],
  },
  '1x7MJa_K0ZmuWw5NkTbmUFM9welTD8j86evcRl1c7VtY': {
    label: 'Events (live) - webinar',
    docIds: ['reference.overview.events-live-webinar'],
  },
  '1tbOClURp1j3MolPY5cI9HzA0QUi8rkXWU_M69RP5BcY': {
    label: 'Events (live) - workshop',
    docIds: ['reference.overview.events-live-workshop'],
  },
  '1foX7pya-Ywi153LkZWFWBw2nI6HYvcQKS-QQBEUmGZc': {
    label: 'Events (pre-recorded) - Open-Source Spotlight',
    docIds: ['reference.overview.events-pre-recorded-open-source-spotlight'],
  },
  '1NkXUsmaL1JmfX1aO7UbMp349sRGNF6Mu5nd9Dk7Oz2Y': {
    label: 'Post about all upcoming events',
    docIds: ['reference.social-media.post-new-event-announcements-podcasts-webinars-workshops'],
  },
  '1bj4WnhnRQ_C1L1KJPzUv2REQZOzma9PU8Cz6ZfcV8Fs': {
    label: 'Post about article',
    docIds: ['template.social-media.template-linkedin-and-x-announcement-article'],
  },
  '1ENqjMNPzG4gVTdQzFeDfwyReRbrw2fe2f6AFHrirVBM': {
    label: 'Playbook to promote courses',
    docIds: ['playbook.courses.playbook-for-promoting-courses-at-dtc'],
  },

  // --- Google Docs split into several internal SOPs ---
  '1Q6eKmPKAa7LE8-HZrKV9NOdCJLOwlIqB0Txo6aFZUbg': {
    label: 'Podcast page in the newsletter',
    docIds: [
      'sop.newsletter.mailchimp.add-just-published-podcast-page-to-the-newsletter',
      'sop.media.podcast.sending-a-podcast-scheduled-email-to-pavel-after-the-event',
    ],
  },
  '1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM': {
    label: 'Airtable "people" form',
    docIds: [
      'sop.community.book-of-the-week.adding-an-author-to-book-of-the-week-pages',
      'sop.events.planning.create-speaker-profiles-via-airtable-form',
    ],
  },
  '16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY': {
    label: 'Adding an event to the website',
    docIds: [
      'sop.community.book-of-the-week.add-links-and-edit-description',
      'sop.media.podcast.update-the-website-with-the-information-from-forms',
    ],
  },
  '1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k': {
    label: 'Agreeing on and holding an event date',
    docIds: [
      'sop.events.calendar.creating-tentative-event-on-google-calendar',
      'sop.media.podcast.select-and-propose-a-date-for-events',
    ],
  },
  '1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc': {
    label: 'Open-Source Spotlight timecodes and revisions',
    docIds: [
      'sop.media.open-source-spotlight.adding-timecodes-for-open-source-spotlight-videos',
      'template.media.open-source-spotlight.oss-asking-for-revisions-and-links',
    ],
  },
  '1GsM_Vlit2bB5MCRUH3AQHZWk3xI96ZZEtEvgzb_CMyY': {
    label: 'Open-Source Spotlight scheduling',
    docIds: [
      'reference.overview.events-pre-recorded-open-source-spotlight',
      'sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos',
    ],
  },

  // --- Webinar / workshop instruction docs resolved during this migration ---
  '1Hfz6KIIVKDL98t1j0_erGs0RAYCBnJdRjuuFfAxYxHg': {
    label: 'Initial contact with the speaker',
    docIds: ['sop.media.webinar.initial-contact-with-the-speaker'],
  },
  '1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q': {
    label: 'Webinar process email template',
    docIds: ['template.media.webinar.webinar-process-email-template'],
  },
  '1ZwnCpleU0xQqZV02KVNSO24gu8HIHIrZdbHLGnZx52k': {
    label: 'Create events on LinkedIn',
    docIds: ['sop.events.linkedin.create-events-on-linkedin'],
  },
  '1rMvF296VSzgMvw5Pmy0azE374ZaRHSak2yXVxJGyyTU': {
    label: 'Remind the guest a day before',
    docIds: ['template.media.webinar.webinar-remind-the-guest-about-the-event-a-day-before-template'],
  },
  '1qf38niJVSAFYz0hkTXVma_bvM9EpArQLUD4wF4YB_Ok': {
    label: 'Share attendee emails with the sponsor',
    docIds: ['sop.media.workshops.email-filtering-for-sponsored-workshops'],
  },
  '1KuKKupkYHs6V5rdEhbpblIJ2zQcHPJrdauFANX_kA0o': {
    label: 'Ask guests to share the video',
    docIds: ['template.media.webinar.webinar-ask-the-guests-to-share-the-videos-with-their-networks'],
  },
  '1VWitGUErmKn8JfzBEYx3BVa-lSl-tLPB2bLDtPFWi9Q': {
    label: 'Announce events to different communities',
    docIds: ['template.social-media.announcing-events-to-different-communities'],
  },
  '1TYQGVzdcoTH9-ULzFWK-2nGt8X-50ju5kYcnJV4F83M': {
    label: 'Ask guests to share the videos with their networks',
    docIds: ['template.media.webinar.webinar-ask-the-guests-to-share-the-videos-with-their-networks'],
  },
  '1kdrmpwrvDjYf_cNVJaLo6qhVJ2B7a5As-DrAx_mYWb8': {
    label: 'Sponsored workshop follow-up',
    docIds: ['template.newsletter.workshop-sponsored-stats-of-an-event'],
  },

  // --- Maven Lightning Lessons and Office Hours ---
  '1vINJ7_hVlhvRLzo9aWoIVEk6UXxpvI0IoNTzm5V4O8k': {
    label: 'Creating Lightning Lessons on Maven',
    docIds: ['sop.maven.lightning-lessons.creating-lightning-lessons-on-maven'],
  },
  '12QPknzYsV2TCRAte5_CCPu3T3rfL7i2EnF018Sv46sw': {
    label: 'Maven Lightning Lesson banners in Canva',
    docIds: ['sop.maven.lightning-lessons.creating-pictures-for-maven-lightning-lessons-in-canva'],
  },
  '13-HQdWdx76Zb1cNFZkXIutzenpwGab2-LRjaiSbc8rw': {
    label: 'Maven and Office Hours video handling for YouTube',
    docIds: [
      'sop.maven.lightning-lessons.downloading-uploading-and-editing-maven-videos-for-youtube',
      'reference.maven.prompts.office-hours-prompt',
    ],
  },
  '1VW_M7LXOPZ09IZQ70qALfHNxIJYpI3oalNMDygj37NI': {
    label: 'Cutting videos with ffmpeg',
    docIds: ['sop.media.video.cutting-videos-with-ffmpeg'],
  },
  '1pWWERBr2fQDtU7APUpq78qd_cM4gqIuHarEBVkttF70': {
    label: 'Downloading and uploading Office Hours videos',
    docIds: ['sop.maven.office-hours.downloading-and-uploading-office-hours-videos-for-youtube'],
  },
  '1QaWt5ePTu9yifyt84-fgGVYProNT28RTVb-PG3a-y1o': {
    label: 'Summarizing Office Hours transcripts',
    docIds: ['sop.maven.office-hours.summarizing-video-transcripts-for-office-hours'],
  },
  '1Se-vZc4iwfLrIskR6L4xaY2fxKE8l_FJ6TFpyDVOVTo': {
    label: 'Making announcements in Maven',
    docIds: ['sop.maven.office-hours.making-announcements-in-maven'],
  },

  // --- Instruction docs already resolved before this migration ---
  '1N3tLKK1oDpRep1R5uZ5hhy9b9pDPi21qI_cO44vO7W8': {
    label: "Create sponsorship document",
    docIds: ['sop.newsletter.sponsorship.creating-a-document-for-sponsored-content-for-a-newsletter'],
  },
  '1cgUOAdSp9eqad4MUiEdFBCEb3v0PSB3DiCeYzcJrsrs': {
    label: "Email the sponsor with the sponsorship document - add Valeriia in communication",
    docIds: ['template.newsletter.send-sponsorship-document-2-weeks-before'],
  },
  '1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ': {
    label: "Create a MailChimp campaign",
    docIds: ['template.newsletter.create-newsletter-draft-from-template-in-mailchimp'],
  },
  '1kuuUAZl0TBlc9jgzH99GxJ9zGGqwDrTZeMzuIlqDKiA': {
    label: "Fill up \"Sponsored\" block (after sponsorship document is completed)",
    docIds: ['sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter'],
  },
  '10y0CCq8ApFbH1Mx7wlh_b_ZudnPib9qk_tDysA99xNg': {
    label: "Fill up \"Book of the week\" block",
    docIds: ['sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block'],
  },
  '1hY7nMMRqooMpmCV0gl0aNfAePUajYLyylW0JUTdiwEM': {
    label: "Schedule Email Newsletter",
    docIds: ['sop.newsletter.mailchimp.schedule-a-newsletter-on-mailchimp'],
  },
  '1PeLSKvs76XiP-bG4WviQur4pQS0Ie25w9I50CZkJYZs': {
    label: "Create an Invoice",
    docIds: ['sop.finance.bookkeeping.creating-invoices-in-finom'],
  },
  '1mIm41ciFJ4aF0lUKbJzbeD_dF7vF-gqEti-vQOJ_mTQ': {
    label: "Send email to notify sponsor that publication is live",
    docIds: ['template.newsletter.sending-email-on-the-day-of-publication'],
  },
  '1pHfmmVGnNKGM4i0um3M5yqpgZJlb6sgHGl0eZ1abW-A': {
    label: "Schedule Sponsorship content on LinkedIn",
    docIds: ['sop.social-media.linkedin.schedule-social-media-posts-with-hootsuite-and-post-about-newsletter-promotional-content'],
  },
  '18Pm55ewbv1FoO4Cz_Dx-vWICPa0QhgrXiEsvZX7b6DQ': {
    label: "Schedule Sponsorship content on Twitter",
    docIds: ['sop.social-media.twitter.schedule-posts-with-twitter-and-post-about-newsletter-promotional-content'],
  },
  '1A4bsGDNh4MP8WPsrTAo2hVJvlfQNKth9O0q55Xnf0oI': {
    label: "Add newsletter performance on the spreadsheet",
    docIds: ['sop.newsletter.mailchimp.filling-newsletter-statistics'],
  },
  '1oXpq9SlHHcSe5JjDrScPT2yVb4n980uTJX_-F6NNqkU': {
    label: "Send the performance of the newsletter to the sponsor",
    docIds: ['template.newsletter.newsletter-performance'],
  },
  '1rGXg_1qbCmJUQpVxW9w12-BZObWaFBnTEr98eoMAJkk': {
    label: "Reach out to book authors",
    docIds: ['template.community.book-of-the-week.book-of-the-week-reaching-out-to-authors'],
  },
  '1VC0nV7NVvKw5XaK9xYlLESystohHaaOthgIdyAmBJEo': {
    label: "Agree on a date",
    docIds: ['sop.community.book-of-the-week.have-a-first-contact-with-the-author'],
  },
  '11S7hjpIV0N3MnVm75ygBfwqB9c9_huRLaHil9Zzx_xY': {
    label: "Fill up the Airtable form for the book",
    docIds: ['sop.community.book-of-the-week.add-books-to-the-airtable-form'],
  },
  '1OuOW7IrYQYUS4UK3GBJZRWVIgqW9fp_rkp5hw2bwbjY': {
    label: "Remind the author about the event",
    docIds: ['template.community.book-of-the-week.book-of-the-week-remind-the-guest-about-the-event-template'],
  },
  '1wnyMlIO3MuW7TwXkX6NYyo7XXp1hKM_lsp9KUgslSpg': {
    label: "Ask book authors to share the event page",
    docIds: ['template.community.book-of-the-week.asking-books-authors-to-share-their-event-page'],
  },
  '1HeorFgnMhVt2olNGYJNpoeht_-av-G-nFEf7NLKL8Ek': {
    label: "Announce the book of the week event on DTC LinkedIn",
    docIds: ['template.community.book-of-the-week.book-of-the-week-linkedin-announcement'],
  },
  '1VCRVVhI7Lo4OOAg7Blkab94gyoJrjNRgBVKw3tjbxW4': {
    label: "Announce the book of the week event on DTC Twitter",
    docIds: ['reference.social-media.posts-book-of-the-week'],
  },
  '1G8XBXPTQpX8nf873TQmNpkFee3mDueGoVvPGcE54Eho': {
    label: "Invite the author(s) to Slack",
    docIds: ['sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form'],
  },
  '1yf1f8ZLzePv-bFHjTlXmLydEzxGpuIG38BJwkqxAMbI': {
    label: "Schedule the announcement in Slack",
    docIds: ['sop.community.book-of-the-week.schedule-the-announcement-in-slack'],
  },
  '1S2CwgVZ9-7v_-9HIMk2CdODlkNqMejxqCOcs2bEo9G8': {
    label: "Select winners (ask author)",
    docIds: ['sop.community.book-of-the-week.select-book-of-the-week-winners'],
  },
  '14QzlXTP1FLHnNAn_ZyTGKlsst-H_hZKSnurzTy8D9TY': {
    label: "Collect the emails from winners",
    docIds: ['sop.community.book-of-the-week.select-book-of-the-week-winners'],
  },
  '1JxtqGk1UamUGp3PxtD3-YCJJagJdJK00CGBEPVd4VH8': {
    label: "Announce the book-of-the-week winners in the Slack community",
    docIds: ['template.community.book-of-the-week.announce-the-book-of-the-week-winners-in-slack'],
  },
  '1szidymIamDfTI0LpkmwlRz7AX0qsRcPEVrcKtaFz_hs': {
    label: "Contact the publisher or the authors and give them the emails",
    docIds: ['template.community.book-of-the-week.sending-book-of-the-week-winners-to-the-publisher-and-author-via-email-templateent'],
  },
  '1IVNQQs-Hk-8LzZWox8YWbShJ6Y3sl47H5Z2PC2ra9ZU': {
    label: "Create a podcast document with the questions",
    docIds: ['sop.media.podcast.create-podcast-document'],
  },
  '1Ix73NmCJPfYs0HcokxG5sORj0bFxtZsLrZTLHsp_DDM': {
    label: "Include Johanna and ask the guest their biography and other information",
    docIds: ['template.media.podcast.podcast-adding-johanna-and-sending-the-podcast-link-to-the-speaker'],
  },
  '1pVL13ku-_zwlqQk8PhmxJkxnRylxzDIKImlzH526k1M': {
    label: "Share the podcast document on the #dtc-podcast-help",
    docIds: ['template.media.podcast.sending-podcast-document-on-slack-the-dtc-podcast-help-channel'],
  },
  '1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs': {
    label: "Create a calendar invite for guest speaker",
    docIds: ['sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event'],
  },
  '1mijZcQ6qRXCscG0DVx6UA9KGgUT_QVTDUSWpQl4aqhE': {
    label: "Add a guest bio to the podcast document",
    docIds: ['sop.media.podcast.add-a-guest-bio-to-the-podcast-document'],
  },
  '1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI': {
    label: "Create a banner for a podcast event in Figma",
    docIds: [
      'sop.media.podcast.making-event-announcements-when-topic-bio-or-outline-is-missing',
      'sop.sales.sponsorship.how-to-use-figma-for-creating-event-banners',
    ],
  },
  '1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8': {
    label: "Create an event in Luma",
    docIds: ['sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma'],
  },
  '1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs': {
    label: "Create an event in Meetup",
    docIds: ['sop.events.meetup.create-events-in-meetup-com'],
  },
  '1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE': {
    label: "Create event in the DTC community Calendar",
    docIds: ['sop.events.luma.creating-events-on-google-calendar'],
  },
  '1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ': {
    label: "Announce event in Slack in #announcements",
    docIds: ['sop.events.announce-event-in-slack-in-announcements'],
  },
  '1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8': {
    label: "Fill in the \"event\" form in Airtable",
    docIds: ['sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website'],
  },
  '12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0': {
    label: "New event announcement",
    docIds: ['template.social-media.template-new-event-announcements-podcasts-webinars-workshops'],
  },
  '1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA': {
    label: "Remind the guest about the event",
    docIds: [
      'template.media.podcast.podcast-remind-about-the-event-in-a-week-share-registration-link-template',
      'template.media.webinar.webinar-remind-the-guest-about-the-event-a-week-before-template',
    ],
  },
  '1JSHCMgOufo0UrUD2XE1D4rLc1H0jROTjZB9ARCGeZrk': {
    label: "Remind the guest about the event",
    docIds: ['template.media.podcast.podcast-remind-the-guest-about-the-event-a-day-before-template'],
  },
  '1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw': {
    label: "Update the cover of the YouTube video",
    docIds: ['sop.media.podcast.updating-the-cover-of-the-youtube-video'],
  },
  '1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8': {
    label: "Remove the beginning of the recording",
    docIds: ['sop.media.podcast.removing-the-beginning-from-the-youtube-stream'],
  },
  '1lkvu5T4fVT0nnmjIPolLCT4o4dUc3iZ2b7jWycVrtPU': {
    label: "Create the transcript document",
    docIds: ['sop.media.podcast.creating-podcast-transcription-document'],
  },
  '1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8': {
    label: "Add the video to \"livestream\" and \"podcast\" playlists on YouTube",
    docIds: [
      'sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist',
      'sop.media.video-youtube.add-links-to-the-youtube-video',
    ],
  },
  '1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw': {
    label: "Add the YouTube link of the stream to the website",
    docIds: [
      'sop.media.podcast.add-links-to-youtube-after-the-stream-is-over',
      'sop.website.add-the-link-of-the-stream-to-the-website',
    ],
  },
  '1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A': {
    label: "Edit video description",
    docIds: [
      'sop.media.podcast.add-links-to-youtube-after-the-stream-is-over',
      'sop.media.video-youtube.generate-timecodes-using-youtube-video-transcripts',
    ],
  },
  '1RrTDKmxs9iN2YKnYQ9uSQvdUXRGxPJJ3u7RiQWnCyCw': {
    label: "Include timecodes extracted from the transcription",
    docIds: ['sop.media.podcast.generate-timecodes-from-docx-transcriptions'],
  },
  '1tsuI291-eJ8CxK5MHajEKK3ODZ_TOHfX-XZ-csAFX8Y': {
    label: "Ask the guest for links after the stream",
    docIds: ['template.media.podcast.podcast-links-after-the-event-is-over'],
  },
  '1moSrrDw501TzG3X_DqreK2ZkhRZ40I_d9lCjhF4agQA': {
    label: "Schedule the edited podcast episode with Spotify for Podcasters",
    docIds: ['sop.media.podcast.schedule-podcast-episodes-with-spotify-for-podcaster'],
  },
  '1PTfM18NgBRICm70hPMcYntCEs_uNxh0lYERhmDcusGA': {
    label: "Moving Podcast Audio in Dropbox",
    docIds: ['sop.media.podcast.moving-podcast-audio-in-dropbox'],
  },
  '1nUvqLRX18fEWgqeJO-9FNuXDX8SBZpjauIjvfXwaL4k': {
    label: "Add a podcast episode via Airtable form",
    docIds: ['sop.media.podcast.add-a-podcast-episode-via-airtable-form'],
  },
  '1ojQTnenw5yfKL_hn4LCDzfbVRcNxbvNFfEO_1PiIbDQ': {
    label: "Ask the guest to share the podcast page",
    docIds: ['template.media.podcast.podcast-share-the-podcast-page-template'],
  },
  '1wEs9firI_tlbSNt4jPWTAgTZT1_eaQ6P9VSoDoybu48': {
    label: "Move the podcast documents to archive in google drive",
    docIds: ['sop.media.podcast.move-podcast-documents-to-archive-in-google-drive'],
  },
  '1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ': {
    label: "Upload the emails from Luma to Mailchimp",
    docIds: [
      'sop.events.luma.downloading-the-csv-file-on-luma',
      'sop.newsletter.mailchimp.import-emails-from-luma-to-mailchimp',
    ],
  },
  '1156ty59e3ZlUW3nPpMTd_2smzW40v0ANt9nojUxZ2Gc': {
    label: "Overview after the podcast",
    docIds: ['reference.social-media.post-podcast-overview-after-the-event'],
  },
  '1XDOfmUHMjKdtlImd5C5LGalCWD8tChefCbB_dtskfWs': {
    label: "Guest recommendations from the podcast",
    docIds: ['sop.social-media.post-podcast-guest-recommendations'],
  },
  '1FSJQoMOAZOpiA7EGR2t-xYcu_nEEd2hQSZCC3t5vdq8': {
    label: "Send the OSS invitation to the tool author(s)",
    docIds: ['template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool'],
  },
  '1LU0G3jlcCf19hYIp-TNfz94tDUrjEBvyPJ3_QuJQNvg': {
    label: "Download the Zoom recording and upload or create the YouTube draft",
    docIds: ['reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube'],
  },
  '1hN5STE669QiqwL5oWCIEDP-jbe7W2Aa93UKSQ3iUHEU': {
    label: "Edit/review the video and prepare it for publication",
    docIds: ['sop.media.open-source-spotlight.find-timestamps-for-editing'],
  },
  '1_jJLDGSTuyRGz6fimgwJLBGyT_dVl_rfr8T50qIqwa8': {
    label: "Tell the Author when the OSS video will be published",
    docIds: ['template.media.open-source-spotlight.oss-asking-for-revisions-and-links'],
  },
  '1JJxAnhoVslGXmjc9Fw3JZrUDD6-srJQcMiHP8rPjMsw': {
    label: "Ask the guest to share the recording and recommend other OSS authors",
    docIds: ['template.media.open-source-spotlight.oss-ask-the-guests-to-share-the-videos-with-their-networks'],
  },
  '1BleKsd44Uhhj24D-D5qup0Gf3GcM6cwdAjbZD2jGGuA': {
    label: "Post about OSS",
    docIds: ['reference.social-media.post-oss'],
  },
  '1fuWlBKFxWfupmRz9442En78xAwyXjYw_9Aspf81lhv8': {
    label: "Tax reports",
    docIds: ['sop.finance.tax-reporting.monthly-tax-report'],
  },
  '1O9TVl2Q2tTDDFaiZro0XTYXpB8i1r9Q6Ryp-dshGFbQ': {
    label: "Review Dropbox documents, receipts, invoices, and spreadsheet rows; replace TODO values with actual numbers",
    docIds: ['sop.finance.bookkeeping.adding-paid-invoices-to-the-bookkeeping-spreadsheet-and-adding-it-to-dropbox'],
  },
  '1WWhBApSyw2JsvkVL6WdmYYRcd9ETf58D5SmN2JnJCXo': {
    label: "Convert USD or other non-EUR transactions to EUR using Wise/Revolut evidence and update the spreadsheet",
    docIds: ['sop.finance.bookkeeping.for-update-converting-usd-to-eur-for-revolut-transcations'],
  },
  '198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU': {
    label: "Download/create the Finom bank statement for the month",
    docIds: ['sop.finance.bookkeeping.creating-bank-statements-in-finom'],
  },
  '1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q': {
    label: "Download/create the Revolut bank statement for the month",
    docIds: ['sop.finance.bookkeeping.creating-bank-statements-in-revolut'],
  },
  '1Uh6ZQwQ2wBV2S7WZVnph_SauyPQQTQsym5zrrX94vHg': {
    label: "Cross-check Finom and Revolut transactions against the bookkeeping spreadsheet and add missing income/expenses",
    docIds: ['sop.finance.bookkeeping.crosschecking-with-revolut-and-finom'],
  },
  '1__AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs': {
    label: "Prepare the datatalksclub-YYYY-MM.zip tax package and upload it to the accountant handoff destination",
    docIds: ['sop.finance.bookkeeping.preparing-a-zip-archive-with-invoices-and-send-reports-to-the-accountant'],
  },
  '1AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs': {
    label: "Send the accountant email with the monthly report summary and uploaded package reference, cc Alexey",
    docIds: ['sop.finance.bookkeeping.sending-reports-to-accountants-for-bookkeeping'],
  },
};

/**
 * `<template type>/<task refId>` -> internal doc the task should open.
 *
 * Covers the tasks that carried only a Google Doc link. Tasks whose Google Doc
 * was split across several internal SOPs are resolved here by task meaning, not
 * by Google Doc ID.
 */
export const TASK_INSTRUCTION_DOCS: Record<string, string> = {
  // --- Webinar ---
  'webinar/initial-contact-speaker': 'sop.media.webinar.initial-contact-with-the-speaker',
  'webinar/agree-on-a-date': 'sop.media.podcast.select-and-propose-a-date-for-events',
  'webinar/create-calendar-invite': 'sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event',
  'webinar/get-event-info': 'template.media.webinar.webinar-process-email-template',
  'webinar/fill-people-form-airtable': 'sop.events.planning.create-speaker-profiles-via-airtable-form',
  'webinar/create-banner-figma': 'sop.sales.sponsorship.how-to-use-figma-for-creating-event-banners',
  'webinar/create-events-luma': 'sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma',
  'webinar/create-events-meetup': 'sop.events.meetup.create-events-in-meetup-com',
  'webinar/create-events-linkedin': 'sop.events.linkedin.create-events-on-linkedin',
  'webinar/create-event-calendar': 'sop.events.luma.creating-events-on-google-calendar',
  'webinar/fill-event-form-airtable': 'sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website',
  'webinar/add-event-to-webpage': 'sop.media.podcast.update-the-website-with-the-information-from-forms',
  'webinar/announce-event-slack': 'sop.events.announce-event-in-slack-in-announcements',
  'webinar/schedule-posts-linkedin-twitter': 'template.social-media.template-new-event-announcements-podcasts-webinars-workshops',
  'webinar/remind-guest-7d': 'template.media.webinar.webinar-remind-the-guest-about-the-event-a-week-before-template',
  'webinar/remind-guest-1d': 'template.media.webinar.webinar-remind-the-guest-about-the-event-a-day-before-template',
  'webinar/update-youtube-cover': 'sop.media.podcast.updating-the-cover-of-the-youtube-video',
  'webinar/remove-beginning-recording': 'sop.media.podcast.removing-the-beginning-from-the-youtube-stream',
  'webinar/generate-timecodes': 'sop.media.video-youtube.generate-timecodes-using-youtube-video-transcripts',
  'webinar/adding-timecodes-youtube': 'sop.media.video-youtube.add-timecodes-to-youtube-videos',
  'webinar/add-to-playlists': 'sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist',
  'webinar/add-youtube-link-to-website': 'sop.website.add-the-link-of-the-stream-to-the-website',
  'webinar/add-links-from-speaker-youtube': 'sop.media.video-youtube.add-links-to-the-youtube-video',
  'webinar/upload-luma-emails-mailchimp': 'sop.newsletter.mailchimp.import-emails-from-luma-to-mailchimp',
  'webinar/share-emails-with-sponsor': 'sop.media.workshops.email-filtering-for-sponsored-workshops',
  'webinar/ask-speaker-recommendations': 'template.media.webinar.webinar-ask-the-guests-to-share-the-videos-with-their-networks',

  // --- Workshop (mirrors webinar; workshop-specific docs used where they exist) ---
  'workshop/initial-contact-speaker': 'sop.media.webinar.initial-contact-with-the-speaker',
  'workshop/get-event-info': 'template.media.webinar.webinar-process-email-template',
  'workshop/create-calendar-invites': 'sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event',
  'workshop/fill-people-form-airtable': 'sop.events.planning.create-speaker-profiles-via-airtable-form',
  'workshop/create-banner-figma': 'sop.sales.sponsorship.how-to-use-figma-for-creating-event-banners',
  'workshop/create-events-luma': 'sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma',
  'workshop/create-events-meetup': 'sop.events.meetup.create-events-in-meetup-com',
  'workshop/create-events-linkedin': 'sop.events.linkedin.create-events-on-linkedin',
  'workshop/create-event-calendar': 'sop.events.luma.creating-events-on-google-calendar',
  'workshop/fill-event-form-airtable': 'sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website',
  'workshop/add-event-to-webpage': 'sop.media.podcast.update-the-website-with-the-information-from-forms',
  'workshop/announce-event-slack': 'sop.events.announce-event-in-slack-in-announcements',
  'workshop/announce-event-communities': 'template.social-media.announcing-events-to-different-communities',
  'workshop/schedule-posts-linkedin-twitter': 'template.social-media.template-new-event-announcements-podcasts-webinars-workshops',
  'workshop/prepare-send-invoice': 'sop.finance.bookkeeping.creating-invoices-in-finom',
  'workshop/remind-guest-7d': 'template.media.webinar.webinar-remind-the-guest-about-the-event-a-week-before-template',
  'workshop/remind-guest-1d': 'template.media.webinar.webinar-remind-the-guest-about-the-event-a-day-before-template',
  'workshop/update-youtube-cover': 'sop.media.podcast.updating-the-cover-of-the-youtube-video',
  'workshop/remove-beginning-recording': 'sop.media.podcast.removing-the-beginning-from-the-youtube-stream',
  'workshop/generate-timecodes': 'sop.media.video-youtube.generate-timecodes-using-youtube-video-transcripts',
  'workshop/adding-timecodes-youtube': 'sop.media.video-youtube.add-timecodes-to-youtube-videos',
  'workshop/add-to-playlists': 'sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist',
  'workshop/add-youtube-link-to-website': 'sop.website.add-the-link-of-the-stream-to-the-website',
  'workshop/add-links-from-speaker-youtube': 'sop.media.video-youtube.add-links-to-the-youtube-video',
  'workshop/upload-luma-emails-mailchimp': 'sop.newsletter.mailchimp.import-emails-from-luma-to-mailchimp',
  'workshop/share-emails-with-sponsor': 'sop.media.workshops.email-filtering-for-sponsored-workshops',
  'workshop/ask-guests-share-videos': 'template.media.webinar.webinar-ask-the-guests-to-share-the-videos-with-their-networks',
  'workshop/ask-sponsor-feedback': 'template.newsletter.workshop-sponsored-stats-of-an-event',

  // --- Course ---
  'course/create-event-standard-process': 'playbook.courses.playbook-for-promoting-courses-at-dtc',

  // --- Maven Lightning Lessons ---
  'maven-ll/create-lightning-lessons-maven': 'sop.maven.lightning-lessons.creating-lightning-lessons-on-maven',
  'maven-ll/create-banner-canva': 'sop.maven.lightning-lessons.creating-pictures-for-maven-lightning-lessons-in-canva',
  'maven-ll/download-upload-edit-youtube': 'sop.maven.lightning-lessons.downloading-uploading-and-editing-maven-videos-for-youtube',
  'maven-ll/cut-videos-ffmpeg': 'sop.media.video.cutting-videos-with-ffmpeg',

  // --- Office Hours ---
  'office-hours/download-upload-youtube': 'sop.maven.office-hours.downloading-and-uploading-office-hours-videos-for-youtube',
  'office-hours/summarize-transcripts': 'sop.maven.office-hours.summarizing-video-transcripts-for-office-hours',
  'office-hours/generate-description-timecodes': 'reference.maven.prompts.office-hours-prompt',
  'office-hours/make-announcements-maven': 'sop.maven.office-hours.making-announcements-in-maven',
};
