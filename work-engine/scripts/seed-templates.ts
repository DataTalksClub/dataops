import { getClient, startLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { listTemplates, createTemplate, deleteTemplate } from '../src/db/templates';
import type { Template } from '../src/types';

// User IDs from seed-users.ts
const GRACE_ID = '00000000-0000-0000-0000-000000000001';
const VALERIIA_ID = '00000000-0000-0000-0000-000000000002';
const ALEXEY_ID = '00000000-0000-0000-0000-000000000003';

const DEFAULT_TEMPLATES = [
  // 1. Newsletter
  {
    name: 'Newsletter',
    type: 'newsletter',
    emoji: '\u{1F4F0}',
    tags: ['Newsletter'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'automatic',
    triggerSchedule: '0 9 * * 1',
    triggerLeadDays: 14,
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Newsletter', url: 'https://docs.google.com/document/d/10sqvW0RqHJ2xQaoJQB0Ce0E21QPPAef5UwWrx0aT2XA/edit' },
    ],
    bundleLinkDefinitions: [
      { name: 'Sponsorship document' },
      { name: 'Mailchimp newsletter' },
      { name: 'LinkedIn' },
      { name: 'X' },
    ],
    taskDefinitions: [
      {
        refId: 'create-sponsorship-document',
        description: 'Create sponsorship document',
        offsetDays: -14,
        instructionsUrl: 'https://docs.google.com/document/d/1N3tLKK1oDpRep1R5uZ5hhy9b9pDPi21qI_cO44vO7W8/edit',
        requiredLinkName: 'Sponsorship document',
      },
      {
        refId: 'email-sponsor',
        description: 'Email the sponsor with the sponsorship document - add Valeriia in communication',
        offsetDays: -14,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1cgUOAdSp9eqad4MUiEdFBCEb3v0PSB3DiCeYzcJrsrs/edit',
      },
      {
        refId: 'create-mailchimp-campaign',
        description: 'Create a MailChimp campaign',
        offsetDays: -13,
        instructionsUrl: 'https://docs.google.com/document/d/1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ/edit',
        requiredLinkName: 'Mailchimp newsletter',
      },
      {
        refId: 'fill-sponsored-block',
        description: 'Fill up "Sponsored" block (after sponsorship document is completed)',
        offsetDays: -12,
        instructionsUrl: 'https://docs.google.com/document/d/1kuuUAZl0TBlc9jgzH99GxJ9zGGqwDrTZeMzuIlqDKiA/edit',
      },
      {
        refId: 'fill-book-of-the-week-block',
        description: 'Fill up "Book of the week" block',
        offsetDays: -11,
        assigneeId: VALERIIA_ID,
        instructionsUrl: 'https://docs.google.com/document/d/10y0CCq8ApFbH1Mx7wlh_b_ZudnPib9qk_tDysA99xNg/edit',
      },
      {
        refId: 'fill-event-block',
        description: 'Fill up "Event" block',
        offsetDays: -10,
        assigneeId: VALERIIA_ID,
        instructionsUrl: 'https://docs.google.com/document/d/1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ/edit',
      },
      {
        refId: 'fill-podcast-block',
        description: 'Fill up "Podcast" block',
        offsetDays: -9,
        assigneeId: VALERIIA_ID,
        instructionsUrl: 'https://docs.google.com/document/d/1Q6eKmPKAa7LE8-HZrKV9NOdCJLOwlIqB0Txo6aFZUbg/edit',
      },
      {
        refId: 'fill-article-block',
        description: 'Fill up "Article" block',
        offsetDays: -8,
        assigneeId: VALERIIA_ID,
        instructionsUrl: 'https://docs.google.com/document/d/1QUz5pZUShGxFzPGAjdauYJffBhgcH1fUVScG_MlToOQ/edit',
      },
      {
        refId: 'schedule-email-newsletter',
        description: 'Schedule Email Newsletter',
        offsetDays: -1,
        instructionsUrl: 'https://docs.google.com/document/d/1hY7nMMRqooMpmCV0gl0aNfAePUajYLyylW0JUTdiwEM/edit',
      },
      {
        refId: 'create-invoice',
        description: 'Create an Invoice',
        offsetDays: 0,
        instructionsUrl: 'https://docs.google.com/document/d/1PeLSKvs76XiP-bG4WviQur4pQS0Ie25w9I50CZkJYZs/edit',
        requiresFile: true,
      },
      {
        refId: 'send-email-sponsor-publication-live',
        description: 'Send email to notify sponsor that publication is live',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1mIm41ciFJ4aF0lUKbJzbeD_dF7vF-gqEti-vQOJ_mTQ/edit',
      },
      {
        refId: 'schedule-sponsorship-linkedin',
        description: 'Schedule Sponsorship content on LinkedIn',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1pHfmmVGnNKGM4i0um3M5yqpgZJlb6sgHGl0eZ1abW-A/edit',
        requiredLinkName: 'LinkedIn',
      },
      {
        refId: 'schedule-sponsorship-twitter',
        description: 'Schedule Sponsorship content on Twitter',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/18Pm55ewbv1FoO4Cz_Dx-vWICPa0QhgrXiEsvZX7b6DQ/edit',
        requiredLinkName: 'X',
      },
      {
        refId: 'add-newsletter-performance',
        description: 'Add newsletter performance on the spreadsheet',
        offsetDays: 7,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1A4bsGDNh4MP8WPsrTAo2hVJvlfQNKth9O0q55Xnf0oI/edit',
      },
      {
        refId: 'send-performance-to-sponsor',
        description: 'Send the performance of the newsletter to the sponsor',
        offsetDays: 7,
        isMilestone: true,
        stageOnComplete: 'done',
        instructionsUrl: 'https://docs.google.com/document/d/1oXpq9SlHHcSe5JjDrScPT2yVb4n980uTJX_-F6NNqkU/edit',
      },
    ],
  },

  // 2. Book of the Week
  {
    name: 'Book of the Week',
    type: 'book-of-the-week',
    emoji: '\u{1F4DA}',
    tags: ['Book of the Week'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Events', url: 'https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit' },
      { name: 'Events (slack) - book of the week', url: 'https://docs.google.com/document/d/1RdxwuKVGRI69phmPbmJbgoO3o8il52LFZhiUu3qaDME/edit' },
    ],
    bundleLinkDefinitions: [
      { name: 'Guest email' },
      { name: 'Publisher link' },
      { name: 'Website link' },
    ],
    taskDefinitions: [
      {
        refId: 'reach-out-to-book-authors',
        description: 'Reach out to book authors',
        offsetDays: -21,
        instructionsUrl: 'https://docs.google.com/document/d/1rGXg_1qbCmJUQpVxW9w12-BZObWaFBnTEr98eoMAJkk/edit',
      },
      {
        refId: 'agree-on-a-date',
        description: 'Agree on a date',
        offsetDays: -20,
        instructionsUrl: 'https://docs.google.com/document/d/1VC0nV7NVvKw5XaK9xYlLESystohHaaOthgIdyAmBJEo/edit',
      },
      {
        refId: 'change-status-confirmed',
        description: 'Change the status to "confirmed" in the schedule spreadsheet',
        offsetDays: -19,
      },
      {
        refId: 'fill-airtable-form-author',
        description: 'Fill up the Airtable form for each author of the book',
        offsetDays: -18,
        instructionsUrl: 'https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit',
      },
      {
        refId: 'fill-airtable-form-book',
        description: 'Fill up the Airtable form for the book',
        offsetDays: -17,
        instructionsUrl: 'https://docs.google.com/document/d/11S7hjpIV0N3MnVm75ygBfwqB9c9_huRLaHil9Zzx_xY/edit',
      },
      {
        refId: 'create-web-page',
        description: 'Create a web page from the forms',
        offsetDays: -16,
        instructionsUrl: 'https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit',
        requiredLinkName: 'Website link',
      },
      {
        refId: 'announce-event-linkedin',
        description: 'Announce the event on DTC LinkedIn',
        offsetDays: -7,
        isMilestone: true,
      },
      {
        refId: 'remind-author-about-event',
        description: 'Remind the author about the event',
        offsetDays: -7,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1OuOW7IrYQYUS4UK3GBJZRWVIgqW9fp_rkp5hw2bwbjY/edit',
      },
      {
        refId: 'ask-authors-share-event',
        description: 'Ask book authors to share the event page',
        offsetDays: -6,
        instructionsUrl: 'https://docs.google.com/document/d/1wnyMlIO3MuW7TwXkX6NYyo7XXp1hKM_lsp9KUgslSpg/edit',
      },
      {
        refId: 'announce-book-event-linkedin',
        description: 'Announce the book of the week event on DTC LinkedIn',
        offsetDays: 0,
        isMilestone: true,
        stageOnComplete: 'announced',
        instructionsUrl: 'https://docs.google.com/document/d/1HeorFgnMhVt2olNGYJNpoeht_-av-G-nFEf7NLKL8Ek/edit',
      },
      {
        refId: 'comment-from-alexey-linkedin',
        description: "Comment from Alexey's account on LinkedIn",
        offsetDays: 0,
      },
      {
        refId: 'announce-book-event-twitter',
        description: 'Announce the book of the week event on DTC Twitter',
        offsetDays: 0,
        instructionsUrl: 'https://docs.google.com/document/d/1VCRVVhI7Lo4OOAg7Blkab94gyoJrjNRgBVKw3tjbxW4/edit',
      },
      {
        refId: 'invite-author-to-slack',
        description: 'Invite the author(s) to Slack',
        offsetDays: 0,
        instructionsUrl: 'https://docs.google.com/document/d/1G8XBXPTQpX8nf873TQmNpkFee3mDueGoVvPGcE54Eho/edit',
      },
      {
        refId: 'schedule-announcement-slack',
        description: 'Schedule the announcement in Slack',
        offsetDays: 0,
        instructionsUrl: 'https://docs.google.com/document/d/1yf1f8ZLzePv-bFHjTlXmLydEzxGpuIG38BJwkqxAMbI/edit',
      },
      {
        refId: 'announce-book-slack-channels',
        description: 'Announce the book in the #book-of-the-week and #announcements channel',
        offsetDays: 0,
        isMilestone: true,
      },
      {
        refId: 'authors-answer-questions',
        description: 'Authors answer questions',
        offsetDays: 1,
      },
      {
        refId: 'select-winners',
        description: 'Select winners (ask author)',
        offsetDays: 4,
        isMilestone: true,
        stageOnComplete: 'after-event',
        instructionsUrl: 'https://docs.google.com/document/d/1S2CwgVZ9-7v_-9HIMk2CdODlkNqMejxqCOcs2bEo9G8/edit',
      },
      {
        refId: 'collect-emails-from-winners',
        description: 'Collect the emails from winners',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/14QzlXTP1FLHnNAn_ZyTGKlsst-H_hZKSnurzTy8D9TY/edit',
      },
      {
        refId: 'announce-winners-slack',
        description: 'Announce the book-of-the-week winners in the Slack community',
        offsetDays: 6,
        instructionsUrl: 'https://docs.google.com/document/d/1JxtqGk1UamUGp3PxtD3-YCJJagJdJK00CGBEPVd4VH8/edit',
      },
      {
        refId: 'contact-publisher-give-emails',
        description: 'Contact the publisher or the authors and give them the emails',
        offsetDays: 7,
        stageOnComplete: 'done',
        instructionsUrl: 'https://docs.google.com/document/d/1szidymIamDfTI0LpkmwlRz7AX0qsRcPEVrcKtaFz_hs/edit',
      },
      {
        refId: 'fill-newsletter-announcement',
        description: 'Fill in the newsletter announcement',
        offsetDays: -8,
        assigneeId: VALERIIA_ID,
        instructionsUrl: 'https://docs.google.com/document/d/10y0CCq8ApFbH1Mx7wlh_b_ZudnPib9qk_tDysA99xNg/edit',
      },
    ],
  },

  // 3. Podcast
  {
    name: 'Podcast',
    type: 'podcast',
    emoji: '\u{1F399}\u{FE0F}',
    tags: ['Podcast'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Events', url: 'https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit' },
      { name: 'Events (live) - podcast', url: 'https://docs.google.com/document/d/19d_kBOVQJ2p5qZCtGywzWzYeyCv5FWeHApZnEUZIYRg/edit' },
    ],
    bundleLinkDefinitions: [
      { name: 'Guest email' },
      { name: 'Podcast document' },
      { name: 'Luma' },
      { name: 'Meetup' },
      { name: 'Youtube' },
      { name: 'Transcription' },
      { name: 'Spotify for podcasters link' },
      { name: 'Spotify podcast link' },
      { name: 'Apple podcasts link' },
      { name: 'DTC webpage podcast link' },
    ],
    taskDefinitions: [
      {
        refId: 'obtain-speaker-email',
        description: "Obtain speaker's email",
        offsetDays: -28,
        requiredLinkName: 'Guest email',
      },
      {
        refId: 'create-proposed-calendar-invite',
        description: 'Create a proposed calendar invite for guest speaker',
        offsetDays: -27,
        instructionsUrl: 'https://docs.google.com/document/d/1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k/edit',
      },
      {
        refId: 'agree-on-a-date',
        description: 'Agree on a date',
        offsetDays: -26,
        instructionsUrl: 'https://docs.google.com/document/d/1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k/edit',
      },
      {
        refId: 'create-podcast-document',
        description: 'Create a podcast document with the questions',
        offsetDays: -25,
        instructionsUrl: 'https://docs.google.com/document/d/1IVNQQs-Hk-8LzZWox8YWbShJ6Y3sl47H5Z2PC2ra9ZU/edit',
        requiredLinkName: 'Podcast document',
      },
      {
        refId: 'include-johanna-ask-guest-bio',
        description: 'Include Johanna and ask the guest their biography and other information',
        offsetDays: -24,
        instructionsUrl: 'https://docs.google.com/document/d/1Ix73NmCJPfYs0HcokxG5sORj0bFxtZsLrZTLHsp_DDM/edit',
      },
      {
        refId: 'add-guest-as-editor',
        description: 'Add the Guest as an Editor on the podcast document',
        offsetDays: -23,
      },
      {
        refId: 'share-podcast-document-slack',
        description: 'Share the podcast document on the #dtc-podcast-help',
        offsetDays: -22,
        instructionsUrl: 'https://docs.google.com/document/d/1pVL13ku-_zwlqQk8PhmxJkxnRylxzDIKImlzH526k1M/edit',
      },
      {
        refId: 'create-calendar-invite',
        description: 'Create a calendar invite for guest speaker',
        offsetDays: -21,
        instructionsUrl: 'https://docs.google.com/document/d/1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs/edit',
      },
      {
        refId: 'add-guest-bio-to-document',
        description: 'Add a guest bio to the podcast document',
        offsetDays: -20,
        instructionsUrl: 'https://docs.google.com/document/d/1mijZcQ6qRXCscG0DVx6UA9KGgUT_QVTDUSWpQl4aqhE/edit',
      },
      {
        refId: 'fill-people-form-airtable',
        description: 'Fill in the "people" form in Airtable',
        offsetDays: -19,
        instructionsUrl: 'https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit',
      },
      {
        refId: 'create-banner-figma',
        description: 'Create a banner for a podcast event in Figma',
        offsetDays: -18,
        instructionsUrl: 'https://docs.google.com/document/d/1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI/edit',
        requiresFile: true,
      },
      {
        refId: 'create-event-luma',
        description: 'Create an event in Luma',
        offsetDays: -17,
        instructionsUrl: 'https://docs.google.com/document/d/1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8/edit',
        requiredLinkName: 'Luma',
      },
      {
        refId: 'create-event-meetup',
        description: 'Create an event in Meetup',
        offsetDays: -16,
        instructionsUrl: 'https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit',
        requiredLinkName: 'Meetup',
      },
      {
        refId: 'check-meetup-location',
        description: 'Check Meetup if the location is online with the YouTube link',
        offsetDays: -16,
        instructionsUrl: 'https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit',
      },
      {
        refId: 'create-event-calendar',
        description: 'Create event in the DTC community Calendar',
        offsetDays: -15,
        instructionsUrl: 'https://docs.google.com/document/d/1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE/edit',
      },
      {
        refId: 'announce-event-slack',
        description: 'Announce event in Slack in #announcements',
        offsetDays: -14,
        instructionsUrl: 'https://docs.google.com/document/d/1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ/edit',
        stageOnComplete: 'announced',
      },
      {
        refId: 'fill-event-form-airtable',
        description: 'Fill in the "event" form in Airtable',
        offsetDays: -13,
        instructionsUrl: 'https://docs.google.com/document/d/1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8/edit',
      },
      {
        refId: 'add-event-to-webpage',
        description: 'Add the event to the DataTalks.Club webpage',
        offsetDays: -12,
        instructionsUrl: 'https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit',
      },
      {
        refId: 'schedule-posts-linkedin-twitter',
        description: 'Schedule posts on LinkedIn and Twitter',
        offsetDays: -11,
        instructionsUrl: 'https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit',
      },
      {
        refId: 'remind-guest-7d',
        description: 'Remind the guest about the event',
        offsetDays: -7,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA/edit',
      },
      {
        refId: 'remind-guest-1d',
        description: 'Remind the guest about the event',
        offsetDays: -1,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1JSHCMgOufo0UrUD2XE1D4rLc1H0jROTjZB9ARCGeZrk/edit',
      },
      {
        refId: 'actual-stream',
        description: 'Actual stream',
        offsetDays: 0,
        isMilestone: true,
        stageOnComplete: 'after-event',
        requiredLinkName: 'Youtube',
      },
      {
        refId: 'upload-recording-dropbox',
        description: 'Upload the recording to the shared folder in dropbox',
        offsetDays: 1,
        assigneeId: ALEXEY_ID,
      },
      {
        refId: 'update-youtube-cover',
        description: 'Update the cover of the YouTube video',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit',
      },
      {
        refId: 'remove-beginning-recording',
        description: 'Remove the beginning of the recording',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit',
      },
      {
        refId: 'recheck-video-edit',
        description: 'Recheck the video if the edit is successful',
        offsetDays: 2,
      },
      {
        refId: 'create-transcript-document',
        description: 'Create the transcript document',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1lkvu5T4fVT0nnmjIPolLCT4o4dUc3iZ2b7jWycVrtPU/edit',
        requiredLinkName: 'Transcription',
      },
      {
        refId: 'add-to-playlists',
        description: 'Add the video to "livestream" and "podcast" playlists on YouTube',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit',
      },
      {
        refId: 'add-youtube-link-to-website',
        description: 'Add the YouTube link of the stream to the website',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit',
      },
      {
        refId: 'edit-video-description',
        description: 'Edit video description',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit',
      },
      {
        refId: 'include-timecodes',
        description: 'Include timecodes extracted from the transcription',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/1RrTDKmxs9iN2YKnYQ9uSQvdUXRGxPJJ3u7RiQWnCyCw/edit',
      },
      {
        refId: 'ask-guest-for-links',
        description: 'Ask the guest for links after the stream',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1tsuI291-eJ8CxK5MHajEKK3ODZ_TOHfX-XZ-csAFX8Y/edit',
      },
      {
        refId: 'schedule-podcast-spotify',
        description: 'Schedule the edited podcast episode with Spotify for Podcasters',
        offsetDays: 4,
        instructionsUrl: 'https://docs.google.com/document/d/1moSrrDw501TzG3X_DqreK2ZkhRZ40I_d9lCjhF4agQA/edit',
        requiredLinkName: 'Spotify for podcasters link',
      },
      {
        refId: 'moving-podcast-audio-dropbox',
        description: 'Moving Podcast Audio in Dropbox',
        offsetDays: 4,
        instructionsUrl: 'https://docs.google.com/document/d/1PTfM18NgBRICm70hPMcYntCEs_uNxh0lYERhmDcusGA/edit',
      },
      {
        refId: 'add-podcast-episode-airtable',
        description: 'Add a podcast episode via Airtable form',
        offsetDays: 4,
        instructionsUrl: 'https://docs.google.com/document/d/1nUvqLRX18fEWgqeJO-9FNuXDX8SBZpjauIjvfXwaL4k/edit',
      },
      {
        refId: 'create-podcast-page',
        description: 'Create a podcast page with the information from the form',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit',
        requiredLinkName: 'DTC webpage podcast link',
      },
      {
        refId: 'ask-guest-share-podcast-page',
        description: 'Ask the guest to share the podcast page',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1ojQTnenw5yfKL_hn4LCDzfbVRcNxbvNFfEO_1PiIbDQ/edit',
      },
      {
        refId: 'move-podcast-documents-archive',
        description: 'Move the podcast documents to archive in google drive',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1wEs9firI_tlbSNt4jPWTAgTZT1_eaQ6P9VSoDoybu48/edit',
      },
      {
        refId: 'upload-luma-emails-mailchimp',
        description: 'Upload the emails from Luma to Mailchimp',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit',
      },
      {
        refId: 'add-podcast-webpage-newsletter',
        description: 'Add the podcast webpage to the newsletter',
        offsetDays: 6,
        assigneeId: VALERIIA_ID,
        instructionsUrl: 'https://docs.google.com/document/d/1Q6eKmPKAa7LE8-HZrKV9NOdCJLOwlIqB0Txo6aFZUbg/edit',
      },
      {
        refId: 'schedule-posts-overview-after-event',
        description: 'Schedule posts "overview after the event" on LinkedIn and Twitter',
        offsetDays: 6,
        instructionsUrl: 'https://docs.google.com/document/d/1156ty59e3ZlUW3nPpMTd_2smzW40v0ANt9nojUxZ2Gc/edit',
      },
      {
        refId: 'schedule-posts-guest-recommendations',
        description: 'Schedule posts "Guest recommendations" on LinkedIn and Twitter',
        offsetDays: 7,
        isMilestone: true,
        stageOnComplete: 'done',
        instructionsUrl: 'https://docs.google.com/document/d/1XDOfmUHMjKdtlImd5C5LGalCWD8tChefCbB_dtskfWs/edit',
      },
    ],
  },

  // 4. Webinar
  {
    name: 'Webinar',
    type: 'webinar',
    emoji: '\u{1F4FA}',
    tags: ['Webinar'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Events', url: 'https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit' },
      { name: 'Events (live) - webinar', url: 'https://docs.google.com/document/d/1x7MJa_K0ZmuWw5NkTbmUFM9welTD8j86evcRl1c7VtY/edit' },
    ],
    bundleLinkDefinitions: [
      { name: 'Guest email' },
      { name: 'Luma' },
      { name: 'Meetup' },
      { name: 'Youtube' },
    ],
    taskDefinitions: [
      {
        refId: 'initial-contact-speaker',
        description: 'Initial contact with the speaker asking for details',
        offsetDays: -28,
        instructionsUrl: 'https://docs.google.com/document/d/1Hfz6KIIVKDL98t1j0_erGs0RAYCBnJdRjuuFfAxYxHg/edit',
        requiredLinkName: 'Guest email',
      },
      {
        refId: 'agree-on-a-date',
        description: 'Agree on a date',
        offsetDays: -27,
        instructionsUrl: 'https://docs.google.com/document/d/1USXNWAriIlK_AmbHSIR0qt3e0RC0aJh8GCSUJbq7-5k/edit',
      },
      {
        refId: 'create-calendar-invite',
        description: 'Create a calendar invite for the guests',
        offsetDays: -26,
        instructionsUrl: 'https://docs.google.com/document/d/1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs/edit',
      },
      {
        refId: 'get-event-info',
        description: 'Get information about the event: title, subtitle, outline',
        offsetDays: -25,
        instructionsUrl: 'https://docs.google.com/document/d/1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q/edit',
      },
      {
        refId: 'fill-people-form-airtable',
        description: 'Fill in the "people" form in Airtable',
        offsetDays: -24,
        instructionsUrl: 'https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit',
      },
      {
        refId: 'create-banner-figma',
        description: 'Create a banner for a webinar event in Figma',
        offsetDays: -23,
        instructionsUrl: 'https://docs.google.com/document/d/1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI/edit',
        requiresFile: true,
      },
      {
        refId: 'create-events-luma',
        description: 'Create events on Luma',
        offsetDays: -22,
        instructionsUrl: 'https://docs.google.com/document/d/1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8/edit',
        requiredLinkName: 'Luma',
      },
      {
        refId: 'create-events-meetup',
        description: 'Create events on Meetup',
        offsetDays: -21,
        instructionsUrl: 'https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit',
        requiredLinkName: 'Meetup',
      },
      {
        refId: 'check-meetup-location',
        description: 'Check Meetup if the location is online with the YouTube link',
        offsetDays: -21,
      },
      {
        refId: 'create-events-linkedin',
        description: 'Create events on LinkedIn',
        offsetDays: -20,
        instructionsUrl: 'https://docs.google.com/document/d/1ZwnCpleU0xQqZV02KVNSO24gu8HIHIrZdbHLGnZx52k/edit',
      },
      {
        refId: 'create-event-calendar',
        description: 'Create event in Calendar',
        offsetDays: -19,
        instructionsUrl: 'https://docs.google.com/document/d/1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE/edit',
      },
      {
        refId: 'fill-event-form-airtable',
        description: 'Fill in the "event" form in Airtable',
        offsetDays: -18,
        instructionsUrl: 'https://docs.google.com/document/d/1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8/edit',
      },
      {
        refId: 'add-event-to-webpage',
        description: 'Add the event to the DataTalks.Club webpage',
        offsetDays: -17,
        instructionsUrl: 'https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit',
      },
      {
        refId: 'send-luma-link-valeriia',
        description: 'Send Luma link to Valeriia for newsletter',
        offsetDays: -16,
      },
      {
        refId: 'announce-event-slack',
        description: 'Announce event in Slack',
        offsetDays: -15,
        instructionsUrl: 'https://docs.google.com/document/d/1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ/edit',
        stageOnComplete: 'announced',
      },
      {
        refId: 'schedule-posts-linkedin-twitter',
        description: 'Schedule posts on LinkedIn and Twitter',
        offsetDays: -14,
        instructionsUrl: 'https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit',
      },
      {
        refId: 'remind-guest-7d',
        description: 'Remind the guest about the event',
        offsetDays: -7,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA/edit',
      },
      {
        refId: 'remind-guest-1d',
        description: 'Remind the guest about the event',
        offsetDays: -1,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1rMvF296VSzgMvw5Pmy0azE374ZaRHSak2yXVxJGyyTU/edit',
      },
      {
        refId: 'actual-stream',
        description: 'Actual stream',
        offsetDays: 0,
        isMilestone: true,
        stageOnComplete: 'after-event',
        requiredLinkName: 'Youtube',
      },
      {
        refId: 'update-youtube-cover',
        description: 'Update the cover of the YouTube video',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit',
      },
      {
        refId: 'remove-beginning-recording',
        description: 'Remove the beginning of the recording',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit',
      },
      {
        refId: 'recheck-video-edit',
        description: 'Recheck the video if the edit is successful',
        offsetDays: 2,
      },
      {
        refId: 'generate-timecodes',
        description: 'Generate Timecodes Using Youtube Video Transcripts',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit',
      },
      {
        refId: 'adding-timecodes-youtube',
        description: 'Adding timecodes to YouTube videos',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit',
      },
      {
        refId: 'add-to-playlists',
        description: 'Add the video to "livestream" and "webinar" playlists on YouTube',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit',
      },
      {
        refId: 'add-youtube-link-to-website',
        description: 'Add the YouTube link of the stream to the website',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit',
      },
      {
        refId: 'upload-luma-emails-mailchimp',
        description: 'Upload the emails from Luma to Mailchimp',
        offsetDays: 4,
        instructionsUrl: 'https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit',
      },
      {
        refId: 'share-emails-with-sponsor',
        description: 'For sponsored events - share the list with emails with the sponsor',
        offsetDays: 4,
        instructionsUrl: 'https://docs.google.com/document/d/1qf38niJVSAFYz0hkTXVma_bvM9EpArQLUD4wF4YB_Ok/edit',
      },
      {
        refId: 'ask-speaker-recommendations',
        description: 'Ask for speaker recommendations and ask the guest to share the video',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1KuKKupkYHs6V5rdEhbpblIJ2zQcHPJrdauFANX_kA0o/edit',
      },
      {
        refId: 'add-links-from-speaker-youtube',
        description: 'Add links from the speaker to the YouTube video',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit',
      },
      {
        refId: 'fill-newsletter-announcement',
        description: 'Fill in the newsletter announcement',
        offsetDays: 6,
        assigneeId: VALERIIA_ID,
      },
      {
        refId: 'publish-social-media-announcement',
        description: 'Publish social media announcement',
        offsetDays: 7,
        stageOnComplete: 'done',
      },
    ],
  },

  // 5. Workshop
  {
    name: 'Workshop',
    type: 'workshop',
    emoji: '\u{1F527}',
    tags: ['Workshop'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Events', url: 'https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit' },
      { name: 'Events (live) - workshop', url: 'https://docs.google.com/document/d/1tbOClURp1j3MolPY5cI9HzA0QUi8rkXWU_M69RP5BcY/edit' },
    ],
    bundleLinkDefinitions: [
      { name: 'Workshop document' },
      { name: 'Guest email' },
      { name: 'Luma' },
      { name: 'Meetup' },
      { name: 'LinkedIn' },
      { name: 'Youtube' },
    ],
    taskDefinitions: [
      {
        refId: 'initial-contact-speaker',
        description: 'Initial contact with the speaker asking for details',
        offsetDays: -30,
        instructionsUrl: 'https://docs.google.com/document/d/1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q/edit',
        requiredLinkName: 'Guest email',
      },
      {
        refId: 'agree-on-a-date',
        description: 'Agree on a date',
        offsetDays: -29,
      },
      {
        refId: 'create-workshop-document',
        description: 'Create a Workshop Document',
        offsetDays: -28,
        requiredLinkName: 'Workshop document',
      },
      {
        refId: 'create-calendar-invites',
        description: 'Create calendar invites for workshops',
        offsetDays: -27,
        instructionsUrl: 'https://docs.google.com/document/d/1K-1a2EWm6TwyogSiQ4MxuDB_1nqMBwOiRmJ97dlkMjs/edit',
      },
      {
        refId: 'get-event-info',
        description: 'Get information about the event: title, subtitle, outline',
        offsetDays: -26,
        instructionsUrl: 'https://docs.google.com/document/d/1mTTgEphnqkUNd9Ilf6lIGgT9q61Sbt4BCJOEWVSio9Q/edit',
      },
      {
        refId: 'fill-people-form-airtable',
        description: 'Fill in the "people" form in Airtable',
        offsetDays: -25,
        instructionsUrl: 'https://docs.google.com/document/d/1PaX3fYo7grHvQ2d7Mw1LBXZidJmFXqJ6ttk-DUeLNXM/edit',
      },
      {
        refId: 'create-banner-figma',
        description: 'Create a banner for a workshop event in Figma',
        offsetDays: -24,
        instructionsUrl: 'https://docs.google.com/document/d/1z4Uj2GTF9Aq4Dp_Qz_F0UoCFAIYaiFo0h8JEvboz2PI/edit',
        requiresFile: true,
      },
      {
        refId: 'create-events-luma',
        description: 'Create events on Luma',
        offsetDays: -23,
        instructionsUrl: 'https://docs.google.com/document/d/1GbDNYXnA5m-ZQkaRkvQw_NwqDg7m7sSad_vCFUM0Ln8/edit',
        requiredLinkName: 'Luma',
      },
      {
        refId: 'create-events-meetup',
        description: 'Create events on Meetup',
        offsetDays: -22,
        instructionsUrl: 'https://docs.google.com/document/d/1PsxqVk2bm7uhQiD-KbFOiUiiLQmstjT3G97ldnKRlrs/edit',
        requiredLinkName: 'Meetup',
      },
      {
        refId: 'check-meetup-location',
        description: 'Check Meetup if the location is online with the YouTube link',
        offsetDays: -22,
      },
      {
        refId: 'create-events-linkedin',
        description: 'Create events on LinkedIn',
        offsetDays: -21,
        instructionsUrl: 'https://docs.google.com/document/d/1ZwnCpleU0xQqZV02KVNSO24gu8HIHIrZdbHLGnZx52k/edit',
        requiredLinkName: 'LinkedIn',
      },
      {
        refId: 'create-event-calendar',
        description: 'Create event in Calendar',
        offsetDays: -20,
        instructionsUrl: 'https://docs.google.com/document/d/1HwptQpp9w_TihEf7szGL130eSorzY_e_K4jSzAG-rAE/edit',
      },
      {
        refId: 'fill-event-form-airtable',
        description: 'Fill in the "event" form in Airtable',
        offsetDays: -19,
        instructionsUrl: 'https://docs.google.com/document/d/1DEpKCmIGwoOE-erFoUrH6hSO2TB9wcDgZF_S1I395Q8/edit',
      },
      {
        refId: 'add-event-to-webpage',
        description: 'Add the event to the DataTalks.Club webpage',
        offsetDays: -18,
        instructionsUrl: 'https://docs.google.com/document/d/16hYJcuuEiG4nKS123_w95eaX3tcBqn6HgneXl0G9szY/edit',
      },
      {
        refId: 'send-luma-link-valeriia',
        description: 'Send Luma link to Valeriia for newsletter',
        offsetDays: -17,
      },
      {
        refId: 'announce-event-slack',
        description: 'Announce event in Slack in #announcements',
        offsetDays: -16,
        instructionsUrl: 'https://docs.google.com/document/d/1rDHHbtDlkWdzIuD7Nig1ZmNRl6x7RGY7nV4U0YKCbLQ/edit',
        stageOnComplete: 'announced',
      },
      {
        refId: 'announce-event-communities',
        description: 'Announce event on different communities',
        offsetDays: -1,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1VWitGUErmKn8JfzBEYx3BVa-lSl-tLPB2bLDtPFWi9Q/edit',
      },
      {
        refId: 'schedule-posts-linkedin-twitter',
        description: 'Schedule posts on LinkedIn and Twitter',
        offsetDays: -15,
        instructionsUrl: 'https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit',
      },
      {
        refId: 'prepare-send-invoice',
        description: 'Prepare and send an Invoice for Sponsored Workshop',
        offsetDays: -14,
        instructionsUrl: 'https://docs.google.com/document/d/1PeLSKvs76XiP-bG4WviQur4pQS0Ie25w9I50CZkJYZs/edit',
        requiresFile: true,
      },
      {
        refId: 'remind-guest-7d',
        description: 'Remind the guest about the event',
        offsetDays: -7,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1dYqSx7766nWPyj7ROI_NsMsJiXsUT1Q9dhUmNFXCRFA/edit',
      },
      {
        refId: 'remind-guest-1d',
        description: 'Remind the guest about the event',
        offsetDays: -1,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1rMvF296VSzgMvw5Pmy0azE374ZaRHSak2yXVxJGyyTU/edit',
      },
      {
        refId: 'actual-stream',
        description: 'Actual stream',
        offsetDays: 0,
        isMilestone: true,
        stageOnComplete: 'after-event',
        requiredLinkName: 'Youtube',
      },
      {
        refId: 'update-youtube-cover',
        description: 'Update the cover of the YouTube video',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit',
      },
      {
        refId: 'remove-beginning-recording',
        description: 'Remove the beginning of the recording',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1lk98y-hzTq8tczukByjA_yllfaggO_6a9hw38x20LJ8/edit',
      },
      {
        refId: 'recheck-video-edit',
        description: 'Recheck the video if the edit is successful',
        offsetDays: 2,
      },
      {
        refId: 'generate-timecodes',
        description: 'Generate Timecodes Using Youtube Video Transcripts',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1nQQ0wXRuqqVJ5L4CL9xvkHnoAFDxBDld86sj3_LvZ5A/edit',
      },
      {
        refId: 'adding-timecodes-youtube',
        description: 'Adding timecodes to YouTube videos',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit',
      },
      {
        refId: 'add-to-playlists',
        description: 'Add the video to "livestream" and "workshop" playlists on YouTube',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit',
      },
      {
        refId: 'add-youtube-link-to-website',
        description: 'Add the YouTube link of the stream to the website',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/1JFtFaNqYVEZ0aP4AsIeUDSriN9WzBdg09D53mDPWqUw/edit',
      },
      {
        refId: 'publish-social-media-announcement',
        description: 'Publish Social Media Announcement',
        offsetDays: 4,
      },
      {
        refId: 'ask-guests-share-videos',
        description: 'Ask guests to share the videos with their networks',
        offsetDays: 4,
        instructionsUrl: 'https://docs.google.com/document/d/1TYQGVzdcoTH9-ULzFWK-2nGt8X-50ju5kYcnJV4F83M/edit',
      },
      {
        refId: 'ask-sponsor-feedback',
        description: 'For sponsored workshop, ask the sponsor about how did it go',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1kdrmpwrvDjYf_cNVJaLo6qhVJ2B7a5As-DrAx_mYWb8/edit',
      },
      {
        refId: 'upload-luma-emails-mailchimp',
        description: 'Upload the emails from Luma to Mailchimp',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1xyan3b3IdWdOnUZ93qbxpLY6lI9GjiUqzBRUJ1TmzeQ/edit',
      },
      {
        refId: 'share-emails-with-sponsor',
        description: 'For sponsored events - share the list with emails with the sponsor',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1qf38niJVSAFYz0hkTXVma_bvM9EpArQLUD4wF4YB_Ok/edit',
      },
      {
        refId: 'add-links-from-speaker-youtube',
        description: 'Add links from the speaker to the YouTube video',
        offsetDays: 6,
        instructionsUrl: 'https://docs.google.com/document/d/1wj9PWXhYqWopZMzZX4POucoMECoBDCu4I8irbR88qk8/edit',
      },
      {
        refId: 'check-invoice-paid',
        description: 'Check if the Sponsored workshop Invoice has been paid',
        offsetDays: 7,
        stageOnComplete: 'done',
      },
    ],
  },

  // 6. Open-Source Spotlight
  {
    name: 'Open-Source Spotlight',
    type: 'oss',
    emoji: '\u{2699}\u{FE0F}',
    tags: ['Open-Source Spotlight'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Events', url: 'https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit' },
      { name: 'Events (pre-recorded) - Open-Source Spotlight', url: 'https://docs.google.com/document/d/1foX7pya-Ywi153LkZWFWBw2nI6HYvcQKS-QQBEUmGZc/edit' },
    ],
    bundleLinkDefinitions: [
      { name: 'Guest email' },
      { name: 'Tool GitHub' },
      { name: 'Youtube' },
    ],
    taskDefinitions: [
      {
        refId: 'reach-out-github-authors',
        description: 'Reach out to github authors',
        offsetDays: -21,
      },
      {
        refId: 'reach-out-tool-author',
        description: 'Reach out to tool author(s)',
        offsetDays: -20,
        instructionsUrl: 'https://docs.google.com/document/d/1FSJQoMOAZOpiA7EGR2t-xYcu_nEEd2hQSZCC3t5vdq8/edit',
        requiredLinkName: 'Guest email',
      },
      {
        refId: 'find-time-calendly',
        description: "Find time if they can't find anything in calendly",
        offsetDays: -19,
      },
      {
        refId: 'schedule-recording',
        description: 'Schedule the recording',
        offsetDays: -18,
        instructionsUrl: 'https://docs.google.com/document/d/1GsM_Vlit2bB5MCRUH3AQHZWk3xI96ZZEtEvgzb_CMyY/edit',
      },
      {
        refId: 'record-demo',
        description: 'Record the demo',
        offsetDays: -14,
      },
      {
        refId: 'download-upload-youtube',
        description: 'Download the video from zoom and upload to YouTube',
        offsetDays: -13,
        instructionsUrl: 'https://docs.google.com/document/d/1LU0G3jlcCf19hYIp-TNfz94tDUrjEBvyPJ3_QuJQNvg/edit',
        requiredLinkName: 'Youtube',
      },
      {
        refId: 'editing-video',
        description: 'Editing the video',
        offsetDays: -12,
        instructionsUrl: 'https://docs.google.com/document/d/1hN5STE669QiqwL5oWCIEDP-jbe7W2Aa93UKSQ3iUHEU/edit',
      },
      {
        refId: 'add-timecodes-youtube',
        description: 'Add timecodes to the YouTube video',
        offsetDays: -11,
        instructionsUrl: 'https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit',
      },
      {
        refId: 'ask-authors-review-codes',
        description: 'Ask the authors to review the generated codes',
        offsetDays: -10,
        instructionsUrl: 'https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit',
      },
      {
        refId: 'schedule-youtube-video',
        description: 'Schedule Youtube video',
        offsetDays: 0,
        isMilestone: true,
        stageOnComplete: 'after-event',
        instructionsUrl: 'https://docs.google.com/document/d/1GsM_Vlit2bB5MCRUH3AQHZWk3xI96ZZEtEvgzb_CMyY/edit',
      },
      {
        refId: 'tell-author-publish-date',
        description: 'Tell the Author when the OSS video will be published',
        offsetDays: 0,
        instructionsUrl: 'https://docs.google.com/document/d/1_jJLDGSTuyRGz6fimgwJLBGyT_dVl_rfr8T50qIqwa8/edit',
      },
      {
        refId: 'add-to-oss-playlist',
        description: 'Add to the "Open-Source Spotlight" playlist after it\'s published',
        offsetDays: 1,
      },
      {
        refId: 'ask-guest-share-recording',
        description: 'Ask the guest to share the recording with their network',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1JJxAnhoVslGXmjc9Fw3JZrUDD6-srJQcMiHP8rPjMsw/edit',
      },
      {
        refId: 'schedule-social-media',
        description: 'Schedule for Social Media Announcement',
        offsetDays: 2,
        stageOnComplete: 'done',
        instructionsUrl: 'https://docs.google.com/document/d/1BleKsd44Uhhj24D-D5qup0Gf3GcM6cwdAjbZD2jGGuA/edit',
      },
    ],
  },

  // 7. Course
  {
    name: 'Course',
    type: 'course',
    emoji: '\u{1F393}',
    tags: ['Course'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [
      { name: 'Free courses page', url: 'https://datatalks.club/blog/guide-to-free-online-courses-at-datatalks-club.html' },
      { name: 'Playbook to promote courses', url: 'https://docs.google.com/document/d/1ENqjMNPzG4gVTdQzFeDfwyReRbrw2fe2f6AFHrirVBM/edit' },
    ],
    bundleLinkDefinitions: [],
    taskDefinitions: [
      {
        refId: 'create-event-standard-process',
        description: 'Create an event following the standard process',
        offsetDays: -14,
        isMilestone: true,
        instructionsUrl: 'https://docs.google.com/document/d/1ENqjMNPzG4gVTdQzFeDfwyReRbrw2fe2f6AFHrirVBM/edit',
      },
      {
        refId: 'prepare-description-event',
        description: 'Prepare the description for the event',
        offsetDays: -14,
        assigneeId: VALERIIA_ID,
      },
      {
        refId: 'announce-course-start',
        description: 'Announce the course start',
        offsetDays: -30,
        isMilestone: true,
        stageOnComplete: 'announced',
      },
      {
        refId: 'announce-qa-webinar',
        description: 'Announce the Q&A webinar when the event is ready on Luma',
        offsetDays: -15,
      },
      {
        refId: 'announce-course-start-educational',
        description: 'Announce the course start (educational content, carousel, resources)',
        offsetDays: -14,
        isMilestone: true,
      },
      {
        refId: 'feedback-posts',
        description: 'Feedback posts',
        offsetDays: -7,
        isMilestone: true,
      },
      {
        refId: 'reach-out-linkedin-influencers',
        description: 'Reach out to top LinkedIn influencers in the course topic',
        offsetDays: -10,
      },
      {
        refId: 'promote-course-groups',
        description: 'Promote the course in relevant LinkedIn, Facebook, Discord, Slack groups, HackerNews, Reddit, Quora',
        offsetDays: -7,
        stageOnComplete: 'done',
      },
    ],
  },

  // 8. Social Media Weekly Posts
  {
    name: 'Social Media Weekly',
    type: 'social-media',
    emoji: '\u{1F4F1}',
    tags: ['Social media'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'automatic',
    triggerSchedule: '0 9 * * 5',
    triggerLeadDays: 0,
    references: [
      { name: 'New event announcement', url: 'https://docs.google.com/document/d/12Af_uNfrZ4VhjGLRAGm-NzvzCc5dfAG1j9GAaHpZtD0/edit' },
      { name: 'Overview after the podcast', url: 'https://docs.google.com/document/d/1156ty59e3ZlUW3nPpMTd_2smzW40v0ANt9nojUxZ2Gc/edit' },
      { name: 'Guest recommendations from the podcast', url: 'https://docs.google.com/document/d/1XDOfmUHMjKdtlImd5C5LGalCWD8tChefCbB_dtskfWs/edit' },
      { name: 'Post about all upcoming events', url: 'https://docs.google.com/document/d/1NkXUsmaL1JmfX1aO7UbMp349sRGNF6Mu5nd9Dk7Oz2Y/edit' },
      { name: 'Post about OSS', url: 'https://docs.google.com/document/d/1BleKsd44Uhhj24D-D5qup0Gf3GcM6cwdAjbZD2jGGuA/edit' },
      { name: 'Post about article', url: 'https://docs.google.com/document/d/1bj4WnhnRQ_C1L1KJPzUv2REQZOzma9PU8Cz6ZfcV8Fs/edit' },
    ],
    bundleLinkDefinitions: [
      { name: 'Mailchimp Newsletter link' },
      { name: 'Sponsorship document' },
    ],
    taskDefinitions: [
      {
        refId: 'monday',
        description: 'Monday',
        offsetDays: 0,
        isMilestone: true,
      },
      {
        refId: 'tuesday',
        description: 'Tuesday',
        offsetDays: 1,
        isMilestone: true,
      },
      {
        refId: 'wednesday',
        description: 'Wednesday - Sponsorship post (Twitter from sponsorship doc, LinkedIn from newsletter)',
        offsetDays: 2,
        isMilestone: true,
      },
      {
        refId: 'thursday',
        description: 'Thursday',
        offsetDays: 3,
        isMilestone: true,
      },
      {
        refId: 'friday',
        description: 'Friday',
        offsetDays: 4,
        isMilestone: true,
        stageOnComplete: 'done',
      },
    ],
  },

  // 9. Tax Report
  {
    name: 'Tax Report',
    type: 'tax-report',
    emoji: '',
    tags: ['Tax', 'Finance'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'automatic',
    triggerSchedule: '0 9 1 * *',
    triggerLeadDays: 0,
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Tax reports', url: 'https://docs.google.com/document/d/1fuWlBKFxWfupmRz9442En78xAwyXjYw_9Aspf81lhv8/edit' },
    ],
    bundleLinkDefinitions: [
      { name: 'Upload link' },
    ],
    taskDefinitions: [
      {
        refId: 'open-bookkeeping-report',
        description: 'Open the bookkeeping report for the specific month',
        offsetDays: 0,
      },
      {
        refId: 'review-update-todos',
        description: 'Review and update to-dos with actual numbers from Dropbox documents, receipts, and invoices',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1O9TVl2Q2tTDDFaiZro0XTYXpB8i1r9Q6Ryp-dshGFbQ/edit',
      },
      {
        refId: 'convert-currencies',
        description: 'Convert any USD or other non-euro currencies to EUR using WISE',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1WWhBApSyw2JsvkVL6WdmYYRcd9ETf58D5SmN2JnJCXo/edit',
      },
      {
        refId: 'create-bank-statements-finom',
        description: 'Create Bank Statements from Finom',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU/edit',
        requiresFile: true,
      },
      {
        refId: 'create-bank-statements-revolut',
        description: 'Create Bank Statements from Revolut',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q/edit',
        requiresFile: true,
      },
      {
        refId: 'cross-check-revolut-finom',
        description: 'Cross-check Revolut and Finom for any missing expenses or income',
        offsetDays: 4,
        instructionsUrl: 'https://docs.google.com/document/d/1Uh6ZQwQ2wBV2S7WZVnph_SauyPQQTQsym5zrrX94vHg/edit',
      },
      {
        refId: 'prepare-zip-send-accounting',
        description: 'Prepare a zip archive of the report and send it to accounting',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1__AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit',
        requiresFile: true,
        requiredLinkName: 'Upload link',
      },
      {
        refId: 'notify-accountants',
        description: 'Notify the accountants that the report is ready',
        offsetDays: 6,
      },
      {
        refId: 'organize-invoices-folders',
        description: 'Organize invoices folders: Expenses and Incoming Transactions',
        offsetDays: 7,
        stageOnComplete: 'done',
      },
    ],
  },

  // 10. Maven Lightning Lesson
  {
    name: 'Maven Lightning Lesson',
    type: 'maven-ll',
    emoji: '\u{1F4FA}',
    tags: ['Maven', 'Maven Lightning Lesson'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [],
    bundleLinkDefinitions: [
      { name: 'Guest email' },
      { name: 'Maven' },
      { name: 'Youtube' },
    ],
    taskDefinitions: [
      {
        refId: 'alexey-send-content',
        description: 'Alexey will send content for Maven LL',
        offsetDays: -7,
        assigneeId: ALEXEY_ID,
      },
      {
        refId: 'create-blocker-calendar',
        description: 'Create a blocker in the Calendar',
        offsetDays: -6,
      },
      {
        refId: 'create-lightning-lessons-maven',
        description: 'Create Lightning Lessons on Maven',
        offsetDays: -5,
        instructionsUrl: 'https://docs.google.com/document/d/1vINJ7_hVlhvRLzo9aWoIVEk6UXxpvI0IoNTzm5V4O8k/edit',
        requiredLinkName: 'Maven',
      },
      {
        refId: 'create-banner-canva',
        description: 'Create a banner for the event on Canva',
        offsetDays: -4,
        instructionsUrl: 'https://docs.google.com/document/d/12QPknzYsV2TCRAte5_CCPu3T3rfL7i2EnF018Sv46sw/edit',
        requiresFile: true,
      },
      {
        refId: 'download-upload-edit-youtube',
        description: 'Downloading, Uploading and Editing Maven Videos for YouTube',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/13-HQdWdx76Zb1cNFZkXIutzenpwGab2-LRjaiSbc8rw/edit',
        requiredLinkName: 'Youtube',
      },
      {
        refId: 'cut-videos-ffmpeg',
        description: 'Cut the videos using ffmpeg',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1VW_M7LXOPZ09IZQ70qALfHNxIJYpI3oalNMDygj37NI/edit',
      },
      {
        refId: 'send-youtube-link-telegram',
        description: 'Send the Youtube link and cut videos to DTC Content team in Telegram',
        offsetDays: 3,
        stageOnComplete: 'done',
      },
    ],
  },

  // 11. Office Hours
  {
    name: 'Office Hours',
    type: 'office-hours',
    emoji: '\u{1F4FA}',
    tags: ['Office Hours'],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [],
    bundleLinkDefinitions: [
      { name: 'Youtube' },
      { name: 'Summary Document' },
    ],
    taskDefinitions: [
      {
        refId: 'alexey-send-zoom-link',
        description: 'Alexey will send a Zoom video link for Office Hours',
        offsetDays: 0,
        assigneeId: ALEXEY_ID,
      },
      {
        refId: 'download-upload-youtube',
        description: 'Downloading and Uploading Office Hours Videos for YouTube',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1pWWERBr2fQDtU7APUpq78qd_cM4gqIuHarEBVkttF70/edit',
        requiredLinkName: 'Youtube',
      },
      {
        refId: 'summarize-transcripts',
        description: 'Summarizing Video Transcripts For Office Hours',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1QaWt5ePTu9yifyt84-fgGVYProNT28RTVb-PG3a-y1o/edit',
        requiredLinkName: 'Summary Document',
      },
      {
        refId: 'generate-description-timecodes',
        description: 'Generating Office Hours Video Description and Timecodes for YouTube',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/13-HQdWdx76Zb1cNFZkXIutzenpwGab2-LRjaiSbc8rw/edit',
      },
      {
        refId: 'make-announcements-maven',
        description: 'Making announcements in Maven',
        offsetDays: 4,
        stageOnComplete: 'done',
        instructionsUrl: 'https://docs.google.com/document/d/1Se-vZc4iwfLrIskR6L4xaY2fxKE8l_FJ6TFpyDVOVTo/edit',
      },
    ],
  },
];

async function seed(force = false): Promise<void> {
  // Start local DynamoDB and get client
  const port = await startLocal();
  const client = await getClient(port);

  // Create tables if they don't exist
  await createTables(client);

  // Check if the specific seeded templates already exist (by Grace's defaultAssigneeId and known types)
  const existing = await listTemplates(client);
  const GRACE_TYPES = DEFAULT_TEMPLATES.map((t) => t.type);
  const seeded = existing.filter(
    (t) => t.defaultAssigneeId === GRACE_ID && GRACE_TYPES.includes(t.type)
  );

  if (force && seeded.length > 0) {
    console.log(`Force flag set. Deleting ${seeded.length} seeded templates...`);
    for (const t of seeded) {
      await deleteTemplate(client, t.id);
      console.log(`  Deleted template: ${t.name} (${t.id})`);
    }
  } else if (seeded.length >= DEFAULT_TEMPLATES.length) {
    console.log(`Seeded templates already exist (${seeded.length} found). Skipping seed.`);
    return;
  }

  // Create default templates
  const created: Template[] = [];
  for (const templateData of DEFAULT_TEMPLATES) {
    const template = await createTemplate(client, templateData as Record<string, unknown>);
    created.push(template);
    console.log(`Created template: ${template.name} (${template.type}) with ${templateData.taskDefinitions.length} tasks — id: ${template.id}`);
  }

  console.log(`\nSeed complete. Created ${created.length} templates.`);
}

// Run if executed directly
if (require.main === module) {
  const forceFlag = process.argv.includes('--force');
  seed(forceFlag)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

export { seed, DEFAULT_TEMPLATES };
