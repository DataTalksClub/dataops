import { getClient, startLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { listTemplates, createTemplate, deleteTemplate } from '../src/db/templates';
import type { ProofRequirement, TaskDefinition, Template, WorkflowPhase } from '../src/types';

// User IDs from seed-users.ts
const GRACE_ID = '00000000-0000-0000-0000-000000000001';
const VALERIIA_ID = '00000000-0000-0000-0000-000000000002';
const ALEXEY_ID = '00000000-0000-0000-0000-000000000003';

const NEWSLETTER_PHASES: WorkflowPhase[] = [
  { id: 'sponsor-intake', name: 'Sponsor document, email, and follow-up', stage: 'preparation' },
  { id: 'draft-assembly', name: 'Mailchimp draft and content blocks', stage: 'preparation' },
  { id: 'send-prep', name: 'Final review and scheduling', stage: 'preparation' },
  { id: 'publication', name: 'Invoice and sponsor live notification', stage: 'announced' },
  { id: 'promotion', name: 'Sponsored social promotion', stage: 'after-event' },
  { id: 'performance', name: 'Performance stats and sponsor report', stage: 'after-event' },
];

const NEWSLETTER_REQUIRED_BUNDLE_LINKS = [
  'Sponsorship document',
  'Mailchimp newsletter',
  'LinkedIn',
  'X',
];

const NEWSLETTER_SOURCE_DOC_IDS = [
  'task-template.tasks.newsletter',
  'reference.overview.newsletter',
  'reference.newsletter.newsletter-sponsorship',
  'template.newsletter.create-newsletter-draft-from-template-in-mailchimp',
  'sop.newsletter.sponsorship.creating-a-document-for-sponsored-content-for-a-newsletter',
  'sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter',
  'template.newsletter.communication-with-sponsors',
  'template.newsletter.send-sponsorship-document-2-weeks-before',
  'template.newsletter.sending-email-on-the-day-of-publication',
  'template.newsletter.newsletter-performance',
  'sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block',
  'sop.newsletter.mailchimp.add-just-published-podcast-page-to-the-newsletter',
  'sop.newsletter.mailchimp.schedule-a-newsletter-on-mailchimp',
  'sop.newsletter.mailchimp.getting-campaign-performance-stats',
  'sop.newsletter.mailchimp.filling-newsletter-statistics',
  'sop.finance.bookkeeping.creating-invoices-in-finom',
  'sop.social-media.linkedin.schedule-social-media-posts-with-hootsuite-and-post-about-newsletter-promotional-content',
  'sop.social-media.linkedin.creating-sponsored-content-for-linkedin-post',
  'sop.social-media.twitter.schedule-posts-with-twitter-and-post-about-newsletter-promotional-content',
];

const NEWSLETTER_PHASE_BY_REF: Record<string, string> = {
  'create-sponsorship-document': 'sponsor-intake',
  'email-sponsor': 'sponsor-intake',
  'create-mailchimp-campaign': 'draft-assembly',
  'fill-sponsored-block': 'draft-assembly',
  'fill-book-of-the-week-block': 'draft-assembly',
  'fill-event-block': 'draft-assembly',
  'fill-podcast-block': 'draft-assembly',
  'fill-article-block': 'draft-assembly',
  'schedule-email-newsletter': 'send-prep',
  'create-invoice': 'publication',
  'send-email-sponsor-publication-live': 'publication',
  'schedule-sponsorship-linkedin': 'promotion',
  'schedule-sponsorship-twitter': 'promotion',
  'add-newsletter-performance': 'performance',
  'send-performance-to-sponsor': 'performance',
};

const NEWSLETTER_PHASE_SYSTEMS: Record<string, string[]> = {
  'sponsor-intake': ['email', 'google-docs', 'google-drive', 'google-sheets'],
  'draft-assembly': ['mailchimp', 'google-docs', 'website'],
  'send-prep': ['mailchimp'],
  publication: ['finom', 'email', 'mailchimp'],
  promotion: ['linkedin', 'twitter', 'hootsuite', 'google-sheets'],
  performance: ['mailchimp', 'linkedin', 'twitter', 'google-sheets', 'email'],
};

const NEWSLETTER_DOC_CONTEXT: Record<string, Pick<TaskDefinition, 'instructionDocId' | 'instructionStepId' | 'systems'>> = {
  'create-sponsorship-document': {
    instructionDocId: 'sop.newsletter.sponsorship.creating-a-document-for-sponsored-content-for-a-newsletter',
    systems: ['google-drive', 'google-docs', 'mailchimp', 'google-sheets'],
  },
  'email-sponsor': {
    instructionDocId: 'template.newsletter.send-sponsorship-document-2-weeks-before',
    systems: ['email', 'google-docs'],
  },
  'create-mailchimp-campaign': {
    instructionDocId: 'template.newsletter.create-newsletter-draft-from-template-in-mailchimp',
    systems: ['mailchimp', 'google-sheets'],
  },
  'fill-sponsored-block': {
    instructionDocId: 'sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter',
    systems: ['mailchimp', 'google-docs'],
  },
  'fill-book-of-the-week-block': {
    instructionDocId: 'sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block',
    systems: ['mailchimp', 'website'],
  },
  'fill-event-block': {
    instructionDocId: 'template.newsletter.create-newsletter-draft-from-template-in-mailchimp',
    systems: ['mailchimp', 'website', 'luma', 'meetup'],
  },
  'fill-podcast-block': {
    instructionDocId: 'sop.newsletter.mailchimp.add-just-published-podcast-page-to-the-newsletter',
    systems: ['mailchimp', 'website'],
  },
  'fill-article-block': {
    instructionDocId: 'template.newsletter.create-newsletter-draft-from-template-in-mailchimp',
    systems: ['mailchimp', 'website'],
  },
  'schedule-email-newsletter': {
    instructionDocId: 'sop.newsletter.mailchimp.schedule-a-newsletter-on-mailchimp',
    systems: ['mailchimp'],
  },
  'create-invoice': {
    instructionDocId: 'sop.finance.bookkeeping.creating-invoices-in-finom',
    systems: ['finom', 'email'],
  },
  'send-email-sponsor-publication-live': {
    instructionDocId: 'template.newsletter.sending-email-on-the-day-of-publication',
    systems: ['email', 'mailchimp'],
  },
  'schedule-sponsorship-linkedin': {
    instructionDocId: 'sop.social-media.linkedin.schedule-social-media-posts-with-hootsuite-and-post-about-newsletter-promotional-content',
    systems: ['linkedin', 'hootsuite', 'google-sheets'],
  },
  'schedule-sponsorship-twitter': {
    instructionDocId: 'sop.social-media.twitter.schedule-posts-with-twitter-and-post-about-newsletter-promotional-content',
    systems: ['twitter', 'google-sheets'],
  },
  'add-newsletter-performance': {
    instructionDocId: 'sop.newsletter.mailchimp.filling-newsletter-statistics',
    systems: ['mailchimp', 'linkedin', 'twitter', 'google-sheets'],
  },
  'send-performance-to-sponsor': {
    instructionDocId: 'template.newsletter.newsletter-performance',
    systems: ['email', 'mailchimp', 'linkedin', 'twitter'],
  },
};

const NEWSLETTER_WAITING_TASKS: Record<string, string> = {
  'email-sponsor': 'sponsor content, graphics, or Valeriia review',
  'fill-sponsored-block': 'approved sponsor copy, visual, and CTA',
  'send-email-sponsor-publication-live': 'sponsor contact confirmation or corrected publication link',
  'send-performance-to-sponsor': 'complete Mailchimp, LinkedIn, and X performance stats',
};

const NEWSLETTER_AT_RISK_BY_REF: Record<string, string[]> = {
  'email-sponsor': ['missing sponsorship document link', 'sponsor content deadline not communicated'],
  'fill-sponsored-block': ['missing sponsorship document link', 'sponsor content still waiting', 'approved sponsor copy not available'],
  'schedule-email-newsletter': ['missing Mailchimp newsletter link', 'campaign not scheduled'],
  'create-invoice': ['missing invoice file or link'],
  'send-email-sponsor-publication-live': ['missing Mailchimp newsletter link'],
  'schedule-sponsorship-linkedin': ['missing LinkedIn post link'],
  'schedule-sponsorship-twitter': ['missing X post link'],
  'add-newsletter-performance': ['missing Mailchimp, LinkedIn, or X performance stats'],
  'send-performance-to-sponsor': ['performance stats not collected', 'sponsor performance email not sent'],
};

const PODCAST_PHASES: WorkflowPhase[] = [
  { id: 'guest-intake', name: 'Guest intake and date confirmation', stage: 'preparation' },
  { id: 'prep-document', name: 'Podcast prep document and guest collaboration', stage: 'preparation' },
  { id: 'event-setup', name: 'Event setup and announcements', stage: 'preparation' },
  { id: 'pre-event-reminders', name: 'Pre-event reminders', stage: 'announced' },
  { id: 'live-stream', name: 'Live stream', stage: 'announced' },
  { id: 'post-production', name: 'Recording, transcript, and YouTube production', stage: 'after-event' },
  { id: 'publication', name: 'Podcast publication', stage: 'after-event' },
  { id: 'follow-up-archive', name: 'Guest follow-up, newsletter, social, and archive', stage: 'after-event' },
];

const PODCAST_REQUIRED_BUNDLE_LINKS = [
  'Guest email',
  'Podcast document',
  'Luma',
  'Meetup',
  'YouTube stream/video',
  'Transcription',
  'Spotify for Podcasters',
  'Public Spotify episode',
  'Apple Podcasts episode',
  'DTC webpage podcast link',
  'Dropbox recording folder',
  'Podcast banner or cover',
];

const PODCAST_SOURCE_DOC_IDS = [
  'task-template.tasks.podcast',
  'sop.media.podcast.create-podcast-document',
  'sop.media.podcast.managing-podcast-workflow',
  'sop.media.podcast.reach-out-to-guests-and-propose-a-date-on-linkedin',
  'sop.media.podcast.select-and-propose-a-date-for-events',
  'sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event',
  'sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma',
  'sop.events.meetup.create-events-in-meetup-com',
  'sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website',
  'sop.events.announce-event-in-slack-in-announcements',
  'sop.media.podcast.creating-podcast-transcription-document',
  'sop.media.podcast.schedule-podcast-episodes-with-spotify-for-podcaster',
  'sop.media.podcast.add-a-podcast-episode-via-airtable-form',
  'sop.media.podcast.move-podcast-documents-to-archive-in-google-drive',
  'sop.social-media.post-podcast-guest-recommendations',
];

const PODCAST_EXTERNAL_SOURCE_DOC_IDS = [
  {
    id: 'template.media.podcast.podcast-guest-intake',
    path: 'assistants/podcast/templates/podcast_guest_intake.md',
    reason: 'assistant-local intake template, not indexed by the content registry yet',
  },
  {
    id: 'assistant.podcast.process.podcast',
    path: 'assistants/podcast/process/podcast.md',
    reason: 'assistant-local process guide, not indexed by the content registry yet',
  },
];

const PODCAST_PHASE_BY_REF: Record<string, string> = {
  'obtain-speaker-email': 'guest-intake',
  'create-proposed-calendar-invite': 'guest-intake',
  'agree-on-a-date': 'guest-intake',
  'create-podcast-document': 'prep-document',
  'include-johanna-ask-guest-bio': 'prep-document',
  'add-guest-as-editor': 'prep-document',
  'share-podcast-document-slack': 'prep-document',
  'create-calendar-invite': 'prep-document',
  'add-guest-bio-to-document': 'prep-document',
  'fill-people-form-airtable': 'prep-document',
  'create-banner-figma': 'prep-document',
  'create-event-luma': 'event-setup',
  'create-event-meetup': 'event-setup',
  'check-meetup-location': 'event-setup',
  'create-event-calendar': 'event-setup',
  'announce-event-slack': 'event-setup',
  'fill-event-form-airtable': 'event-setup',
  'add-event-to-webpage': 'event-setup',
  'schedule-posts-linkedin-twitter': 'event-setup',
  'remind-guest-7d': 'pre-event-reminders',
  'remind-guest-1d': 'pre-event-reminders',
  'actual-stream': 'live-stream',
  'upload-recording-dropbox': 'post-production',
  'update-youtube-cover': 'post-production',
  'remove-beginning-recording': 'post-production',
  'recheck-video-edit': 'post-production',
  'create-transcript-document': 'post-production',
  'add-to-playlists': 'post-production',
  'add-youtube-link-to-website': 'post-production',
  'edit-video-description': 'post-production',
  'include-timecodes': 'post-production',
  'ask-guest-for-links': 'post-production',
  'schedule-podcast-spotify': 'publication',
  'moving-podcast-audio-dropbox': 'publication',
  'add-podcast-episode-airtable': 'publication',
  'create-podcast-page': 'publication',
  'ask-guest-share-podcast-page': 'follow-up-archive',
  'move-podcast-documents-archive': 'follow-up-archive',
  'upload-luma-emails-mailchimp': 'follow-up-archive',
  'add-podcast-webpage-newsletter': 'follow-up-archive',
  'schedule-posts-overview-after-event': 'follow-up-archive',
  'schedule-posts-guest-recommendations': 'follow-up-archive',
};

const PODCAST_PHASE_SYSTEMS: Record<string, string[]> = {
  'guest-intake': ['email', 'google-calendar', 'linkedin'],
  'prep-document': ['google-docs', 'google-drive', 'email', 'slack'],
  'event-setup': ['luma', 'meetup', 'airtable', 'website', 'slack', 'linkedin', 'twitter'],
  'pre-event-reminders': ['email', 'luma'],
  'live-stream': ['youtube', 'google-calendar'],
  'post-production': ['youtube', 'dropbox', 'google-docs', 'email'],
  publication: ['spotify', 'apple-podcasts', 'airtable', 'dropbox', 'website'],
  'follow-up-archive': ['email', 'google-drive', 'mailchimp', 'linkedin', 'twitter'],
};

const PODCAST_DOC_CONTEXT: Record<string, Pick<TaskDefinition, 'instructionDocId' | 'instructionStepId' | 'systems'>> = {
  'obtain-speaker-email': {
    instructionDocId: 'sop.events.outreach.how-to-find-emails-of-previous-guests',
    systems: ['email', 'linkedin', 'google-search'],
  },
  'create-proposed-calendar-invite': {
    instructionDocId: 'sop.events.calendar.creating-tentative-event-on-google-calendar',
    instructionStepId: '1',
    systems: ['google-calendar', 'email'],
  },
  'agree-on-a-date': {
    instructionDocId: 'sop.media.podcast.select-and-propose-a-date-for-events',
    instructionStepId: '1',
    systems: ['email', 'google-calendar'],
  },
  'create-podcast-document': {
    instructionDocId: 'sop.media.podcast.create-podcast-document',
    instructionStepId: '1',
    systems: ['google-drive', 'google-docs', 'github', 'linkedin', 'twitter', 'assistant'],
  },
  'include-johanna-ask-guest-bio': {
    instructionDocId: 'template.media.podcast.podcast-adding-johanna-and-sending-the-podcast-link-to-the-speaker',
    systems: ['email', 'google-docs'],
  },
  'add-guest-as-editor': {
    instructionDocId: 'sop.media.podcast.create-podcast-document',
    instructionStepId: '6',
    systems: ['google-docs', 'email'],
  },
  'share-podcast-document-slack': {
    instructionDocId: 'template.media.podcast.sending-podcast-document-on-slack-the-dtc-podcast-help-channel',
    systems: ['slack', 'google-docs'],
  },
  'create-calendar-invite': {
    instructionDocId: 'sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event',
    instructionStepId: '1',
    systems: ['google-calendar', 'youtube'],
  },
  'add-guest-bio-to-document': {
    instructionDocId: 'sop.media.podcast.add-a-guest-bio-to-the-podcast-document',
    instructionStepId: '1',
    systems: ['google-docs', 'email'],
  },
  'fill-people-form-airtable': {
    instructionDocId: 'sop.events.planning.create-speaker-profiles-via-airtable-form',
    instructionStepId: '1',
    systems: ['airtable'],
  },
  'create-banner-figma': {
    instructionDocId: 'sop.media.podcast.making-event-announcements-when-topic-bio-or-outline-is-missing',
    systems: ['figma', 'google-docs'],
  },
  'create-event-luma': {
    instructionDocId: 'sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma',
    instructionStepId: '1',
    systems: ['luma', 'google-calendar', 'youtube'],
  },
  'create-event-meetup': {
    instructionDocId: 'sop.events.meetup.create-events-in-meetup-com',
    instructionStepId: '1',
    systems: ['meetup', 'luma', 'youtube'],
  },
  'check-meetup-location': {
    instructionDocId: 'sop.events.meetup.create-events-in-meetup-com',
    systems: ['meetup', 'youtube'],
  },
  'create-event-calendar': {
    instructionDocId: 'sop.events.luma.creating-events-on-google-calendar',
    systems: ['google-calendar', 'luma'],
  },
  'announce-event-slack': {
    instructionDocId: 'sop.events.announce-event-in-slack-in-announcements',
    instructionStepId: '1',
    systems: ['slack', 'luma'],
  },
  'fill-event-form-airtable': {
    instructionDocId: 'sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website',
    instructionStepId: '1',
    systems: ['airtable', 'luma'],
  },
  'add-event-to-webpage': {
    instructionDocId: 'sop.media.podcast.update-the-website-with-the-information-from-forms',
    systems: ['github', 'website', 'airtable'],
  },
  'schedule-posts-linkedin-twitter': {
    instructionDocId: 'template.social-media.template-new-event-announcements-podcasts-webinars-workshops',
    systems: ['linkedin', 'twitter', 'hootsuite'],
  },
  'remind-guest-7d': {
    instructionDocId: 'template.media.podcast.podcast-remind-about-the-event-in-a-week-share-registration-link-template',
    systems: ['email', 'luma'],
  },
  'remind-guest-1d': {
    instructionDocId: 'template.media.podcast.podcast-remind-the-guest-about-the-event-a-day-before-template',
    systems: ['email', 'luma'],
  },
  'actual-stream': {
    instructionDocId: 'sop.media.podcast.managing-podcast-workflow',
    instructionStepId: '1',
    systems: ['youtube', 'streamyard', 'google-calendar'],
  },
  'upload-recording-dropbox': {
    instructionDocId: 'sop.media.podcast.managing-podcast-workflow',
    instructionStepId: '1',
    systems: ['dropbox', 'youtube'],
  },
  'update-youtube-cover': {
    instructionDocId: 'sop.media.podcast.updating-the-cover-of-the-youtube-video',
    instructionStepId: '1',
    systems: ['youtube', 'figma'],
  },
  'remove-beginning-recording': {
    instructionDocId: 'sop.media.podcast.removing-the-beginning-from-the-youtube-stream',
    instructionStepId: '1',
    systems: ['youtube'],
  },
  'recheck-video-edit': {
    instructionDocId: 'sop.media.podcast.removing-the-beginning-from-the-youtube-stream',
    systems: ['youtube'],
  },
  'create-transcript-document': {
    instructionDocId: 'sop.media.podcast.creating-podcast-transcription-document',
    instructionStepId: '1',
    systems: ['google-docs', 'dropbox', 'email'],
  },
  'add-to-playlists': {
    instructionDocId: 'sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist',
    systems: ['youtube'],
  },
  'add-youtube-link-to-website': {
    instructionDocId: 'sop.media.podcast.add-links-to-youtube-after-the-stream-is-over',
    instructionStepId: '1',
    systems: ['github', 'website', 'youtube'],
  },
  'edit-video-description': {
    instructionDocId: 'sop.media.podcast.add-links-to-youtube-after-the-stream-is-over',
    systems: ['youtube'],
  },
  'include-timecodes': {
    instructionDocId: 'sop.media.podcast.generate-timecodes-from-docx-transcriptions',
    instructionStepId: '1',
    systems: ['youtube', 'google-docs'],
  },
  'ask-guest-for-links': {
    instructionDocId: 'template.media.podcast.podcast-links-after-the-event-is-over',
    systems: ['email', 'google-docs'],
  },
  'schedule-podcast-spotify': {
    instructionDocId: 'sop.media.podcast.schedule-podcast-episodes-with-spotify-for-podcaster',
    instructionStepId: '1',
    systems: ['spotify', 'apple-podcasts'],
  },
  'moving-podcast-audio-dropbox': {
    instructionDocId: 'sop.media.podcast.moving-podcast-audio-in-dropbox',
    instructionStepId: '1',
    systems: ['dropbox'],
  },
  'add-podcast-episode-airtable': {
    instructionDocId: 'sop.media.podcast.add-a-podcast-episode-via-airtable-form',
    instructionStepId: '1',
    systems: ['airtable', 'spotify', 'apple-podcasts'],
  },
  'create-podcast-page': {
    instructionDocId: 'sop.media.podcast.update-the-website-with-the-information-from-forms',
    systems: ['github', 'website', 'airtable'],
  },
  'ask-guest-share-podcast-page': {
    instructionDocId: 'template.media.podcast.podcast-share-the-podcast-page-template',
    systems: ['email', 'website'],
  },
  'move-podcast-documents-archive': {
    instructionDocId: 'sop.media.podcast.move-podcast-documents-to-archive-in-google-drive',
    instructionStepId: '1',
    systems: ['google-drive'],
  },
  'upload-luma-emails-mailchimp': {
    instructionDocId: 'sop.events.luma.downloading-the-csv-file-on-luma',
    systems: ['luma', 'mailchimp'],
  },
  'add-podcast-webpage-newsletter': {
    instructionDocId: 'sop.media.podcast.sending-a-podcast-scheduled-email-to-pavel-after-the-event',
    systems: ['mailchimp', 'website'],
  },
  'schedule-posts-overview-after-event': {
    instructionDocId: 'reference.social-media.post-podcast-overview-after-the-event',
    systems: ['linkedin', 'twitter', 'hootsuite'],
  },
  'schedule-posts-guest-recommendations': {
    instructionDocId: 'sop.social-media.post-podcast-guest-recommendations',
    systems: ['linkedin', 'twitter', 'hootsuite'],
  },
};

const PODCAST_WAITING_TASKS: Record<string, string> = {
  'obtain-speaker-email': 'speaker email or working contact path',
  'agree-on-a-date': 'guest date confirmation',
  'include-johanna-ask-guest-bio': 'guest bio, links, and prep material',
  'add-guest-bio-to-document': 'guest bio and links',
  'create-event-luma': 'complete topic, bio, outline, banner, and stream details',
  'create-event-meetup': 'Luma event and YouTube stream link',
  'ask-guest-for-links': 'guest post-stream links',
  'create-transcript-document': 'freelancer transcript handoff and returned transcript',
  'schedule-podcast-spotify': 'public Spotify and Apple Podcasts publication links',
  'ask-guest-share-podcast-page': 'guest reply or share confirmation',
};

const PODCAST_AT_RISK_BY_REF: Record<string, string[]> = {
  'create-podcast-document': ['missing podcast document', 'unresolved assistant TODOs'],
  'create-event-luma': ['missing podcast document', 'missing event page'],
  'create-event-meetup': ['missing Luma link', 'missing YouTube link', 'missing Meetup page'],
  'actual-stream': ['missing YouTube stream/video link'],
  'upload-recording-dropbox': ['missing recording upload'],
  'create-transcript-document': ['missing recording', 'missing transcription'],
  'schedule-podcast-spotify': ['missing Spotify for Podcasters link', 'missing public Spotify episode', 'missing Apple Podcasts episode'],
  'create-podcast-page': ['missing DTC podcast page'],
};

const TAX_REPORT_PHASES: WorkflowPhase[] = [
  { id: 'report-intake', name: 'Report access and source document review', stage: 'preparation' },
  { id: 'reconciliation', name: 'Spreadsheet values and bank reconciliation', stage: 'preparation' },
  { id: 'statements', name: 'Bank statement exports', stage: 'preparation' },
  { id: 'accountant-handoff', name: 'ZIP package, upload, and accountant notification', stage: 'after-event' },
  { id: 'cleanup', name: 'Processed folders and workflow closure', stage: 'after-event' },
];

const TAX_REPORT_REQUIRED_BUNDLE_LINKS = [
  'Monthly report/spreadsheet',
  'Accountant upload/share link',
  'Accountant email thread',
];

const TAX_REPORT_SOURCE_DOC_IDS = [
  'task-template.tasks.tax-report',
  'sop.finance.tax-reporting.monthly-tax-report',
  'sop.finance.bookkeeping.adding-paid-invoices-to-the-bookkeeping-spreadsheet-and-adding-it-to-dropbox',
  'sop.finance.bookkeeping.for-update-converting-usd-to-eur-for-revolut-transcations',
  'sop.finance.bookkeeping.creating-bank-statements-in-finom',
  'sop.finance.bookkeeping.creating-bank-statements-in-revolut',
  'sop.finance.bookkeeping.crosschecking-with-revolut-and-finom',
  'sop.finance.bookkeeping.preparing-a-zip-archive-with-invoices-and-send-reports-to-the-accountant',
  'sop.finance.bookkeeping.sending-reports-to-accountants-for-bookkeeping',
  'template.finance.bookkeeping.sending-reports-to-accountants-for-bookkeeping-email-template',
  'reference.finance.invoices-receipts-and-statements',
];

const TAX_REPORT_PHASE_BY_REF: Record<string, string> = {
  'open-bookkeeping-report': 'report-intake',
  'review-update-todos': 'reconciliation',
  'convert-currencies': 'reconciliation',
  'create-bank-statements-finom': 'statements',
  'create-bank-statements-revolut': 'statements',
  'cross-check-revolut-finom': 'reconciliation',
  'prepare-zip-send-accounting': 'accountant-handoff',
  'notify-accountants': 'accountant-handoff',
  'organize-invoices-folders': 'cleanup',
};

const TAX_REPORT_PHASE_SYSTEMS: Record<string, string[]> = {
  'report-intake': ['google-sheets', 'google-docs', 'dataops'],
  reconciliation: ['google-sheets', 'dropbox', 'finom', 'revolut', 'wise'],
  statements: ['finom', 'revolut', 'dropbox'],
  'accountant-handoff': ['dropbox', 'email', 'accountant-upload', 'google-sheets'],
  cleanup: ['dropbox', 'dataops'],
};

const TAX_REPORT_DOC_CONTEXT: Record<string, Pick<TaskDefinition, 'instructionDocId' | 'instructionStepId' | 'systems'>> = {
  'open-bookkeeping-report': {
    instructionDocId: 'sop.finance.tax-reporting.monthly-tax-report',
    systems: ['google-sheets', 'google-docs'],
  },
  'review-update-todos': {
    instructionDocId: 'sop.finance.bookkeeping.adding-paid-invoices-to-the-bookkeeping-spreadsheet-and-adding-it-to-dropbox',
    systems: ['google-sheets', 'dropbox'],
  },
  'convert-currencies': {
    instructionDocId: 'sop.finance.bookkeeping.for-update-converting-usd-to-eur-for-revolut-transcations',
    systems: ['revolut', 'wise', 'google-sheets'],
  },
  'create-bank-statements-finom': {
    instructionDocId: 'sop.finance.bookkeeping.creating-bank-statements-in-finom',
    systems: ['finom', 'dropbox'],
  },
  'create-bank-statements-revolut': {
    instructionDocId: 'sop.finance.bookkeeping.creating-bank-statements-in-revolut',
    systems: ['revolut', 'dropbox'],
  },
  'cross-check-revolut-finom': {
    instructionDocId: 'sop.finance.bookkeeping.crosschecking-with-revolut-and-finom',
    systems: ['google-sheets', 'finom', 'revolut', 'dropbox'],
  },
  'prepare-zip-send-accounting': {
    instructionDocId: 'sop.finance.bookkeeping.preparing-a-zip-archive-with-invoices-and-send-reports-to-the-accountant',
    systems: ['dropbox', 'accountant-upload', 'google-sheets'],
  },
  'notify-accountants': {
    instructionDocId: 'sop.finance.bookkeeping.sending-reports-to-accountants-for-bookkeeping',
    systems: ['email', 'google-sheets', 'accountant-upload'],
  },
  'organize-invoices-folders': {
    instructionDocId: 'sop.finance.bookkeeping.preparing-a-zip-archive-with-invoices-and-send-reports-to-the-accountant',
    instructionStepId: '10',
    systems: ['dropbox', 'dataops'],
  },
};

const TAX_REPORT_WAITING_TASKS: Record<string, string> = {
  'open-bookkeeping-report': 'monthly report access or spreadsheet range confirmation',
  'review-update-todos': 'missing receipt, invoice, statement, owner clarification, or source document',
  'convert-currencies': 'transaction screenshot, Wise/Revolut evidence, or source EUR amount',
  'create-bank-statements-finom': 'Finom access or monthly statement export availability',
  'create-bank-statements-revolut': 'Revolut access or monthly statement export availability',
  'cross-check-revolut-finom': 'missing invoice/receipt, income invoice, Alexey clarification, or accounting rule clarification',
  'prepare-zip-send-accounting': 'missing required file or accountant upload destination availability',
  'notify-accountants': 'accountant acknowledgment or clarification',
  'organize-invoices-folders': 'unresolved missing file cleanup blocker',
};

const TAX_REPORT_AT_RISK_BY_REF: Record<string, string[]> = {
  'open-bookkeeping-report': ['missing month-specific report link', 'wrong month selected'],
  'review-update-todos': ['TODO values still present', 'missing invoice, receipt, or statement'],
  'convert-currencies': ['unclear EUR amount', 'missing conversion source/date'],
  'create-bank-statements-finom': ['missing Finom statement file'],
  'create-bank-statements-revolut': ['missing Revolut statement file'],
  'cross-check-revolut-finom': ['unmatched Finom or Revolut transactions', 'undeclared income not resolved'],
  'prepare-zip-send-accounting': ['missing tax ZIP file', 'missing accountant upload/share link'],
  'notify-accountants': ['missing accountant email thread', 'accountant acknowledgment pending'],
  'organize-invoices-folders': ['required proof missing', 'waiting follow-up still due', 'processed folders not organized'],
};

const OSS_PHASES: WorkflowPhase[] = [
  { id: 'lead-outreach', name: 'Lead selection and author outreach', stage: 'preparation' },
  { id: 'recording-scheduling', name: 'Recording date coordination', stage: 'preparation' },
  { id: 'recording-intake', name: 'Recording intake and YouTube draft', stage: 'preparation' },
  { id: 'video-production', name: 'Video edit, timecodes, and author review', stage: 'preparation' },
  { id: 'publication', name: 'YouTube schedule, playlist, and author publication notice', stage: 'after-event' },
  { id: 'promotion-follow-up', name: 'Guest sharing, recommendations, and social announcement', stage: 'after-event' },
];

const OSS_REQUIRED_BUNDLE_LINKS = [
  'Guest email',
  'Tool GitHub',
  'Recording source',
  'YouTube',
  'Author review',
  'OSS playlist',
  'Social announcement',
];

const OSS_SOURCE_DOC_IDS = [
  'task-template.tasks.oss',
  'reference.overview.events',
  'reference.overview.events-pre-recorded-open-source-spotlight',
  'sop.media.open-source-spotlight.reach-out-to-open-source-spotlight-guests',
  'sop.media.open-source-spotlight.joining-open-source-project-communities-and-asking-for-oss-demos',
  'sop.media.open-source-spotlight.filling-in-the-open-source-spotlight-airtable-database',
  'sop.media.open-source-spotlight.find-timestamps-for-editing',
  'sop.media.open-source-spotlight.adding-links-from-the-zoom-chat',
  'sop.media.open-source-spotlight.adding-timecodes-for-open-source-spotlight-videos',
  'sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos',
  'template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool',
  'template.media.open-source-spotlight.oss-asking-for-revisions-and-links',
  'template.media.open-source-spotlight.oss-ask-the-guests-to-share-the-videos-with-their-networks',
  'reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube',
  'reference.social-media.post-oss',
  'sop.media.video-youtube.add-timecodes-to-youtube-videos',
  'sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist',
];

const OSS_PHASE_BY_REF: Record<string, string> = {
  'reach-out-github-authors': 'lead-outreach',
  'reach-out-tool-author': 'lead-outreach',
  'find-time-calendly': 'recording-scheduling',
  'schedule-recording': 'recording-scheduling',
  'record-demo': 'recording-intake',
  'download-upload-youtube': 'recording-intake',
  'editing-video': 'video-production',
  'add-timecodes-youtube': 'video-production',
  'ask-authors-review-codes': 'video-production',
  'schedule-youtube-video': 'publication',
  'tell-author-publish-date': 'publication',
  'add-to-oss-playlist': 'publication',
  'ask-guest-share-recording': 'promotion-follow-up',
  'schedule-social-media': 'promotion-follow-up',
};

const OSS_PHASE_SYSTEMS: Record<string, string[]> = {
  'lead-outreach': ['github', 'linkedin', 'email', 'airtable', 'slack'],
  'recording-scheduling': ['calendly', 'google-calendar', 'email', 'zoom'],
  'recording-intake': ['zoom', 'youtube', 'google-drive'],
  'video-production': ['zoom', 'youtube', 'google-docs', 'email'],
  publication: ['youtube', 'email'],
  'promotion-follow-up': ['email', 'linkedin', 'twitter', 'hootsuite', 'youtube'],
};

const OSS_DOC_CONTEXT: Record<string, Pick<TaskDefinition, 'instructionDocId' | 'instructionStepId' | 'systems'>> = {
  'reach-out-github-authors': {
    instructionDocId: 'sop.media.open-source-spotlight.reach-out-to-open-source-spotlight-guests',
    instructionStepId: '1',
    systems: ['github', 'linkedin', 'airtable'],
  },
  'reach-out-tool-author': {
    instructionDocId: 'template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool',
    systems: ['email', 'github', 'linkedin'],
  },
  'find-time-calendly': {
    instructionDocId: 'reference.overview.events-pre-recorded-open-source-spotlight',
    systems: ['calendly', 'google-calendar', 'email'],
  },
  'schedule-recording': {
    instructionDocId: 'reference.overview.events-pre-recorded-open-source-spotlight',
    systems: ['google-calendar', 'zoom', 'email'],
  },
  'record-demo': {
    instructionDocId: 'reference.overview.events-pre-recorded-open-source-spotlight',
    systems: ['zoom', 'youtube'],
  },
  'download-upload-youtube': {
    instructionDocId: 'reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube',
    systems: ['zoom', 'youtube', 'google-drive'],
  },
  'editing-video': {
    instructionDocId: 'sop.media.open-source-spotlight.find-timestamps-for-editing',
    instructionStepId: '1',
    systems: ['zoom', 'youtube', 'google-sheets'],
  },
  'add-timecodes-youtube': {
    instructionDocId: 'sop.media.open-source-spotlight.adding-timecodes-for-open-source-spotlight-videos',
    instructionStepId: '1',
    systems: ['youtube', 'google-docs'],
  },
  'ask-authors-review-codes': {
    instructionDocId: 'template.media.open-source-spotlight.oss-asking-for-revisions-and-links',
    systems: ['email', 'youtube', 'github'],
  },
  'schedule-youtube-video': {
    instructionDocId: 'sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos',
    instructionStepId: '1',
    systems: ['youtube'],
  },
  'tell-author-publish-date': {
    instructionDocId: 'template.media.open-source-spotlight.oss-asking-for-revisions-and-links',
    systems: ['email', 'youtube'],
  },
  'add-to-oss-playlist': {
    instructionDocId: 'sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos',
    instructionStepId: '2',
    systems: ['youtube'],
  },
  'ask-guest-share-recording': {
    instructionDocId: 'template.media.open-source-spotlight.oss-ask-the-guests-to-share-the-videos-with-their-networks',
    systems: ['email', 'linkedin', 'twitter'],
  },
  'schedule-social-media': {
    instructionDocId: 'reference.social-media.post-oss',
    systems: ['linkedin', 'twitter', 'hootsuite', 'youtube'],
  },
};

const OSS_WAITING_TASKS: Record<string, string> = {
  'reach-out-github-authors': 'author, maintainer, or project community reply',
  'reach-out-tool-author': 'author reply or working contact path',
  'find-time-calendly': 'author date confirmation',
  'schedule-recording': 'recording/calendar confirmation',
  'record-demo': 'Alexey or author recording handoff',
  'ask-authors-review-codes': 'author review, cut requests, or missing project links',
  'ask-guest-share-recording': 'guest share confirmation or OSS author recommendations',
};

const OSS_AT_RISK_BY_REF: Record<string, string[]> = {
  'reach-out-github-authors': ['missing Tool GitHub link', 'no maintainer contact path', 'no outreach note'],
  'reach-out-tool-author': ['missing Guest email/contact link', 'author reply not captured'],
  'find-time-calendly': ['no confirmed or proposed recording time'],
  'schedule-recording': ['missing recording/calendar status'],
  'record-demo': ['missing recording source or owner handoff note'],
  'download-upload-youtube': ['missing Recording source link', 'missing YouTube draft link'],
  'editing-video': ['edit not reviewed or no edit status'],
  'add-timecodes-youtube': ['timecodes or description links not confirmed'],
  'ask-authors-review-codes': ['author review pending', 'author links missing'],
  'schedule-youtube-video': ['missing YouTube link', 'video not scheduled for anchor date/time'],
  'tell-author-publish-date': ['author publication notice not sent'],
  'add-to-oss-playlist': ['playlist status not confirmed'],
  'ask-guest-share-recording': ['guest share/recommendation follow-up still pending'],
  'schedule-social-media': ['missing social announcement proof', 'waiting follow-up still open'],
};

const BOOK_OF_THE_WEEK_PHASES: WorkflowPhase[] = [
  { id: 'author-outreach', name: 'Author outreach and date confirmation', stage: 'preparation' },
  { id: 'book-and-page-setup', name: 'Book, author, and public page setup', stage: 'preparation' },
  { id: 'pre-event-promotion', name: 'Newsletter and pre-event promotion', stage: 'preparation' },
  { id: 'event-week', name: 'Event week announcements and Q&A', stage: 'announced' },
  { id: 'giveaway-closeout', name: 'Winner selection and publisher handoff', stage: 'after-event' },
];

const BOOK_OF_THE_WEEK_REQUIRED_BUNDLE_LINKS = [
  'Author email',
  'Publisher or sponsor contact',
  'Book or publisher source link',
  'Website link',
  'LinkedIn announcement',
  'X announcement',
  'Slack announcement',
  'Author share proof',
  'Winner announcement',
  'Winner email handoff',
];

const BOOK_OF_THE_WEEK_SOURCE_DOC_IDS = [
  'task-template.tasks.book-of-the-week',
  'reference.overview.events-slack-book-of-the-week',
  'reference.social-media.posts-book-of-the-week',
  'sop.community.book-of-the-week.reach-out-to-book-authors',
  'sop.community.book-of-the-week.have-a-first-contact-with-the-author',
  'sop.community.book-of-the-week.change-the-status-to-confirmed',
  'sop.community.book-of-the-week.add-books-to-the-airtable-form',
  'sop.community.book-of-the-week.adding-an-author-to-book-of-the-week-pages',
  'sop.community.book-of-the-week.determining-the-publisher-of-a-book',
  'sop.community.book-of-the-week.add-links-and-edit-description',
  'sop.community.book-of-the-week.adding-book-covers',
  'sop.community.book-of-the-week.announce-book-of-the-week-announcement-on-linkedin',
  'sop.community.book-of-the-week.ask-book-authors-to-share-their-the-event-page',
  'sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form',
  'sop.community.book-of-the-week.schedule-the-announcement-in-slack',
  'sop.community.book-of-the-week.announce-the-book-of-the-week-event',
  'sop.community.book-of-the-week.select-book-of-the-week-winners',
  'sop.community.book-of-the-week.send-winners-emails',
  'template.community.book-of-the-week.book-of-the-week-reaching-out-to-authors',
  'template.community.book-of-the-week.book-of-the-week-remind-the-guest-about-the-event-template',
  'template.community.book-of-the-week.asking-books-authors-to-share-their-event-page',
  'template.community.book-of-the-week.book-of-the-week-linkedin-announcement-a-week-before-the-event',
  'template.community.book-of-the-week.book-of-the-week-linkedin-announcement',
  'template.community.book-of-the-week.book-of-the-week-announcement-template',
  'template.community.book-of-the-week.announce-the-book-of-the-week-winners-in-slack',
  'template.community.book-of-the-week.selecting-book-of-the-week-winners-template',
  'template.community.book-of-the-week.sending-book-of-the-week-winners-to-the-publisher-and-author-via-email-templateent',
  'sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block',
];

const BOOK_OF_THE_WEEK_PHASE_BY_REF: Record<string, string> = {
  'reach-out-to-book-authors': 'author-outreach',
  'agree-on-a-date': 'author-outreach',
  'change-status-confirmed': 'author-outreach',
  'fill-airtable-form-author': 'book-and-page-setup',
  'fill-airtable-form-book': 'book-and-page-setup',
  'create-web-page': 'book-and-page-setup',
  'fill-newsletter-announcement': 'pre-event-promotion',
  'announce-event-linkedin': 'pre-event-promotion',
  'remind-author-about-event': 'pre-event-promotion',
  'ask-authors-share-event': 'pre-event-promotion',
  'announce-book-event-linkedin': 'event-week',
  'comment-from-alexey-linkedin': 'event-week',
  'announce-book-event-twitter': 'event-week',
  'invite-author-to-slack': 'event-week',
  'schedule-announcement-slack': 'event-week',
  'announce-book-slack-channels': 'event-week',
  'authors-answer-questions': 'event-week',
  'select-winners': 'giveaway-closeout',
  'collect-emails-from-winners': 'giveaway-closeout',
  'announce-winners-slack': 'giveaway-closeout',
  'contact-publisher-give-emails': 'giveaway-closeout',
};

const BOOK_OF_THE_WEEK_PHASE_SYSTEMS: Record<string, string[]> = {
  'author-outreach': ['email', 'linkedin', 'google-sheets'],
  'book-and-page-setup': ['airtable', 'website', 'github', 'google-sheets'],
  'pre-event-promotion': ['mailchimp', 'linkedin', 'email', 'website'],
  'event-week': ['linkedin', 'twitter', 'slack', 'airtable', 'website'],
  'giveaway-closeout': ['slack', 'email', 'google-sheets', 'random.org'],
};

const BOOK_OF_THE_WEEK_DOC_CONTEXT: Record<string, Pick<TaskDefinition, 'instructionDocId' | 'instructionStepId' | 'systems'>> = {
  'reach-out-to-book-authors': {
    instructionDocId: 'template.community.book-of-the-week.book-of-the-week-reaching-out-to-authors',
    systems: ['email', 'linkedin'],
  },
  'agree-on-a-date': {
    instructionDocId: 'sop.community.book-of-the-week.have-a-first-contact-with-the-author',
    instructionStepId: '1',
    systems: ['email', 'google-sheets'],
  },
  'change-status-confirmed': {
    instructionDocId: 'sop.community.book-of-the-week.change-the-status-to-confirmed',
    instructionStepId: '1',
    systems: ['google-sheets'],
  },
  'fill-airtable-form-author': {
    instructionDocId: 'sop.community.book-of-the-week.adding-an-author-to-book-of-the-week-pages',
    instructionStepId: '1',
    systems: ['airtable', 'website'],
  },
  'fill-airtable-form-book': {
    instructionDocId: 'sop.community.book-of-the-week.add-books-to-the-airtable-form',
    instructionStepId: '1',
    systems: ['airtable', 'website', 'google-sheets'],
  },
  'create-web-page': {
    instructionDocId: 'sop.community.book-of-the-week.add-links-and-edit-description',
    instructionStepId: '1',
    systems: ['website', 'github', 'airtable'],
  },
  'fill-newsletter-announcement': {
    instructionDocId: 'sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block',
    systems: ['mailchimp', 'website'],
  },
  'announce-event-linkedin': {
    instructionDocId: 'template.community.book-of-the-week.book-of-the-week-linkedin-announcement-a-week-before-the-event',
    systems: ['linkedin', 'hootsuite', 'website'],
  },
  'remind-author-about-event': {
    instructionDocId: 'template.community.book-of-the-week.book-of-the-week-remind-the-guest-about-the-event-template',
    systems: ['email', 'slack', 'website'],
  },
  'ask-authors-share-event': {
    instructionDocId: 'template.community.book-of-the-week.asking-books-authors-to-share-their-event-page',
    systems: ['email', 'linkedin', 'twitter', 'website'],
  },
  'announce-book-event-linkedin': {
    instructionDocId: 'template.community.book-of-the-week.book-of-the-week-linkedin-announcement',
    systems: ['linkedin', 'website'],
  },
  'comment-from-alexey-linkedin': {
    instructionDocId: 'template.community.book-of-the-week.book-of-the-week-linkedin-announcement',
    systems: ['linkedin'],
  },
  'announce-book-event-twitter': {
    instructionDocId: 'reference.social-media.posts-book-of-the-week',
    systems: ['twitter', 'website'],
  },
  'invite-author-to-slack': {
    instructionDocId: 'sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form',
    instructionStepId: '1',
    systems: ['slack', 'airtable', 'email'],
  },
  'schedule-announcement-slack': {
    instructionDocId: 'sop.community.book-of-the-week.schedule-the-announcement-in-slack',
    instructionStepId: '1',
    systems: ['slack', 'website'],
  },
  'announce-book-slack-channels': {
    instructionDocId: 'sop.community.book-of-the-week.announce-the-book-of-the-week-event',
    instructionStepId: '1',
    systems: ['slack'],
  },
  'authors-answer-questions': {
    instructionDocId: 'reference.overview.events-slack-book-of-the-week',
    systems: ['slack'],
  },
  'select-winners': {
    instructionDocId: 'sop.community.book-of-the-week.select-book-of-the-week-winners',
    instructionStepId: '1',
    systems: ['slack', 'random.org', 'google-sheets'],
  },
  'collect-emails-from-winners': {
    instructionDocId: 'sop.community.book-of-the-week.select-book-of-the-week-winners',
    instructionStepId: '6',
    systems: ['slack', 'google-sheets', 'email'],
  },
  'announce-winners-slack': {
    instructionDocId: 'template.community.book-of-the-week.announce-the-book-of-the-week-winners-in-slack',
    systems: ['slack'],
  },
  'contact-publisher-give-emails': {
    instructionDocId: 'template.community.book-of-the-week.sending-book-of-the-week-winners-to-the-publisher-and-author-via-email-templateent',
    systems: ['email', 'google-sheets'],
  },
};

const BOOK_OF_THE_WEEK_WAITING_TASKS: Record<string, { waitingFor: string; followUpDefaultDays: number; note: string }> = {
  'reach-out-to-book-authors': {
    waitingFor: 'author reply',
    followUpDefaultDays: 3,
    note: 'If no reply, mark waiting for the author and set followUpAt three business days after outreach.',
  },
  'agree-on-a-date': {
    waitingFor: 'author date confirmation',
    followUpDefaultDays: 1,
    note: 'If the Monday-Friday event week is not confirmed, keep the task waiting for the author and follow up the next business day.',
  },
  'remind-author-about-event': {
    waitingFor: 'author Slack invite acceptance',
    followUpDefaultDays: 1,
    note: 'If the author has not accepted the Slack invite, wait on the author and follow up before event week starts.',
  },
  'ask-authors-share-event': {
    waitingFor: 'author share confirmation or public share link',
    followUpDefaultDays: 2,
    note: 'If the author does not share the page, record the ask, mark waiting, and follow up before Monday announcement.',
  },
  'invite-author-to-slack': {
    waitingFor: 'author Slack join confirmation',
    followUpDefaultDays: 1,
    note: 'If the author has not joined Slack, keep waiting for author acceptance and follow up the same or next business day.',
  },
  'authors-answer-questions': {
    waitingFor: 'author Q&A activity in Slack',
    followUpDefaultDays: 1,
    note: 'If the author is inactive during Q&A, mark waiting for author activity and follow up in Slack or email.',
  },
  'collect-emails-from-winners': {
    waitingFor: 'winner email replies',
    followUpDefaultDays: 1,
    note: 'If emails are missing, wait on the winners and follow up Tuesday or Wednesday before handoff.',
  },
  'contact-publisher-give-emails': {
    waitingFor: 'publisher or author fulfillment confirmation',
    followUpDefaultDays: 2,
    note: 'If handoff is not acknowledged, wait on the fulfillment contact and follow up with the sent email thread.',
  },
};

const BOOK_OF_THE_WEEK_HUMAN_ACCEPTANCE_NOTES: Record<string, string> = {
  'fill-airtable-form-author': '[HUMAN] Airtable submission uses an external account; accept with Airtable submission confirmation and captured author email.',
  'fill-airtable-form-book': '[HUMAN] Airtable submission uses an external account; accept with Airtable submission confirmation and book/publisher source captured.',
  'create-web-page': '[HUMAN] Website publication uses the production website; accept only after the public page URL is captured.',
  'announce-event-linkedin': '[HUMAN] LinkedIn publication or scheduling uses a DTC external account; accept with scheduled-post or public post proof.',
  'announce-book-event-linkedin': '[HUMAN] LinkedIn publication uses a DTC external account; accept with the public announcement URL.',
  'comment-from-alexey-linkedin': "[HUMAN] Alexey's LinkedIn account action must be performed by Alexey; accept with a comment note or public proof.",
  'schedule-announcement-slack': '[HUMAN] Slack scheduling uses a community workspace account; accept with scheduling confirmation.',
  'announce-book-slack-channels': '[HUMAN] Slack posting uses the community workspace; accept with the Slack announcement proof link.',
  'announce-winners-slack': '[HUMAN] Slack posting uses the community workspace; accept with the winner announcement proof link.',
  'contact-publisher-give-emails': '[HUMAN] Publisher or author email handoff uses external email; accept with the sent thread or handoff URL.',
};

const BOOK_OF_THE_WEEK_AT_RISK_BY_REF: Record<string, string[]> = {
  'reach-out-to-book-authors': ['no author contact path', 'no book source link'],
  'agree-on-a-date': ['event week not confirmed', 'anchor Monday unclear'],
  'change-status-confirmed': ['schedule spreadsheet status not confirmed'],
  'fill-airtable-form-author': ['missing author email'],
  'fill-airtable-form-book': ['missing book or publisher source link', 'missing book cover or description source'],
  'create-web-page': ['missing website link', 'website page not public'],
  'fill-newsletter-announcement': ['missing website link', 'newsletter block not prepared'],
  'announce-event-linkedin': ['missing LinkedIn announcement proof'],
  'ask-authors-share-event': ['author share proof missing or waiting'],
  'announce-book-event-linkedin': ['missing LinkedIn announcement proof'],
  'announce-book-event-twitter': ['missing X announcement proof'],
  'invite-author-to-slack': ['author not in Slack'],
  'schedule-announcement-slack': ['Slack announcement not scheduled'],
  'announce-book-slack-channels': ['missing Slack announcement proof'],
  'authors-answer-questions': ['author inactive in Slack Q&A'],
  'select-winners': ['winners not selected'],
  'collect-emails-from-winners': ['winner emails missing'],
  'announce-winners-slack': ['missing winner announcement proof'],
  'contact-publisher-give-emails': ['missing winner email handoff proof', 'publisher or author contact missing'],
};

function withBookOfTheWeekTaskSemantics(tasks: TaskDefinition[]): TaskDefinition[] {
  return tasks.map((task) => {
    const phase = BOOK_OF_THE_WEEK_PHASE_BY_REF[task.refId];
    const docContext = BOOK_OF_THE_WEEK_DOC_CONTEXT[task.refId] || {};
    const proofRequirement = bookOfTheWeekProofRequirement(task);
    const waiting = BOOK_OF_THE_WEEK_WAITING_TASKS[task.refId];
    const requiredBundleLinks = bookOfTheWeekRequiredBundleLinks(task);
    const validation: Record<string, unknown> = {
      operatorAction: task.description,
      completionProof: proofRequirement.required === false ? 'No proof required beyond task completion' : proofRequirement.label,
      requiredBundleLinks,
      reminderSemantics: {
        due: true,
        overdue: true,
        missingEvidence: proofRequirement.required !== false,
        waitingFollowUp: Boolean(waiting),
        eventWeek: phase === 'event-week',
        postEventFollowUp: phase === 'giveaway-closeout',
      },
      contextRequired: ['book title', 'book author', 'publisher or sponsor fulfillment contact', 'Monday event-week anchor date'],
      atRiskWhen: BOOK_OF_THE_WEEK_AT_RISK_BY_REF[task.refId] || [],
      dashboardStates: ['today', 'overdue', 'waiting', 'follow-up-due', 'missing-evidence', 'at-risk'],
      ...(typeof task.validation === 'object' && task.validation !== null ? task.validation : {}),
    };

    if (waiting) {
      validation.waitingSemantics = {
        waitingFor: waiting.waitingFor,
        requires: ['waitingFor', 'followUpAt', 'comment'],
        followUpDefaultDays: waiting.followUpDefaultDays,
        guidance: waiting.note,
      };
    }
    const humanAcceptanceNote = BOOK_OF_THE_WEEK_HUMAN_ACCEPTANCE_NOTES[task.refId];
    if (humanAcceptanceNote) {
      validation.acceptanceNote = humanAcceptanceNote;
    }

    return {
      ...task,
      ...docContext,
      phase,
      systems: docContext.systems || task.systems || BOOK_OF_THE_WEEK_PHASE_SYSTEMS[phase] || ['dataops'],
      proofRequirement,
      validation,
    };
  });
}

function bookOfTheWeekProofRequirement(task: TaskDefinition): ProofRequirement {
  if (task.requiredLinkName) {
    return { type: 'url', label: task.requiredLinkName, required: true };
  }
  if (task.refId === 'change-status-confirmed') {
    return { type: 'external-status', label: 'Schedule spreadsheet status is confirmed', required: true };
  }
  if (task.refId === 'fill-airtable-form-author') {
    return { type: 'external-status', label: 'Author/person Airtable form submitted and author email captured', required: true };
  }
  if (task.refId === 'fill-airtable-form-book') {
    return { type: 'external-status', label: 'Book Airtable form submitted with book, publisher, cover, and description source', required: true };
  }
  if (task.refId === 'schedule-announcement-slack') {
    return { type: 'external-status', label: 'Slack announcement scheduled with cover and copied template', required: true };
  }
  if (task.refId === 'authors-answer-questions') {
    return { type: 'external-status', label: 'Author Q&A activity monitored in Slack', required: true };
  }
  if (task.refId === 'select-winners') {
    return { type: 'external-status', label: 'Winners selected by author or randomizer', required: true };
  }
  if (task.refId === 'collect-emails-from-winners') {
    return { type: 'external-status', label: 'Winner emails collected or waiting follow-up recorded', required: true };
  }
  if (
    task.refId === 'reach-out-to-book-authors'
    || task.refId === 'agree-on-a-date'
    || task.refId === 'remind-author-about-event'
    || task.refId === 'ask-authors-share-event'
    || task.refId === 'comment-from-alexey-linkedin'
    || task.refId === 'invite-author-to-slack'
    || task.refId === 'fill-newsletter-announcement'
  ) {
    return { type: 'comment', label: `${task.description} confirmed`, required: true };
  }
  if (task.isMilestone || task.stageOnComplete) {
    return { type: 'comment', label: `${task.description} confirmed`, required: true };
  }
  return { type: 'comment', label: 'Manual completion confirmation', required: false };
}

function bookOfTheWeekRequiredBundleLinks(task: TaskDefinition): string[] {
  if (task.requiredLinkName) {
    return [task.requiredLinkName];
  }
  const requiredLinksByRef: Record<string, string[]> = {
    'reach-out-to-book-authors': ['Author email', 'Book or publisher source link'],
    'agree-on-a-date': ['Author email'],
    'change-status-confirmed': ['Author email', 'Book or publisher source link'],
    'fill-airtable-form-author': ['Author email'],
    'fill-airtable-form-book': ['Book or publisher source link'],
    'fill-newsletter-announcement': ['Website link'],
    'remind-author-about-event': ['Author email', 'Website link'],
    'ask-authors-share-event': ['Website link'],
    'invite-author-to-slack': ['Author email'],
    'schedule-announcement-slack': ['Website link'],
    'authors-answer-questions': ['Slack announcement'],
    'select-winners': ['Slack announcement'],
    'collect-emails-from-winners': ['Winner announcement'],
    'contact-publisher-give-emails': ['Publisher or sponsor contact', 'Winner email handoff'],
  };
  return requiredLinksByRef[task.refId] || [];
}

function withPodcastTaskSemantics(tasks: TaskDefinition[]): TaskDefinition[] {
  return tasks.map((task) => {
    const phase = PODCAST_PHASE_BY_REF[task.refId];
    const docContext = PODCAST_DOC_CONTEXT[task.refId] || {};
    const proofRequirement = podcastProofRequirement(task);
    const waitingFor = PODCAST_WAITING_TASKS[task.refId];
    const requiredBundleLinks = task.refId === 'schedule-podcast-spotify'
      ? ['Spotify for Podcasters', 'Public Spotify episode', 'Apple Podcasts episode']
      : task.requiredLinkName
        ? [task.requiredLinkName]
        : [];
    const validation: Record<string, unknown> = {
      operatorAction: task.description,
      completionProof: proofRequirement.required === false ? 'No proof required beyond task completion' : proofRequirement.label,
      requiredBundleLinks,
      reminderSemantics: {
        due: true,
        overdue: true,
        missingEvidence: proofRequirement.required !== false,
        waitingFollowUp: Boolean(waitingFor),
        preEventReminder: task.refId === 'remind-guest-7d' || task.refId === 'remind-guest-1d',
        postEventFollowUp: task.offsetDays > 0,
      },
      atRiskWhen: PODCAST_AT_RISK_BY_REF[task.refId] || [],
      dashboardStates: ['today', 'overdue', 'waiting', 'follow-up-due', 'missing-evidence', 'at-risk'],
      ...(typeof task.validation === 'object' && task.validation !== null ? task.validation : {}),
    };
    const skipClosure = newsletterSkipClosure(task.refId);
    if (skipClosure) {
      validation.skipClosure = skipClosure;
    }
    if (waitingFor) {
      validation.waitingSemantics = {
        waitingFor,
        requires: ['waitingFor', 'followUpAt', 'comment'],
        followUpDefaultDays: task.offsetDays < 0 ? 2 : 1,
      };
    }

    return {
      ...task,
      ...docContext,
      phase,
      systems: docContext.systems || task.systems || PODCAST_PHASE_SYSTEMS[phase] || ['dataops'],
      proofRequirement,
      validation,
      ...(task.refId === 'create-podcast-document'
        ? {
            artifactRefs: [
              {
                artifactId: 'artifact.dataops-podcast-draft',
                type: 'podcast-prep-draft',
                title: 'DataOps podcast assistant draft',
                status: 'planned',
              },
            ],
            assistantJobRefs: [
              {
                assistantJobId: 'assistant-job.podcast-prep-draft',
                assistantType: 'podcast',
                status: 'planned',
              },
            ],
          }
        : {}),
    };
  });
}

function withTaxReportTaskSemantics(tasks: TaskDefinition[]): TaskDefinition[] {
  return tasks.map((task) => {
    const phase = TAX_REPORT_PHASE_BY_REF[task.refId];
    const docContext = TAX_REPORT_DOC_CONTEXT[task.refId] || {};
    const proofRequirement = taxReportProofRequirement(task);
    const waitingFor = TAX_REPORT_WAITING_TASKS[task.refId];
    const requiredBundleLinks = taxReportRequiredBundleLinks(task);
    const validation: Record<string, unknown> = {
      operatorAction: task.description,
      completionProof: proofRequirement.required === false ? 'No proof required beyond task completion' : proofRequirement.label,
      requiredBundleLinks,
      reminderSemantics: {
        due: true,
        overdue: true,
        missingEvidence: proofRequirement.required !== false || requiredBundleLinks.length > 0 || task.requiresFile === true,
        waitingFollowUp: Boolean(waitingFor),
        followUpNotificationType: 'follow-up-due',
        monthlySequentialDueDate: true,
      },
      atRiskWhen: TAX_REPORT_AT_RISK_BY_REF[task.refId] || [],
      dashboardStates: ['today', 'overdue', 'waiting', 'follow-up-due', 'missing-evidence', 'at-risk'],
      dataSafety: {
        noSensitiveFilesInGit: true,
        noAccountantUploadSecretsInGit: true,
        proofStoredAtRuntime: true,
        portableExportRestoreRequired: true,
      },
      ...(typeof task.validation === 'object' && task.validation !== null ? task.validation : {}),
    };
    const skipClosure = taxReportSkipClosure(task.refId);
    if (skipClosure) {
      validation.skipClosure = skipClosure;
    }
    if (waitingFor) {
      validation.waitingSemantics = {
        waitingFor,
        requires: ['waitingFor', 'followUpAt', 'comment'],
        followUpDefaultDays: task.refId === 'notify-accountants' ? 2 : 1,
      };
    }

    return {
      ...task,
      ...docContext,
      phase,
      systems: docContext.systems || task.systems || TAX_REPORT_PHASE_SYSTEMS[phase] || ['dataops'],
      proofRequirement,
      validation,
    };
  });
}

function taxReportProofRequirement(task: TaskDefinition): ProofRequirement {
  if (task.requiredLinkName) {
    return { type: 'url', label: task.requiredLinkName, required: true };
  }
  if (task.requiresFile) {
    const labels: Record<string, string> = {
      'create-bank-statements-finom': 'Finom monthly statement file',
      'create-bank-statements-revolut': 'Revolut monthly statement file',
      'prepare-zip-send-accounting': 'Tax ZIP file',
    };
    return { type: 'file', label: labels[task.refId] || 'Required finance file', required: true };
  }
  if (task.refId === 'review-update-todos') {
    return { type: 'external-status', label: 'No reportable transaction has unresolved TODO values; missing documents are listed', required: true };
  }
  if (task.refId === 'convert-currencies') {
    return { type: 'comment', label: 'Conversion source/date or linked conversion evidence recorded', required: true };
  }
  if (task.refId === 'cross-check-revolut-finom') {
    return { type: 'external-status', label: 'Finom/Revolut counts and monthly report rows reconciled', required: true };
  }
  if (task.refId === 'organize-invoices-folders') {
    return { type: 'external-status', label: 'Processed folders organized and monthly workflow closure criteria met', required: true };
  }
  return { type: 'comment', label: 'Manual completion confirmation', required: false };
}

function taxReportRequiredBundleLinks(task: TaskDefinition): string[] {
  if (task.requiredLinkName) {
    return [task.requiredLinkName];
  }
  if (task.refId === 'organize-invoices-folders') {
    return TAX_REPORT_REQUIRED_BUNDLE_LINKS;
  }
  return [];
}

function taxReportSkipClosure(refId: string): Record<string, unknown> | undefined {
  if (refId !== 'open-bookkeeping-report') return undefined;
  return {
    allowedStatuses: ['fixed monthly spreadsheet reused'],
    requires: ['comment'],
    auditNote: 'Use only when the standing bookkeeping spreadsheet is the report source and the operator records the month/range in the comment.',
    suppresses: {
      'fixed monthly spreadsheet reused': {
        bundleLinks: ['Monthly report/spreadsheet'],
        requiredLink: true,
        proof: true,
      },
    },
  };
}

function podcastProofRequirement(task: TaskDefinition): ProofRequirement {
  if (task.requiredLinkName) {
    return { type: 'url', label: task.requiredLinkName, required: true };
  }
  if (task.requiresFile) {
    return { type: 'file', label: task.refId === 'create-banner-figma' ? 'Podcast banner or cover' : 'Required file', required: true };
  }
  if (task.refId === 'create-podcast-document') {
    return { type: 'artifact', label: 'Accepted DataOps podcast assistant draft or podcast document link', required: true };
  }
  if (task.refId === 'recheck-video-edit') {
    return { type: 'external-status', label: 'Edited YouTube video verified', required: true };
  }
  if (task.refId === 'schedule-podcast-spotify') {
    return { type: 'external-status', label: 'Spotify and Apple Podcasts publication links captured', required: true };
  }
  if (task.isMilestone || task.stageOnComplete) {
    return { type: 'comment', label: `${task.description} confirmed`, required: true };
  }
  return { type: 'comment', label: 'Manual completion confirmation', required: false };
}

function withNewsletterTaskSemantics(tasks: TaskDefinition[]): TaskDefinition[] {
  return tasks.map((task) => {
    const phase = NEWSLETTER_PHASE_BY_REF[task.refId];
    const docContext = NEWSLETTER_DOC_CONTEXT[task.refId] || {};
    const proofRequirement = newsletterProofRequirement(task);
    const waitingFor = NEWSLETTER_WAITING_TASKS[task.refId];
    const requiredBundleLinks = newsletterRequiredBundleLinks(task);
    const validation: Record<string, unknown> = {
      operatorAction: task.description,
      completionProof: proofRequirement.required === false ? 'No proof required beyond task completion' : proofRequirement.label,
      requiredBundleLinks,
      reminderSemantics: {
        due: true,
        overdue: true,
        missingEvidence: proofRequirement.required !== false,
        waitingFollowUp: Boolean(waitingFor),
        sponsorFollowUp: task.refId === 'email-sponsor' || task.refId === 'fill-sponsored-block',
        postPublicationFollowUp: task.offsetDays > 0,
      },
      atRiskWhen: NEWSLETTER_AT_RISK_BY_REF[task.refId] || [],
      dashboardStates: ['today', 'overdue', 'waiting', 'follow-up-due', 'missing-evidence', 'at-risk'],
      ...(typeof task.validation === 'object' && task.validation !== null ? task.validation : {}),
    };
    const skipClosure = newsletterSkipClosure(task.refId);
    if (skipClosure) {
      validation.skipClosure = skipClosure;
    }
    if (waitingFor) {
      validation.waitingSemantics = {
        waitingFor,
        requires: ['waitingFor', 'followUpAt', 'comment'],
        followUpDefaultDays: task.offsetDays < 0 ? 2 : 1,
      };
    }

    return {
      ...task,
      ...docContext,
      phase,
      systems: docContext.systems || task.systems || NEWSLETTER_PHASE_SYSTEMS[phase] || ['dataops'],
      proofRequirement,
      validation,
    };
  });
}

function newsletterSkipClosure(refId: string): Record<string, unknown> | undefined {
  const skipStatuses: Record<string, string[]> = {
    'create-sponsorship-document': ['not sponsored this week'],
    'email-sponsor': ['not sponsored this week'],
    'fill-sponsored-block': ['not sponsored this week'],
    'fill-book-of-the-week-block': ['no book this week'],
    'fill-event-block': ['no event block this week'],
    'fill-podcast-block': ['no podcast this week'],
    'fill-article-block': ['no article block this week'],
    'create-invoice': ['not sponsored this week'],
    'send-email-sponsor-publication-live': ['not sponsored this week'],
    'schedule-sponsorship-linkedin': ['not sponsored this week'],
    'schedule-sponsorship-twitter': ['not sponsored this week'],
    'add-newsletter-performance': ['not sponsored this week', 'no social stats available'],
    'send-performance-to-sponsor': ['not sponsored this week'],
  };
  const statuses = skipStatuses[refId];
  if (!statuses) return undefined;
  const skipClosure: Record<string, unknown> = {
    allowedStatuses: statuses,
    requires: ['comment'],
    auditNote: 'Use one of these exact notes when the weekly issue has no sponsor or the content block is intentionally skipped.',
  };
  if (refId === 'add-newsletter-performance') {
    skipClosure.suppresses = {
      'not sponsored this week': { bundleLinks: ['LinkedIn', 'X'], proof: true },
      'no social stats available': { bundleLinks: ['LinkedIn', 'X'], proof: true },
    };
  }
  if (refId === 'send-performance-to-sponsor') {
    skipClosure.suppresses = {
      'not sponsored this week': { bundleLinks: ['*'], proof: true },
    };
  }
  return skipClosure;
}

function newsletterProofRequirement(task: TaskDefinition): ProofRequirement {
  if (task.requiredLinkName) {
    return { type: 'url', label: task.requiredLinkName, required: true };
  }
  if (task.requiresFile) {
    return { type: 'file', label: 'Invoice PDF or invoice proof', required: true };
  }
  if (task.refId === 'schedule-email-newsletter') {
    return { type: 'external-status', label: 'Mailchimp campaign scheduled', required: true };
  }
  if (task.refId === 'add-newsletter-performance') {
    return { type: 'external-status', label: 'Newsletter, LinkedIn, and X performance stats recorded', required: true };
  }
  if (task.refId === 'fill-sponsored-block') {
    return { type: 'external-status', label: 'Sponsored block filled or issue confirmed unsponsored', required: true };
  }
  if (
    task.refId === 'email-sponsor'
    || task.refId === 'fill-book-of-the-week-block'
    || task.refId === 'fill-event-block'
    || task.refId === 'fill-podcast-block'
    || task.refId === 'fill-article-block'
    || task.refId === 'send-email-sponsor-publication-live'
    || task.refId === 'send-performance-to-sponsor'
  ) {
    return { type: 'comment', label: `${task.description} confirmed`, required: true };
  }
  return { type: 'comment', label: 'Manual completion confirmation', required: false };
}

function newsletterRequiredBundleLinks(task: TaskDefinition): string[] {
  if (task.requiredLinkName) {
    return [task.requiredLinkName];
  }
  if (task.refId === 'schedule-email-newsletter' || task.refId === 'send-email-sponsor-publication-live') {
    return ['Mailchimp newsletter'];
  }
  if (task.refId === 'fill-sponsored-block' || task.refId === 'email-sponsor') {
    return ['Sponsorship document'];
  }
  if (task.refId === 'add-newsletter-performance' || task.refId === 'send-performance-to-sponsor') {
    return ['Mailchimp newsletter', 'LinkedIn', 'X'];
  }
  return [];
}

function withOssTaskSemantics(tasks: TaskDefinition[]): TaskDefinition[] {
  return tasks.map((task) => {
    const phase = OSS_PHASE_BY_REF[task.refId];
    const docContext = OSS_DOC_CONTEXT[task.refId] || {};
    const proofRequirement = ossProofRequirement(task);
    const waitingFor = OSS_WAITING_TASKS[task.refId];
    const validation: Record<string, unknown> = {
      operatorAction: task.description,
      completionProof: proofRequirement.required === false ? 'No proof required beyond task completion' : proofRequirement.label,
      requiredBundleLinks: ossRequiredBundleLinks(task),
      reminderSemantics: {
        due: true,
        overdue: true,
        missingEvidence: proofRequirement.required !== false,
        waitingFollowUp: Boolean(waitingFor),
        publicationAnchor: task.offsetDays === 0,
        postPublicationFollowUp: task.offsetDays > 0,
      },
      waitingAllowed: Boolean(waitingFor),
      atRiskWhen: OSS_AT_RISK_BY_REF[task.refId] || [],
      dashboardStates: ['today', 'overdue', 'waiting', 'follow-up-due', 'missing-evidence', 'at-risk'],
      ...(typeof task.validation === 'object' && task.validation !== null ? task.validation : {}),
    };
    if (waitingFor) {
      validation.waitingSemantics = {
        waitingFor,
        requires: ['waitingFor', 'followUpAt', 'comment'],
        followUpDefaultDays: task.offsetDays < 0 ? 2 : 1,
      };
    }
    if (task.refId === 'schedule-social-media') {
      validation.closureSemantics = {
        stageOnComplete: 'done',
        requiresNoOpenWaitingFollowUp: true,
        requiredProof: ['Social announcement'],
      };
    }

    return {
      ...task,
      ...docContext,
      phase,
      systems: docContext.systems || task.systems || OSS_PHASE_SYSTEMS[phase] || ['dataops'],
      proofRequirement,
      validation,
    };
  });
}

function ossProofRequirement(task: TaskDefinition): ProofRequirement {
  if (task.requiredLinkName) {
    return { type: 'url', label: task.requiredLinkName, required: true };
  }
  if (task.refId === 'schedule-recording') {
    return { type: 'external-status', label: 'Recording/calendar details confirmed', required: true };
  }
  if (task.refId === 'record-demo') {
    return { type: 'external-status', label: 'Recording source captured or owner handoff noted', required: true };
  }
  if (task.refId === 'editing-video') {
    return { type: 'external-status', label: 'Video edit reviewed and ready for timecodes', required: true };
  }
  if (task.refId === 'add-timecodes-youtube') {
    return { type: 'external-status', label: 'YouTube timecodes and description links updated', required: true };
  }
  if (task.refId === 'add-to-oss-playlist') {
    return { type: 'external-status', label: 'Open-Source Spotlight playlist status confirmed', required: true };
  }
  if (task.refId === 'ask-authors-review-codes') {
    return { type: 'comment', label: 'Author review request, timecodes, and link request sent', required: true };
  }
  if (task.refId === 'schedule-social-media') {
    return { type: 'url', label: 'Social announcement', required: true };
  }
  if (
    task.refId === 'reach-out-github-authors'
    || task.refId === 'find-time-calendly'
    || task.refId === 'tell-author-publish-date'
    || task.refId === 'ask-guest-share-recording'
    || task.isMilestone
    || task.stageOnComplete
  ) {
    return { type: 'comment', label: `${task.description} confirmed`, required: true };
  }
  return { type: 'comment', label: 'Manual completion confirmation', required: false };
}

function ossRequiredBundleLinks(task: TaskDefinition): string[] {
  const refs: Record<string, string[]> = {
    'reach-out-github-authors': ['Tool GitHub'],
    'reach-out-tool-author': ['Guest email', 'Tool GitHub'],
    'find-time-calendly': ['Guest email'],
    'schedule-recording': ['Guest email'],
    'record-demo': ['Recording source'],
    'download-upload-youtube': ['Recording source', 'YouTube'],
    'editing-video': ['YouTube'],
    'add-timecodes-youtube': ['YouTube'],
    'ask-authors-review-codes': ['YouTube', 'Author review'],
    'schedule-youtube-video': ['YouTube'],
    'tell-author-publish-date': ['YouTube'],
    'add-to-oss-playlist': ['YouTube', 'OSS playlist'],
    'ask-guest-share-recording': ['YouTube'],
    'schedule-social-media': ['YouTube', 'Social announcement'],
  };
  if (refs[task.refId]) {
    return refs[task.refId];
  }
  if (task.requiredLinkName) {
    return [task.requiredLinkName];
  }
  return [];
}

const DEFAULT_TEMPLATES = [
  // 1. Newsletter
  {
    name: 'Newsletter',
    type: 'newsletter',
    emoji: '\u{1F4F0}',
    tags: ['Newsletter'],
    phases: NEWSLETTER_PHASES,
    sourceDocIds: NEWSLETTER_SOURCE_DOC_IDS,
    defaultAssigneeId: GRACE_ID,
    triggerType: 'automatic',
    triggerSchedule: '0 9 * * 1',
    triggerLeadDays: 14,
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Newsletter', url: 'https://docs.google.com/document/d/10sqvW0RqHJ2xQaoJQB0Ce0E21QPPAef5UwWrx0aT2XA/edit' },
    ],
    bundleLinkDefinitions: NEWSLETTER_REQUIRED_BUNDLE_LINKS.map((name) => ({ name })),
    taskDefinitions: withNewsletterTaskSemantics([
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
        stageOnComplete: 'announced',
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
    ]),
  },

  // 2. Book of the Week
  {
    name: 'Book of the Week',
    type: 'book-of-the-week',
    emoji: '\u{1F4DA}',
    tags: ['Book of the Week'],
    phases: BOOK_OF_THE_WEEK_PHASES,
    sourceDocIds: BOOK_OF_THE_WEEK_SOURCE_DOC_IDS,
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Events', url: 'https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit' },
      { name: 'Events (slack) - book of the week', url: 'https://docs.google.com/document/d/1RdxwuKVGRI69phmPbmJbgoO3o8il52LFZhiUu3qaDME/edit' },
    ],
    bundleLinkDefinitions: BOOK_OF_THE_WEEK_REQUIRED_BUNDLE_LINKS.map((name) => ({ name })),
    taskDefinitions: withBookOfTheWeekTaskSemantics([
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
        requiredLinkName: 'LinkedIn announcement',
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
        requiredLinkName: 'LinkedIn announcement',
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
        requiredLinkName: 'X announcement',
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
        requiredLinkName: 'Slack announcement',
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
        requiredLinkName: 'Winner announcement',
      },
      {
        refId: 'contact-publisher-give-emails',
        description: 'Contact the publisher or the authors and give them the emails',
        offsetDays: 7,
        stageOnComplete: 'done',
        instructionsUrl: 'https://docs.google.com/document/d/1szidymIamDfTI0LpkmwlRz7AX0qsRcPEVrcKtaFz_hs/edit',
        requiredLinkName: 'Winner email handoff',
      },
      {
        refId: 'fill-newsletter-announcement',
        description: 'Fill in the newsletter announcement',
        offsetDays: -8,
        assigneeId: VALERIIA_ID,
        instructionsUrl: 'https://docs.google.com/document/d/10y0CCq8ApFbH1Mx7wlh_b_ZudnPib9qk_tDysA99xNg/edit',
      },
    ]),
  },

  // 3. Podcast
  {
    name: 'Podcast',
    type: 'podcast',
    emoji: '\u{1F399}\u{FE0F}',
    tags: ['Podcast'],
    phases: PODCAST_PHASES,
    sourceDocIds: [
      ...PODCAST_SOURCE_DOC_IDS,
      ...PODCAST_EXTERNAL_SOURCE_DOC_IDS.map((doc) => doc.id),
    ],
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Events', url: 'https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit' },
      { name: 'Events (live) - podcast', url: 'https://docs.google.com/document/d/19d_kBOVQJ2p5qZCtGywzWzYeyCv5FWeHApZnEUZIYRg/edit' },
      { name: 'DataOps podcast assistant README', url: 'assistants/podcast/README.md' },
      { name: 'DataOps podcast assistant process', url: 'assistants/podcast/process/podcast.md' },
    ],
    bundleLinkDefinitions: PODCAST_REQUIRED_BUNDLE_LINKS.map((name) => ({ name })),
    taskDefinitions: withPodcastTaskSemantics([
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
        instructionDocId: 'sop.media.podcast.create-podcast-document',
        instructionStepId: '1',
        phase: 'preparation',
        systems: ['github', 'linkedin', 'loom', 'trello', 'twitter'],
        validation: {
          requiredEvidence: 'Podcast document link',
        },
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
        requiredLinkName: 'YouTube stream/video',
      },
      {
        refId: 'upload-recording-dropbox',
        description: 'Upload the recording to the shared folder in dropbox',
        offsetDays: 1,
        assigneeId: ALEXEY_ID,
        requiredLinkName: 'Dropbox recording folder',
      },
      {
        refId: 'update-youtube-cover',
        description: 'Update the cover of the YouTube video',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1pRxR7z_XUey3LVcbjmD4_vCEuH4XxdfhAUAZFoJSlgw/edit',
        requiredLinkName: 'Podcast banner or cover',
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
        requiredLinkName: 'Spotify for Podcasters',
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
        requiredLinkName: 'Public Spotify episode',
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
    ]),
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
    phases: OSS_PHASES,
    sourceDocIds: OSS_SOURCE_DOC_IDS,
    defaultAssigneeId: GRACE_ID,
    triggerType: 'manual',
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Events', url: 'https://docs.google.com/document/d/1SVWxBsBzvG5URX2tWD9M9HRfI11c2eq3Z7TMt0-JHqQ/edit' },
      { name: 'Events (pre-recorded) - Open-Source Spotlight', url: 'https://docs.google.com/document/d/1foX7pya-Ywi153LkZWFWBw2nI6HYvcQKS-QQBEUmGZc/edit' },
    ],
    bundleLinkDefinitions: OSS_REQUIRED_BUNDLE_LINKS.map((name) => ({ name })),
    taskDefinitions: withOssTaskSemantics([
      {
        refId: 'reach-out-github-authors',
        description: 'Identify likely maintainers/contributors and start outreach from GitHub or community context',
        offsetDays: -21,
      },
      {
        refId: 'reach-out-tool-author',
        description: 'Send the OSS invitation to the tool author(s)',
        offsetDays: -20,
        instructionsUrl: 'https://docs.google.com/document/d/1FSJQoMOAZOpiA7EGR2t-xYcu_nEEd2hQSZCC3t5vdq8/edit',
        requiredLinkName: 'Guest email',
      },
      {
        refId: 'find-time-calendly',
        description: "Help the author find a time if Calendly does not work",
        offsetDays: -19,
      },
      {
        refId: 'schedule-recording',
        description: 'Schedule the recording and capture the calendar or recording details',
        offsetDays: -18,
        instructionsUrl: 'https://docs.google.com/document/d/1GsM_Vlit2bB5MCRUH3AQHZWk3xI96ZZEtEvgzb_CMyY/edit',
      },
      {
        refId: 'record-demo',
        description: 'Record the OSS demo',
        offsetDays: -14,
      },
      {
        refId: 'download-upload-youtube',
        description: 'Download the Zoom recording and upload or create the YouTube draft',
        offsetDays: -13,
        instructionsUrl: 'https://docs.google.com/document/d/1LU0G3jlcCf19hYIp-TNfz94tDUrjEBvyPJ3_QuJQNvg/edit',
        requiredLinkName: 'YouTube',
      },
      {
        refId: 'editing-video',
        description: 'Edit/review the video and prepare it for publication',
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
        description: 'Ask the authors to review the generated timecodes/cuts and send required links',
        offsetDays: -10,
        instructionsUrl: 'https://docs.google.com/document/d/1csT9bIvr8WNz3anuS-fO_WrIHvln2P3Hcsh7P0t-lOc/edit',
      },
      {
        refId: 'schedule-youtube-video',
        description: 'Schedule YouTube video for the anchor date/time and verify playlist/schedule state',
        offsetDays: 0,
        isMilestone: true,
        stageOnComplete: 'after-event',
        instructionsUrl: 'https://docs.google.com/document/d/1GsM_Vlit2bB5MCRUH3AQHZWk3xI96ZZEtEvgzb_CMyY/edit',
        requiredLinkName: 'YouTube',
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
        description: 'Ask the guest to share the recording and recommend other OSS authors',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1JJxAnhoVslGXmjc9Fw3JZrUDD6-srJQcMiHP8rPjMsw/edit',
      },
      {
        refId: 'schedule-social-media',
        description: 'Schedule or publish social announcement for the OSS video',
        offsetDays: 2,
        stageOnComplete: 'done',
        instructionsUrl: 'https://docs.google.com/document/d/1BleKsd44Uhhj24D-D5qup0Gf3GcM6cwdAjbZD2jGGuA/edit',
        requiredLinkName: 'Social announcement',
      },
    ]),
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
    phases: TAX_REPORT_PHASES,
    sourceDocIds: TAX_REPORT_SOURCE_DOC_IDS,
    defaultAssigneeId: GRACE_ID,
    triggerType: 'automatic',
    triggerSchedule: '0 9 1 * *',
    triggerLeadDays: 0,
    references: [
      { name: 'Process documents', url: 'https://docs.google.com/document/d/1FEmQV8myR3jN-8_kCG_tQh4jrrxFZJPpRag9iPf_RII/edit' },
      { name: 'Tax reports', url: 'https://docs.google.com/document/d/1fuWlBKFxWfupmRz9442En78xAwyXjYw_9Aspf81lhv8/edit' },
    ],
    bundleLinkDefinitions: TAX_REPORT_REQUIRED_BUNDLE_LINKS.map((name) => ({ name })),
    taskDefinitions: withTaxReportTaskSemantics([
      {
        refId: 'open-bookkeeping-report',
        description: 'Open the monthly bookkeeping/tax report and attach the month-specific report or spreadsheet link',
        offsetDays: 0,
        instructionsUrl: 'https://docs.google.com/document/d/1fuWlBKFxWfupmRz9442En78xAwyXjYw_9Aspf81lhv8/edit',
        requiredLinkName: 'Monthly report/spreadsheet',
      },
      {
        refId: 'review-update-todos',
        description: 'Review Dropbox documents, receipts, invoices, and spreadsheet rows; replace TODO values with actual numbers',
        offsetDays: 1,
        instructionsUrl: 'https://docs.google.com/document/d/1O9TVl2Q2tTDDFaiZro0XTYXpB8i1r9Q6Ryp-dshGFbQ/edit',
      },
      {
        refId: 'convert-currencies',
        description: 'Convert USD or other non-EUR transactions to EUR using Wise/Revolut evidence and update the spreadsheet',
        offsetDays: 2,
        instructionsUrl: 'https://docs.google.com/document/d/1WWhBApSyw2JsvkVL6WdmYYRcd9ETf58D5SmN2JnJCXo/edit',
      },
      {
        refId: 'create-bank-statements-finom',
        description: 'Download/create the Finom bank statement for the month',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU/edit',
        requiresFile: true,
      },
      {
        refId: 'create-bank-statements-revolut',
        description: 'Download/create the Revolut bank statement for the month',
        offsetDays: 3,
        instructionsUrl: 'https://docs.google.com/document/d/1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q/edit',
        requiresFile: true,
      },
      {
        refId: 'cross-check-revolut-finom',
        description: 'Cross-check Finom and Revolut transactions against the bookkeeping spreadsheet and add missing income/expenses',
        offsetDays: 4,
        instructionsUrl: 'https://docs.google.com/document/d/1Uh6ZQwQ2wBV2S7WZVnph_SauyPQQTQsym5zrrX94vHg/edit',
      },
      {
        refId: 'prepare-zip-send-accounting',
        description: 'Prepare the datatalksclub-YYYY-MM.zip tax package and upload it to the accountant handoff destination',
        offsetDays: 5,
        instructionsUrl: 'https://docs.google.com/document/d/1__AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit',
        requiresFile: true,
        requiredLinkName: 'Accountant upload/share link',
      },
      {
        refId: 'notify-accountants',
        description: 'Send the accountant email with the monthly report summary and uploaded package reference, cc Alexey',
        offsetDays: 6,
        instructionsUrl: 'https://docs.google.com/document/d/1AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit',
        requiredLinkName: 'Accountant email thread',
      },
      {
        refId: 'organize-invoices-folders',
        description: 'Move processed expense and incoming invoice files into the correct processed folders and close the monthly workflow',
        offsetDays: 7,
        instructionsUrl: 'https://docs.google.com/document/d/1__AYDWyzYiMzByGcWfdNq9wIWeCXy71Q7YHxq_LWmSs/edit',
        stageOnComplete: 'done',
      },
    ]),
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

export {
  seed,
  DEFAULT_TEMPLATES,
  NEWSLETTER_SOURCE_DOC_IDS,
  BOOK_OF_THE_WEEK_SOURCE_DOC_IDS,
  PODCAST_SOURCE_DOC_IDS,
  PODCAST_EXTERNAL_SOURCE_DOC_IDS,
  TAX_REPORT_SOURCE_DOC_IDS,
  OSS_SOURCE_DOC_IDS,
};
