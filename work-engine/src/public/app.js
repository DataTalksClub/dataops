(function () {
  'use strict';

  var TOKEN_KEY = 'dataops_token';
  var USER_KEY = 'dataops_user';
  var LEGACY_TOKEN_KEY = 'datatasks_token';
  var LEGACY_USER_KEY = 'datatasks_user';

  var app = document.getElementById('app');
  var nav = document.querySelector('nav');

  // ── Auth helpers ─────────────────────────────────────────────────

  function getItemWithLegacyFallback(key, legacyKey) {
    var value = localStorage.getItem(key);
    if (value !== null) return value;

    var legacyValue = localStorage.getItem(legacyKey);
    if (legacyValue !== null) {
      localStorage.setItem(key, legacyValue);
    }
    return legacyValue;
  }

  function getStoredUser() {
    try {
      var raw = getItemWithLegacyFallback(USER_KEY, LEGACY_USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function getStoredToken() {
    return getItemWithLegacyFallback(TOKEN_KEY, LEGACY_TOKEN_KEY);
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_USER_KEY);
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_USER_KEY);
    usersCache = null;
    bundlesCache = null;
  }

  // ── Sign-in form ────────────────────────────────────────────────

  function renderSignIn() {
    // Hide nav links (keep only brand visible)
    var navLinks = nav.querySelectorAll('.nav-link, #signout-btn, #nav-menu-toggle');
    navLinks.forEach(function (el) {
      el.style.display = 'none';
    });
    setMobileNavOpen(false);

    clearApp();
    app.classList.remove('dashboard-wide');

    var container = document.createElement('div');
    container.className = 'signin-container';
    container.style.cssText = 'max-width:360px;margin:80px auto 0;';

    var card = document.createElement('div');
    card.className = 'form-section';
    card.style.cssText = 'padding:32px;';

    var title = document.createElement('h2');
    title.textContent = 'Sign in';
    title.style.cssText = 'margin-bottom:24px;font-size:22px;';
    card.appendChild(title);

    var errorDiv = document.createElement('div');
    errorDiv.id = 'signin-error';
    errorDiv.style.cssText = 'display:none;';
    errorDiv.className = 'error-banner';
    card.appendChild(errorDiv);

    var emailGroup = document.createElement('div');
    emailGroup.className = 'form-group';
    emailGroup.style.cssText = 'margin-bottom:16px;';
    emailGroup.innerHTML = '<label for="signin-email" style="margin-bottom:6px;display:block;">Email</label>' +
      '<input type="email" id="signin-email" placeholder="Email address" style="width:100%;" autocomplete="username" />';
    card.appendChild(emailGroup);

    var passwordGroup = document.createElement('div');
    passwordGroup.className = 'form-group';
    passwordGroup.style.cssText = 'margin-bottom:24px;';
    passwordGroup.innerHTML = '<label for="signin-password" style="margin-bottom:6px;display:block;">Password</label>' +
      '<input type="password" id="signin-password" placeholder="Password" style="width:100%;" autocomplete="current-password" />';
    card.appendChild(passwordGroup);

    var submitBtn = document.createElement('button');
    submitBtn.className = 'btn-primary';
    submitBtn.id = 'signin-submit';
    submitBtn.textContent = 'Sign in';
    submitBtn.style.cssText = 'width:100%;padding:10px;font-size:15px;';
    card.appendChild(submitBtn);

    container.appendChild(card);
    app.appendChild(container);

    var loginPending = false;

    function doLogin() {
      if (loginPending) return;
      var email = document.getElementById('signin-email').value.trim();
      var password = document.getElementById('signin-password').value;
      var btn = document.getElementById('signin-submit');
      var err = document.getElementById('signin-error');

      loginPending = true;
      err.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Signing in...';
      btn.setAttribute('aria-busy', 'true');

      api.auth.login(email, password).then(function (data) {
        setSession(data.token, data.user);
        startApp(data.user);
      }).catch(function () {
        loginPending = false;
        err.textContent = 'Invalid email or password';
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Sign in';
        btn.removeAttribute('aria-busy');
      });
    }

    submitBtn.addEventListener('click', doLogin);

    // Allow Enter key in password field
    document.getElementById('signin-password').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });
    document.getElementById('signin-email').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });
    document.getElementById('signin-email').focus();
  }

  // ── App startup ──────────────────────────────────────────────────

  function startApp(user) {
    // Show nav links
    var navLinks = nav.querySelectorAll('.nav-link');
    navLinks.forEach(function (el) {
      el.style.display = '';
    });
    var navToggle = document.getElementById('nav-menu-toggle');
    if (navToggle) {
      navToggle.style.display = '';
      navToggle.onclick = function () {
        setMobileNavOpen(!nav.classList.contains('nav-open'));
      };
    }

    // Show sign-out button (remove old if exists)
    var oldSignOut = document.getElementById('signout-btn');
    if (oldSignOut) oldSignOut.remove();

    var signOutBtn = document.createElement('button');
    signOutBtn.id = 'signout-btn';
    signOutBtn.textContent = 'Sign out';
    signOutBtn.style.cssText = 'background:transparent;border:1px solid #bdc3c7;color:#bdc3c7;padding:6px 14px;border-radius:4px;font-size:13px;cursor:pointer;font-family:inherit;';
    signOutBtn.addEventListener('mouseenter', function () {
      signOutBtn.style.background = 'rgba(255,255,255,0.1)';
    });
    signOutBtn.addEventListener('mouseleave', function () {
      signOutBtn.style.background = 'transparent';
    });
    signOutBtn.addEventListener('click', function () {
      api.auth.logout().catch(function () {}).finally(function () {
        clearSession();
        renderSignIn();
      });
    });
    (document.getElementById('nav-menu') || nav).appendChild(signOutBtn);

    // Set current user ID from stored user
    dashboardState.currentUserId = user ? user.id : '';

    // Navigate to current hash (or default)
    navigate();
  }

  // Register 401 handler in api.js
  window._onUnauthorized = function () {
    clearSession();
    renderSignIn();
  };

  // ── Helpers ─────────────────────────────────────────────────────

  function todayString() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function showError(msg) {
    showNotice(msg, 'error');
  }

  function showSuccess(msg) {
    showNotice(msg, 'success');
  }

  function showNotice(msg, type) {
    var existing = app.querySelectorAll('.flash-banner, .error-banner');
    existing.forEach(function (banner) { banner.remove(); });
    var banner = document.createElement('div');
    banner.className = 'flash-banner ' + (type === 'success' ? 'success-banner' : 'error-banner');
    banner.setAttribute('role', type === 'success' ? 'status' : 'alert');
    banner.textContent = msg;
    app.prepend(banner);
    if (type === 'success') {
      setTimeout(function () {
        if (banner.parentNode) banner.remove();
      }, 3500);
    }
  }

  function setButtonBusy(btn, busy, label, busyLabel) {
    if (!btn) return;
    if (busy) {
      btn.setAttribute('data-idle-label', label || btn.textContent);
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      btn.textContent = busyLabel || 'Working...';
    } else {
      btn.disabled = false;
      btn.textContent = btn.getAttribute('data-idle-label') || label || btn.textContent;
      btn.removeAttribute('data-idle-label');
      btn.removeAttribute('aria-busy');
    }
  }

  function makeKeyboardCard(card, label, onActivate) {
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    if (label) card.setAttribute('aria-label', label);
    card.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onActivate(e);
    });
  }

  function renderBundleBadgeLink(bundleId, title) {
    var safeTitle = title || 'Untitled';
    return '<a class="badge-bundle" href="#/bundles" data-nav-bundle="' + escapeHtml(bundleId) + '" aria-label="Open bundle ' + escapeHtml(safeTitle) + '">' + escapeHtml(safeTitle) + '</a>';
  }

  function instructionLabel(description) {
    return 'Open instructions for ' + (description || 'task');
  }

  function taskRequiresApprovedArtifact(task) {
    return task && task.proofRequirement && task.proofRequirement.required !== false && task.proofRequirement.type === 'artifact';
  }

  function taskHasApprovedArtifactRef(task) {
    return Array.isArray(task && task.artifactRefs) && task.artifactRefs.some(function (ref) {
      return ref && ref.status === 'approved';
    });
  }

  function taskArtifactBlockTitle(task) {
    if (!taskRequiresApprovedArtifact(task) || taskHasApprovedArtifactRef(task)) return '';
    return 'Approve an attached artifact first';
  }

  function assistantStatusLabel(status) {
    return String(status || 'draft').replace(/_/g, ' ');
  }

  function renderAssistantStatus(status) {
    var safeStatus = status || 'draft';
    return '<span class="assistant-status ' + escapeHtml(safeStatus) + '">' + escapeHtml(assistantStatusLabel(safeStatus)) + '</span>';
  }

  function assistantNextAction(job) {
    if (!job) return '';
    if (job.status === 'waiting_approval') return 'Review output';
    if (job.status === 'failed') return 'Retry or file follow-up';
    if (job.status === 'rejected') return 'Retry with rejection context';
    if (job.status === 'queued') return 'Run dry or wait for runner';
    if (job.status === 'running') return 'Watch timeline';
    if (job.status === 'draft') return 'Submit or run dry';
    if (job.status === 'retrying') return 'Submit retry';
    if (job.status === 'approved') return 'Output approved';
    if (job.status === 'succeeded') return 'Output attached';
    if (job.status === 'canceled') return 'Canceled';
    return 'Check status';
  }

  function renderAssistantRefs(refs) {
    if (!Array.isArray(refs) || refs.length === 0) return '';
    return refs.map(function (ref) {
      return '<a class="assistant-chip" href="#/assistants" data-assistant-job-link="' + escapeHtml(ref.assistantJobId) + '">' +
        escapeHtml(ref.assistantType || 'assistant') + ' ' + escapeHtml(assistantStatusLabel(ref.status || 'draft')) +
        '</a>';
    }).join('');
  }

  function assistantJobActionsHtml(job) {
    var id = escapeHtml(job.id);
    var html = '';
    if (job.status === 'draft' || job.status === 'queued' || job.status === 'retrying' || job.status === 'running') {
      html += '<button class="assistant-action-btn" data-assistant-action="run-dry" data-assistant-job="' + id + '">Run dry</button>';
    }
    if (job.status === 'waiting_approval') {
      html += '<button class="assistant-action-btn" data-assistant-action="approve" data-assistant-job="' + id + '">Approve</button>';
      html += '<button class="assistant-action-btn" data-assistant-action="reject" data-assistant-job="' + id + '">Reject</button>';
    }
    if (job.status === 'failed' || job.status === 'rejected') {
      html += '<button class="assistant-action-btn" data-assistant-action="retry" data-assistant-job="' + id + '">Retry</button>';
    }
    if (['draft', 'queued', 'running', 'retrying', 'waiting_approval'].indexOf(job.status) !== -1) {
      html += '<button class="assistant-action-btn" data-assistant-action="cancel" data-assistant-job="' + id + '">Cancel</button>';
    }
    return html;
  }

  function bindAssistantLinks(scope) {
    scope.querySelectorAll('[data-assistant-job-link]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        location.hash = '#/assistants';
      });
    });
  }

  function handleAssistantAction(jobId, action, onDone) {
    var promise;
    if (action === 'run-dry') promise = api.assistantJobs.runDry(jobId);
    if (action === 'approve') promise = api.assistantJobs.approve(jobId);
    if (action === 'reject') {
      var reason = prompt('Rejection reason');
      if (!reason || !reason.trim()) return;
      promise = api.assistantJobs.reject(jobId, reason.trim());
    }
    if (action === 'retry') promise = api.assistantJobs.retry(jobId).then(function (result) {
      if (result && result.job && result.job.status === 'retrying') return api.assistantJobs.submit(jobId);
      return result;
    });
    if (action === 'cancel') promise = api.assistantJobs.cancel(jobId);
    if (!promise) return;

    promise.then(function () {
      showSuccess('Assistant job updated.');
      if (onDone) onDone();
    }).catch(function (err) {
      showError('Assistant action failed: ' + err.message);
    });
  }

  function bindAssistantActionButtons(scope, onDone) {
    scope.querySelectorAll('[data-assistant-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        handleAssistantAction(btn.getAttribute('data-assistant-job'), btn.getAttribute('data-assistant-action'), onDone);
      });
    });
  }

  function requestPodcastAssistantForContext(context, onDone) {
    var title = 'Podcast assistant: ' + (context.title || context.description || 'workflow support');
    var inputRefs = [];
    if (context.taskId) inputRefs.push({ type: 'task', id: context.taskId });
    if (context.bundleId) inputRefs.push({ type: 'bundle', id: context.bundleId });
    api.assistantJobs.create({
      assistantType: 'podcast',
      title: title,
      taskId: context.taskId,
      bundleId: context.bundleId,
      inputRefs: inputRefs,
      approvalRequired: true,
      maxAttempts: 2,
    }).then(function (data) {
      return api.assistantJobs.submit(data.job.id);
    }).then(function () {
      showSuccess('Podcast assistant job queued.');
      if (onDone) onDone();
    }).catch(function (err) {
      showError('Failed to request assistant help: ' + err.message);
    });
  }

  function renderInstructionLink(url, description) {
    return '<a class="instructions-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener" title="Instructions" aria-label="' + escapeHtml(instructionLabel(description)) + '"><span aria-hidden="true">\u{1F4CB}</span></a>';
  }

  function processDocUrl(docId) {
    return '/docs/resolve?ref=' + encodeURIComponent(docId);
  }

  var PROCESS_DOC_REGISTRY = {
    'reference.social-media.post-podcast-overview-after-the-event': { title: 'Post. Podcast. Overview after the event', docType: 'reference', path: 'content/social-media/reference/post-podcast-overview-after-the-event.md', summary: 'Reference guide for post-event podcast overview copy, assets, examples, and workflow notes.' },
    'sop.events.announce-event-in-slack-in-announcements': { title: 'Announce event in Slack in #announcements', docType: 'sop', path: 'content/events/sops/announce-event-in-slack-in-announcements.md', summary: 'Announce upcoming events in #announcements so the community has the event context and registration link.' },
    'sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event': { title: 'Create a calendar invite for event guests or speakers', docType: 'sop', path: 'content/events/calendar/sops/create-a-calender-invite-for-the-guests-speaker-for-an-event.md', summary: 'Create Google Calendar invites for event guests or speakers with the correct event details.' },
    'sop.events.calendar.creating-tentative-event-on-google-calendar': { title: 'Creating Tentative Event on Google Calendar', docType: 'sop', path: 'content/events/calendar/sops/creating-tentative-event-on-google-calendar.md', summary: 'Create a proposed event block on Google Calendar before the date is fully confirmed.' },
    'sop.events.luma.creating-events-on-google-calendar': { title: 'Creating Events on Google Calendar', docType: 'sop', path: 'content/events/luma/sops/creating-events-on-google-calendar.md', summary: 'Create a Google Calendar entry for a DataTalks.Club event.' },
    'sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma': { title: 'Creating events (Webinar, Workshop and Podcast) on Luma', docType: 'sop', path: 'content/events/luma/sops/creating-events-webinar-workshop-and-podcast-on-luma.md', summary: 'Create Luma event pages with the correct description, timing, and registration details.' },
    'sop.events.luma.downloading-the-csv-file-on-luma': { title: 'Downloading the CSV File on Luma', docType: 'sop', path: 'content/events/luma/sops/downloading-the-csv-file-on-luma.md', summary: 'Download attendee CSV exports from Luma for follow-up, reporting, or registration imports.' },
    'sop.events.meetup.create-events-in-meetup-com': { title: 'Create events in Meetup.com', docType: 'sop', path: 'content/events/meetup/sops/create-events-in-meetup-com.md', summary: 'Copy event announcements from Luma to Meetup with the needed public event details.' },
    'sop.events.outreach.how-to-find-emails-of-previous-guests': { title: 'How to find emails of previous guests', docType: 'sop', path: 'content/events/outreach/sops/how-to-find-emails-of-previous-guests.md', summary: 'Find previous guest email addresses for outreach and event coordination follow-up.' },
    'sop.events.planning.create-speaker-profiles-via-airtable-form': { title: 'Create speaker profiles via Airtable form', docType: 'sop', path: 'content/events/planning/sops/create-speaker-profiles-via-airtable-form.md', summary: 'Add a new speaker profile to the website through the Airtable form.' },
    'sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website': { title: 'Fill in the event form in Airtable for adding events to our website', docType: 'sop', path: 'content/events/planning/sops/fill-in-the-event-form-in-airtable-for-adding-events-to-our-website.md', summary: 'Fill out event, speaker, and publishing fields for the website event listing.' },
    'sop.media.podcast.add-a-guest-bio-to-the-podcast-document': { title: 'Add a guest bio to the podcast document', docType: 'sop', path: 'content/media/podcast/sops/add-a-guest-bio-to-the-podcast-document.md', summary: 'Add the guest bio and links to the podcast planning document.' },
    'sop.media.podcast.add-a-podcast-episode-via-airtable-form': { title: 'Add a podcast episode via Airtable form', docType: 'sop', path: 'content/media/podcast/sops/add-a-podcast-episode-via-airtable-form.md', summary: 'Submit the podcast episode form used to create the DataTalks.Club podcast page.' },
    'sop.media.podcast.add-links-to-youtube-after-the-stream-is-over': { title: 'Add links to YouTube after the stream is over', docType: 'sop', path: 'content/media/podcast/sops/add-links-to-youtube-after-the-stream-is-over.md', summary: 'Collect guest links and add them to the YouTube video description after the stream.' },
    'sop.media.podcast.create-podcast-document': { title: 'Create a podcast document', docType: 'sop', path: 'content/media/podcast/sops/create-a-podcast-document.md', summary: 'Create a podcast planning document with event information, guest questions, and announcement details.' },
    'sop.media.podcast.creating-podcast-transcription-document': { title: 'Creating podcast transcription document', docType: 'sop', path: 'content/media/podcast/sops/creating-podcast-transcription-document.md', summary: 'Transcribe podcast episodes, generate transcripts, and edit them for publishing.' },
    'sop.media.podcast.generate-timecodes-from-docx-transcriptions': { title: 'Generate Timecodes from docx Transcriptions', docType: 'sop', path: 'content/media/podcast/sops/generate-timecodes-from-docx-transcriptions.md', summary: 'Generate YouTube timecodes from a podcast transcription document.' },
    'sop.media.podcast.making-event-announcements-when-topic-bio-or-outline-is-missing': { title: 'Making event announcements when topic, bio, or outline is missing', docType: 'sop', path: 'content/media/podcast/sops/making-event-announcements-when-topic-bio-or-outline-is-missing.md', summary: 'Announce a podcast event even when topic, bio, or outline details are incomplete.' },
    'sop.media.podcast.managing-podcast-workflow': { title: 'Managing Podcast Workflow', docType: 'sop', path: 'content/media/podcast/sops/managing-podcast-workflow.md', summary: 'Manage podcast production from guest coordination through recording, publishing, transcripts, and follow-up.' },
    'sop.media.podcast.move-podcast-documents-to-archive-in-google-drive': { title: 'Move podcast documents to archive in Google drive', docType: 'sop', path: 'content/media/podcast/sops/move-podcast-documents-to-archive-in-google-drive.md', summary: 'Move podcast documents to the archive folder after production is complete.' },
    'sop.media.podcast.moving-podcast-audio-in-dropbox': { title: 'Moving Podcast Audio in Dropbox', docType: 'sop', path: 'content/media/podcast/sops/moving-podcast-audio-in-dropbox.md', summary: 'Organize podcast audio in Dropbox so published and unpublished episodes are easy to track.' },
    'sop.media.podcast.removing-the-beginning-from-the-youtube-stream': { title: 'Removing the beginning from the YouTube stream', docType: 'sop', path: 'content/media/podcast/sops/removing-the-beginning-from-the-youtube-stream.md', summary: 'Trim small talk or setup time from the beginning of a YouTube stream.' },
    'sop.media.podcast.schedule-podcast-episodes-with-spotify-for-podcaster': { title: 'Schedule podcast episodes with Spotify for podcaster', docType: 'sop', path: 'content/media/podcast/sops/schedule-podcast-episodes-with-spotify-for-podcaster.md', summary: 'Schedule a podcast episode in Spotify for Podcasters.' },
    'sop.media.podcast.select-and-propose-a-date-for-events': { title: 'Select and propose a date for events', docType: 'sop', path: 'content/media/podcast/sops/select-and-propose-a-date-for-events.md', summary: 'Select and propose event dates using the schedule spreadsheet and Google Calendar.' },
    'sop.media.podcast.sending-a-podcast-scheduled-email-to-pavel-after-the-event': { title: 'Sending a podcast scheduled email to Pavel (after the event)', docType: 'sop', path: 'content/media/podcast/sops/sending-a-podcast-scheduled-email-to-pavel-after-the-event.md', summary: 'Send Pavel the podcast scheduling and recording details after an episode.' },
    'sop.media.podcast.update-the-website-with-the-information-from-forms': { title: 'Update the website with the information from forms', docType: 'sop', path: 'content/media/podcast/sops/update-the-website-with-the-information-from-forms.md', summary: 'Publish Airtable event, speaker, and podcast form data to the website.' },
    'sop.media.podcast.updating-the-cover-of-the-youtube-video': { title: 'Updating the cover of the YouTube video', docType: 'sop', path: 'content/media/podcast/sops/updating-the-cover-of-the-youtube-video.md', summary: 'Update the cover image for a YouTube video.' },
    'sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist': { title: 'Adding videos from other channels to our playlist', docType: 'sop', path: 'content/media/video-youtube/sops/adding-videos-from-other-channels-to-our-playlist.md', summary: 'Add external videos to DataTalks.Club YouTube playlists without reuploading them.' },
    'sop.social-media.post-podcast-guest-recommendations': { title: 'Post. Podcast. Guest recommendations', docType: 'sop', path: 'content/social-media/sops/post-podcast-guest-recommendations.md', summary: 'Share podcast guest recommendations on LinkedIn and Twitter/X.' },
    'template.media.podcast.podcast-adding-johanna-and-sending-the-podcast-link-to-the-speaker': { title: 'Podcast - Adding Johanna and Sending the podcast link to the speaker', docType: 'template', path: 'content/media/podcast/templates/podcast-adding-johanna-and-sending-the-podcast-link-to-the-speaker.md', summary: 'Reusable guest outreach wording for adding Johanna and sending the podcast document link.' },
    'template.media.podcast.podcast-links-after-the-event-is-over': { title: 'Podcast - Links after the event is over', docType: 'template', path: 'content/media/podcast/templates/podcast-links-after-the-event-is-over.md', summary: 'Reusable wording for collecting links from the guest after the podcast event.' },
    'template.media.podcast.podcast-remind-about-the-event-in-a-week-share-registration-link-template': { title: 'Podcast - Remind about the event in a week, share registration link - Template', docType: 'template', path: 'content/media/podcast/templates/podcast-remind-about-the-event-in-a-week-share-registration-link-template.md', summary: 'Reusable reminder wording for one week before the podcast event.' },
    'template.media.podcast.podcast-remind-the-guest-about-the-event-a-day-before-template': { title: 'Podcast - Remind the guest about the event a day before - Template', docType: 'template', path: 'content/media/podcast/templates/podcast-remind-the-guest-about-the-event-a-day-before-template.md', summary: 'Reusable reminder wording for the day before the podcast event.' },
    'template.media.podcast.podcast-share-the-podcast-page-template': { title: 'Podcast - Share the podcast page - Template', docType: 'template', path: 'content/media/podcast/templates/podcast-share-the-podcast-page-template.md', summary: 'Reusable wording for asking the guest to share the published podcast page.' },
    'template.media.podcast.sending-podcast-document-on-slack-the-dtc-podcast-help-channel': { title: 'Sending Podcast Document on Slack the DTC podcast help channel', docType: 'template', path: 'content/media/podcast/templates/sending-podcast-document-on-slack-the-dtc-podcast-help-channel.md', summary: 'Reusable Slack message for sharing the podcast document with the DTC podcast help channel.' },
    'template.social-media.template-new-event-announcements-podcasts-webinars-workshops': { title: 'Template. New event announcements (podcasts, webinars, workshops)', docType: 'template', path: 'content/social-media/templates/template-new-event-announcements-podcasts-webinars-workshops.md', summary: 'Reusable social announcement copy for new podcasts, webinars, and workshops.' }
  };

  function resolveProcessDocContext(docId) {
    return PROCESS_DOC_REGISTRY[String(docId || '')] || null;
  }

  function processDocActionLabel(doc) {
    if (!doc || !doc.docType) return 'Open doc';
    if (doc.docType === 'sop') return 'Open SOP';
    if (doc.docType === 'template') return 'Open template';
    if (doc.docType === 'reference') return 'Open reference';
    return 'Open ' + doc.docType;
  }

  function renderInstructionContext(task) {
    if (task.instructionDocId) {
      var docId = String(task.instructionDocId);
      var doc = resolveProcessDocContext(docId);
      var detail = [];
      if (task.phase) detail.push('Phase: ' + task.phase);
      if (task.instructionStepId) detail.push('Step: ' + task.instructionStepId);
      if (Array.isArray(task.systems) && task.systems.length) detail.push(task.systems.join(', '));
      if (doc) {
        return '<div class="process-doc-context" data-process-doc-context="' + escapeHtml(docId) + '">' +
          '<span class="process-doc-label">' + escapeHtml(doc.docType || 'doc') + '</span>' +
          '<a class="process-doc-link" href="' + escapeHtml(processDocUrl(docId)) + '" target="_blank" rel="noopener" aria-label="Open process doc ' + escapeHtml(doc.title) + '">' + escapeHtml(doc.title) + '</a>' +
          '<span class="process-doc-summary">' + escapeHtml(doc.summary || doc.path || docId) + '</span>' +
          (detail.length ? '<span class="process-doc-meta">' + escapeHtml(detail.join(' | ')) + '</span>' : '') +
          '<a class="process-doc-action" href="' + escapeHtml(processDocUrl(docId)) + '" target="_blank" rel="noopener">' + escapeHtml(processDocActionLabel(doc)) + '</a>' +
          '</div>';
      }
      return '<div class="process-doc-context process-doc-context--unresolved" data-process-doc-context="' + escapeHtml(docId) + '">' +
        '<span class="process-doc-label">Process doc</span>' +
        '<span class="process-doc-link">Unresolved document</span>' +
        '<span class="process-doc-meta">' + escapeHtml(docId + (detail.length ? ' | ' + detail.join(' | ') : '')) + '</span>' +
        '<a class="process-doc-action" href="' + escapeHtml(processDocUrl(docId)) + '" target="_blank" rel="noopener">Try docs resolver</a>' +
        '</div>';
    }
    if (task.instructionsUrl) {
      return '<div class="process-doc-context process-doc-context--legacy">' +
        '<span class="process-doc-label">Instructions</span>' +
        '<a class="process-doc-link" href="' + escapeHtml(task.instructionsUrl) + '" target="_blank" rel="noopener" aria-label="' + escapeHtml(instructionLabel(task.description)) + '">legacy instructions</a>' +
        '<span class="process-doc-meta">legacy URL</span>' +
        '</div>';
    }
    return '<div class="process-doc-context process-doc-context--missing">' +
      '<span class="process-doc-label">Process doc</span>' +
      '<span class="process-doc-meta">No process document mapped</span>' +
      '</div>';
  }

  function renderArtifactRefs(refs) {
    if (!Array.isArray(refs) || refs.length === 0) return '';
    return '<div class="artifact-ref-list">' + refs.map(function (ref) {
      var status = ref.status || 'draft';
      var href = ref.storageUri || '#';
      var linked = href && href !== '#';
      return '<a class="artifact-chip artifact-chip--' + escapeHtml(status) + '" href="' + escapeHtml(href) + '"' + (linked ? ' target="_blank" rel="noopener"' : '') + ' data-artifact-ref="' + escapeHtml(ref.artifactId || '') + '">' +
        escapeHtml(ref.title || ref.type || ref.artifactId || 'Artifact') +
        '<span>' + escapeHtml(status) + '</span>' +
        '</a>';
    }).join('') + '</div>';
  }

  function renderArtifactPanel(artifacts) {
    var html = '<div class="artifact-panel" data-testid="workflow-artifacts"><h3>Proof and assistant outputs</h3>';
    if (!artifacts || artifacts.length === 0) {
      html += '<div class="empty-state">No proof or assistant outputs attached.</div></div>';
      return html;
    }
    artifacts.forEach(function (artifact) {
      html += '<div class="artifact-row" data-artifact-row="' + escapeHtml(artifact.id) + '">' +
        '<div>' +
          '<div class="artifact-title">' + escapeHtml(artifact.title || artifact.type || 'Artifact') + '</div>' +
          '<div class="artifact-meta">' + escapeHtml(artifact.type || 'artifact') + ' · ' + escapeHtml(artifact.status || 'draft') + ' · ' + escapeHtml(artifact.storageProvider || 'unknown') + '</div>' +
        '</div>' +
        '<a class="card-action-link" href="' + escapeHtml(artifact.storageUri || '#') + '" target="_blank" rel="noopener">Open output</a>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  function renderEmptyState(title, body, actions) {
    var html = '<div class="empty-state empty-state-rich">' +
      '<div class="empty-state-title">' + escapeHtml(title) + '</div>';
    if (body) {
      html += '<div class="empty-state-body">' + escapeHtml(body) + '</div>';
    }
    if (actions && actions.length) {
      html += '<div class="empty-state-actions">';
      actions.forEach(function (action, index) {
        var className = index === 0 ? 'empty-state-action primary' : 'empty-state-action secondary';
        html += '<a class="' + className + '" href="' + escapeHtml(action.href) + '">' + escapeHtml(action.label) + '</a>';
      });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function setMobileNavOpen(open) {
    nav.classList.toggle('nav-open', open);
    var toggle = document.getElementById('nav-menu-toggle');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    toggle.innerHTML = open ? '&times;' : '&#9776;';
  }

  function initMobileNavKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !nav.classList.contains('nav-open')) return;
      e.preventDefault();
      setMobileNavOpen(false);
      var toggle = document.getElementById('nav-menu-toggle');
      if (toggle) toggle.focus();
    });
  }

  function clearApp() {
    app.innerHTML = '';
  }

  // ── Router ──────────────────────────────────────────────────────

  var routes = {
    '#/': renderDashboard,
    '#/tasks': renderTasks,
    '#/bundles': renderBundles,
    '#/assistants': renderAssistants,
    '#/templates': renderTemplates,
    '#/recurring': renderRecurring,
    '#/notifications': renderNotifications,
  };

  function navigate() {
    var hash = location.hash || '';
    var handler = routes[hash];
    if (!handler) {
      location.hash = '#/';
      return;
    }
    // Toggle wide layout for dashboard
    if (hash === '#/') {
      app.classList.add('dashboard-wide');
    } else {
      app.classList.remove('dashboard-wide');
    }
    // Update active nav link
    var links = document.querySelectorAll('nav .nav-link');
    links.forEach(function (a) {
      var isCurrent = a.getAttribute('href') === hash;
      a.classList.toggle('active', isCurrent);
      if (isCurrent) {
        a.setAttribute('aria-current', 'page');
      } else {
        a.removeAttribute('aria-current');
      }
    });
    // Close dropdown on navigation
    closeNotifDropdown();
    setMobileNavOpen(false);
    // Refresh bell badge
    refreshBellBadge();
    handler();
  }

  window.addEventListener('hashchange', navigate);
  window.addEventListener('DOMContentLoaded', function () {
    initSkipLink();
    initMobileNavKeyboard();
    initBell();
    var token = getStoredToken();
    var user = getStoredUser();
    if (token && user) {
      // Token exists in localStorage - restore session immediately
      // (no round-trip to server; 401 from any API call will trigger sign-in)
      startApp(user);
    } else {
      renderSignIn();
    }
  });

  function initSkipLink() {
    var skipLink = document.getElementById('skip-link');
    if (!skipLink) return;
    skipLink.addEventListener('click', function (e) {
      e.preventDefault();
      app.focus();
    });
  }

  // ── Bell notification icon ─────────────────────────────────────

  function refreshBellBadge() {
    api.notifications.list().then(function (data) {
      var count = (data.notifications || []).length;
      var badge = document.getElementById('notif-badge');
      var bell = document.getElementById('notif-bell');
      if (!badge) return;
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
      if (bell) {
        bell.setAttribute('aria-label', count > 0 ? 'Notifications, ' + count + ' unread' : 'Notifications');
      }
    }).catch(function () {
      // silently ignore
    });
  }

  function closeNotifDropdown() {
    var dropdown = document.getElementById('notif-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    var bell = document.getElementById('notif-bell');
    if (bell) bell.setAttribute('aria-expanded', 'false');
  }

  function openNotifDropdown() {
    var dropdown = document.getElementById('notif-dropdown');
    if (!dropdown) return;

    var bell = document.getElementById('notif-bell');
    if (bell) bell.setAttribute('aria-expanded', 'true');
    dropdown.style.display = 'block';
    dropdown.innerHTML = '<div class="notif-dropdown-header">Notifications</div><div class="notif-dropdown-empty">Loading...</div>';

    api.notifications.list().then(function (data) {
      var notifications = (data.notifications || []).slice(0, 3);
      dropdown.innerHTML = '';

      var header = document.createElement('div');
      header.className = 'notif-dropdown-header';
      header.textContent = 'Notifications';
      dropdown.appendChild(header);

      if (notifications.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'notif-dropdown-empty';
        empty.textContent = 'No new notifications';
        dropdown.appendChild(empty);
      } else {
        notifications.forEach(function (n) {
          var item = document.createElement('div');
          item.className = 'notif-dropdown-item';
          var msg = document.createElement('div');
          msg.textContent = n.message;
          item.appendChild(msg);
          var time = document.createElement('div');
          time.className = 'notif-dropdown-time';
          time.textContent = formatRelativeTime(n.createdAt);
          item.appendChild(time);
          dropdown.appendChild(item);
        });
      }

      var footer = document.createElement('div');
      footer.className = 'notif-dropdown-footer';
      var seeAll = document.createElement('a');
      seeAll.href = '#/notifications';
      seeAll.textContent = 'See all notifications';
      seeAll.addEventListener('click', function () {
        closeNotifDropdown();
      });
      footer.appendChild(seeAll);
      dropdown.appendChild(footer);
    }).catch(function () {
      dropdown.innerHTML = '<div class="notif-dropdown-empty">Failed to load notifications</div>';
    });
  }

  function initBell() {
    var bell = document.getElementById('notif-bell');
    var wrapper = document.getElementById('notif-bell-wrapper');
    if (!bell || !wrapper) return;

    bell.addEventListener('click', function (e) {
      e.stopPropagation();
      var dropdown = document.getElementById('notif-dropdown');
      if (!dropdown) return;
      if (dropdown.style.display === 'none' || dropdown.style.display === '') {
        openNotifDropdown();
      } else {
        closeNotifDropdown();
      }
    });

    bell.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeNotifDropdown();
      bell.focus();
    });

    document.addEventListener('click', function (e) {
      var wrapper2 = document.getElementById('notif-bell-wrapper');
      if (wrapper2 && !wrapper2.contains(e.target)) {
        closeNotifDropdown();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var dropdown = document.getElementById('notif-dropdown');
      if (!dropdown || dropdown.style.display === 'none' || dropdown.style.display === '') return;
      closeNotifDropdown();
      var bell2 = document.getElementById('notif-bell');
      if (bell2) bell2.focus();
    });

    refreshBellBadge();
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return '';
    var date = new Date(isoString);
    var now = new Date();
    var diffMs = now - date;
    var diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return diffMins + ' minute' + (diffMins === 1 ? '' : 's') + ' ago';
    var diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return diffHours + ' hour' + (diffHours === 1 ? '' : 's') + ' ago';
    var diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return diffDays + ' day' + (diffDays === 1 ? '' : 's') + ' ago';
    return date.toLocaleDateString();
  }

  // ── Dashboard View ─────────────────────────────────────────────

  var dashboardState = {
    assignedToMe: true,
    currentUserId: '',
    bundleSortMode: 'date', // 'date' | 'stage' | 'template'
  };

  function renderDashboard() {
    clearApp();

    // Two-column layout
    var layout = document.createElement('div');
    layout.className = 'dashboard-layout';

    var leftCol = document.createElement('div');
    leftCol.className = 'dashboard-left';

    var rightCol = document.createElement('div');
    rightCol.className = 'dashboard-right';

    // Left column header
    var leftHeader = document.createElement('h3');
    leftHeader.className = 'dashboard-section-title';
    leftHeader.textContent = 'Active Bundles';
    leftCol.appendChild(leftHeader);

    // Sort control
    var sortControl = document.createElement('div');
    sortControl.className = 'bundle-sort-control';
    sortControl.setAttribute('data-testid', 'bundle-sort-control');

    var sortModes = [
      { mode: 'date', label: 'Date', testid: 'sort-btn-date' },
      { mode: 'stage', label: 'Stage', testid: 'sort-btn-stage' },
      { mode: 'template', label: 'Template', testid: 'sort-btn-template' },
    ];

    sortModes.forEach(function (item) {
      var btn = document.createElement('button');
      btn.className = 'bundle-sort-btn' + (dashboardState.bundleSortMode === item.mode ? ' active' : '');
      btn.textContent = item.label;
      btn.setAttribute('data-testid', item.testid);
      btn.addEventListener('click', function () {
        if (dashboardState.bundleSortMode === item.mode) return;
        dashboardState.bundleSortMode = item.mode;
        // Update active button
        sortControl.querySelectorAll('.bundle-sort-btn').forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        loadDashboardBundles();
      });
      sortControl.appendChild(btn);
    });

    leftCol.appendChild(sortControl);

    var bundlesContainer = document.createElement('div');
    bundlesContainer.id = 'dashboard-bundles';
    bundlesContainer.innerHTML = '<p>Loading...</p>';
    leftCol.appendChild(bundlesContainer);

    // Right column header with assigned-to-me toggle and user picker
    var rightHeader = document.createElement('div');
    rightHeader.className = 'dashboard-header';
    var currentUserOption = dashboardState.currentUserId
      ? '<option value="' + escapeHtml(dashboardState.currentUserId) + '" selected>Loading user...</option>'
      : '';
    rightHeader.innerHTML =
      '<h3>Today\'s Tasks</h3>' +
      '<select id="dashboard-user-picker" class="user-picker">' + currentUserOption + '</select>' +
      '<label class="assigned-toggle">' +
        '<input type="checkbox" id="assigned-to-me" ' + (dashboardState.assignedToMe ? 'checked' : '') + ' />' +
        'Assigned to me' +
      '</label>';
    rightCol.appendChild(rightHeader);

    var tasksContainer = document.createElement('div');
    tasksContainer.id = 'dashboard-tasks';
    tasksContainer.innerHTML = '<p>Loading...</p>';
    rightCol.appendChild(tasksContainer);

    layout.appendChild(leftCol);
    layout.appendChild(rightCol);
    app.appendChild(layout);

    // Populate user picker
    loadUsersOnce().then(function (usersMap) {
      var picker = document.getElementById('dashboard-user-picker');
      if (!picker) return;
      picker.replaceChildren();
      Object.keys(usersMap).forEach(function (uid) {
        var opt = document.createElement('option');
        opt.value = uid;
        opt.textContent = usersMap[uid].name;
        if (uid === dashboardState.currentUserId) opt.selected = true;
        picker.appendChild(opt);
      });

      picker.addEventListener('change', function () {
        dashboardState.currentUserId = picker.value;
        loadDashboardTasks();
      });
    });

    // Toggle assigned-to-me
    var toggleEl = document.getElementById('assigned-to-me');
    if (toggleEl) {
      toggleEl.addEventListener('change', function () {
        dashboardState.assignedToMe = toggleEl.checked;
        loadDashboardTasks();
      });
    }

    // Load data
    loadDashboardBundles();
    loadDashboardTasks();
  }

  // ── Notifications Page ─────────────────────────────────────────

  function renderNotifications() {
    clearApp();

    // Page header
    var header = document.createElement('div');
    header.className = 'notif-page-header';
    var title = document.createElement('h2');
    title.textContent = 'Notifications';
    header.appendChild(title);
    var dismissAllBtn = document.createElement('button');
    dismissAllBtn.className = 'btn-primary';
    dismissAllBtn.id = 'dismiss-all-btn';
    dismissAllBtn.textContent = 'Dismiss all';
    header.appendChild(dismissAllBtn);
    app.appendChild(header);

    var listContainer = document.createElement('div');
    listContainer.id = 'notif-list-container';
    listContainer.innerHTML = '<p>Loading...</p>';
    app.appendChild(listContainer);

    function loadNotifList() {
      listContainer.innerHTML = '<p>Loading...</p>';
      api.notifications.listAll().then(function (data) {
        var notifications = data.notifications || [];
        listContainer.innerHTML = '';

        if (notifications.length === 0) {
          listContainer.innerHTML = '<div class="empty-state">No notifications</div>';
          return;
        }

        notifications.forEach(function (n) {
          var item = document.createElement('div');
          item.className = 'notif-list-item' + (n.dismissed ? ' dismissed' : '');
          item.setAttribute('data-notif-item', n.id);

          var body = document.createElement('div');
          body.className = 'notif-list-item-body';

          var msg = document.createElement('div');
          msg.className = 'notif-list-item-msg';
          msg.textContent = n.message;
          body.appendChild(msg);

          var timeDiv = document.createElement('div');
          timeDiv.className = 'notif-list-item-time' + (n.dismissed ? ' dismissed' : '');
          timeDiv.textContent = formatRelativeTime(n.createdAt) + (n.dismissed ? ' \u2014 dismissed' : '');
          body.appendChild(timeDiv);

          item.appendChild(body);

          if (!n.dismissed) {
            var dismissBtn = document.createElement('button');
            dismissBtn.className = 'btn-dismiss-notif';
            dismissBtn.textContent = '\u00D7';
            dismissBtn.title = 'Dismiss';
            dismissBtn.setAttribute('aria-label', 'Dismiss notification: ' + n.message);
            dismissBtn.addEventListener('click', function () {
              dismissBtn.disabled = true;
              dismissBtn.textContent = '...';
              dismissBtn.setAttribute('aria-busy', 'true');
              dismissBtn.setAttribute('aria-label', 'Dismissing notification: ' + n.message);
              api.notifications.dismiss(n.id).then(function () {
                item.className = 'notif-list-item dismissed';
                timeDiv.className = 'notif-list-item-time dismissed';
                timeDiv.textContent = formatRelativeTime(n.createdAt) + ' \u2014 dismissed';
                dismissBtn.remove();
                refreshBellBadge();
              }).catch(function (err) {
                showError('Failed to dismiss: ' + err.message);
                dismissBtn.disabled = false;
                dismissBtn.textContent = '\u00D7';
                dismissBtn.removeAttribute('aria-busy');
                dismissBtn.setAttribute('aria-label', 'Dismiss notification: ' + n.message);
              });
            });
            item.appendChild(dismissBtn);
          }

          listContainer.appendChild(item);
        });
      }).catch(function (err) {
        listContainer.innerHTML = '';
        showError('Failed to load notifications: ' + err.message);
      });
    }

    loadNotifList();

    dismissAllBtn.addEventListener('click', function () {
      setButtonBusy(dismissAllBtn, true, 'Dismiss all', 'Dismissing...');
      api.notifications.dismissAll().then(function () {
        loadNotifList();
        refreshBellBadge();
        showSuccess('Notifications dismissed.');
      }).catch(function (err) {
        showError('Failed to dismiss all: ' + err.message);
      }).finally(function () {
        setButtonBusy(dismissAllBtn, false, 'Dismiss all');
      });
    });
  }

  // Stage display labels (for stage mode headings)
  var STAGE_ORDER = ['preparation', 'announced', 'after-event', 'done'];
  var STAGE_LABELS = {
    'preparation': 'Preparation',
    'announced': 'Announced',
    'after-event': 'After Event',
    'done': 'Done',
  };

  // Sort helper: ascending by anchorDate, no-date sorts to end
  function anchorDateCompare(a, b) {
    var da = a.anchorDate || '';
    var db = b.anchorDate || '';
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da.localeCompare(db);
  }

  function renderBundleCard(b, taskMap) {
    var tasks = taskMap[b.id] || [];
    var doneCount = tasks.filter(function (t) { return t.status === 'done'; }).length;
    var totalCount = tasks.length;

    var card = document.createElement('div');
    card.className = 'dashboard-bundle-card';
    card.setAttribute('data-bundle-id', b.id);

    // Title line with emoji + anchor date on same line
    var titleDiv = document.createElement('div');
    titleDiv.className = 'dashboard-bundle-card-title';
    var titleText = document.createElement('span');
    titleText.textContent = (b.emoji ? b.emoji + ' ' : '') + (b.title || 'Untitled');
    titleDiv.appendChild(titleText);
    if (b.anchorDate) {
      var dateBadge = document.createElement('span');
      dateBadge.className = 'badge-anchor-date';
      dateBadge.textContent = b.anchorDate;
      titleDiv.appendChild(dateBadge);
    }
    card.appendChild(titleDiv);

    // Meta row: tags, progress, stage
    var metaDiv = document.createElement('div');
    metaDiv.className = 'dashboard-bundle-card-meta';

    // Tags
    (b.tags || []).forEach(function (tag) {
      var tagBadge = document.createElement('span');
      tagBadge.className = 'badge-tag';
      tagBadge.textContent = tag;
      metaDiv.appendChild(tagBadge);
    });

    // Progress
    var progressBadge = document.createElement('span');
    var allDone = totalCount > 0 && doneCount === totalCount;
    progressBadge.className = 'progress-badge' + (allDone ? ' all-done' : '');
    progressBadge.textContent = doneCount + '/' + totalCount + ' done';
    metaDiv.appendChild(progressBadge);

    // Stage
    var stage = b.stage || 'preparation';
    var stageBadge = document.createElement('span');
    stageBadge.className = 'badge-stage ' + stage;
    stageBadge.textContent = stage;
    metaDiv.appendChild(stageBadge);

    card.appendChild(metaDiv);

    function openBundle() {
      currentBundleId = b.id;
      location.hash = '#/bundles';
    }

    card.addEventListener('click', openBundle);
    makeKeyboardCard(card, 'Open bundle ' + (b.title || 'Untitled'), openBundle);

    return card;
  }

  function renderBundlesDate(container, bundles, taskMap) {
    // Flat list sorted by anchorDate ascending, no headings
    var sorted = bundles.slice().sort(anchorDateCompare);
    sorted.forEach(function (b) {
      container.appendChild(renderBundleCard(b, taskMap));
    });
  }

  function renderBundlesStage(container, bundles, taskMap) {
    // Group by stage, only show non-empty stages, in fixed order
    var groups = {};
    bundles.forEach(function (b) {
      var stage = b.stage || 'preparation';
      if (!groups[stage]) groups[stage] = [];
      groups[stage].push(b);
    });

    STAGE_ORDER.forEach(function (stage) {
      if (!groups[stage] || groups[stage].length === 0) return;
      var heading = document.createElement('div');
      heading.className = 'bundle-group-heading';
      heading.textContent = STAGE_LABELS[stage] || stage;
      container.appendChild(heading);

      var sorted = groups[stage].slice().sort(anchorDateCompare);
      sorted.forEach(function (b) {
        container.appendChild(renderBundleCard(b, taskMap));
      });
    });
  }

  function renderBundlesTemplate(container, bundles, taskMap, templateMap) {
    // Group by templateId, "Other" last, sorted by name within groups
    var groups = {};
    bundles.forEach(function (b) {
      var key = b.templateId || '__other__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(b);
    });

    var groupKeys = Object.keys(groups);
    groupKeys.sort(function (a, b) {
      if (a === '__other__') return 1;
      if (b === '__other__') return -1;
      var nameA = templateMap[a] ? templateMap[a].name : a;
      var nameB = templateMap[b] ? templateMap[b].name : b;
      return nameA.localeCompare(nameB);
    });

    groupKeys.forEach(function (key) {
      var heading = document.createElement('div');
      heading.className = 'bundle-group-heading';
      if (key === '__other__') {
        heading.textContent = 'Other';
      } else {
        var tpl = templateMap[key];
        heading.textContent = tpl ? (tpl.emoji ? tpl.emoji + ' ' : '') + tpl.name : 'Unknown Template';
      }
      container.appendChild(heading);

      var sorted = groups[key].slice().sort(anchorDateCompare);
      sorted.forEach(function (b) {
        container.appendChild(renderBundleCard(b, taskMap));
      });
    });
  }

  function loadDashboardBundles() {
    var container = document.getElementById('dashboard-bundles');
    if (!container) return;

    Promise.all([
      api.bundles.list(),
      api.templates.list()
    ]).then(function (results) {
      var allBundles = results[0].bundles || [];
      var templates = results[1].templates || [];

      // Filter to active bundles
      var bundles = allBundles.filter(function (b) {
        return b.status === 'active';
      });

      if (bundles.length === 0) {
        container.innerHTML = renderEmptyState(
          'No active bundles',
          'Create a bundle to group upcoming work and track progress from this dashboard.',
          [{ href: '#/bundles', label: 'New bundle' }]
        );
        return;
      }

      // Build template map
      var templateMap = {};
      templates.forEach(function (t) {
        templateMap[t.id] = t;
      });

      // Fetch tasks for progress calculation
      var taskPromises = bundles.map(function (b) {
        return api.bundles.tasks(b.id).then(function (taskData) {
          return { bundleId: b.id, tasks: taskData.tasks || [] };
        }).catch(function () {
          return { bundleId: b.id, tasks: [] };
        });
      });

      Promise.all(taskPromises).then(function (taskResults) {
        var taskMap = {};
        taskResults.forEach(function (r) {
          taskMap[r.bundleId] = r.tasks;
        });

        container.innerHTML = '';

        var mode = dashboardState.bundleSortMode || 'date';
        if (mode === 'date') {
          renderBundlesDate(container, bundles, taskMap);
        } else if (mode === 'stage') {
          renderBundlesStage(container, bundles, taskMap);
        } else {
          renderBundlesTemplate(container, bundles, taskMap, templateMap);
        }
      });
    }).catch(function (err) {
      container.innerHTML = '';
      showError('Failed to load bundles: ' + err.message);
    });
  }

  function loadDashboardTasks() {
    var container = document.getElementById('dashboard-tasks');
    if (!container) return;
    container.innerHTML = '<p>Loading...</p>';

    var today = todayString();

    Promise.all([
      api.tasks.list({ date: today }),
      api.tasks.list({ status: 'waiting' }),
      loadUsersOnce()
    ]).then(function (results) {
      var data = results[0];
      var waitingData = results[1];
      var usersMap = results[2];
      var todayTasks = data.tasks || [];
      var dueWaitingTasks = (waitingData.tasks || []).filter(function (task) {
        return isDueFollowUpTask(task);
      });
      var tasks = dedupeTasksById(todayTasks.concat(dueWaitingTasks));

      // Apply assigned-to-me filter
      if (dashboardState.assignedToMe && dashboardState.currentUserId) {
        tasks = tasks.filter(function (t) {
          return t.assigneeId === dashboardState.currentUserId;
        });
      }

      if (tasks.length === 0) {
        container.innerHTML = renderEmptyState(
          'No tasks for today',
          'Use the task list to review upcoming dates or create an ad-hoc task.',
          [{ href: '#/tasks', label: 'Open tasks' }]
        );
        return;
      }

      // Sort by date ascending
      tasks.sort(function (a, b) {
        if (a.date < b.date) return -1;
        if (a.date > b.date) return 1;
        return 0;
      });

      // Collect unique bundleIds
      var bundleIds = [];
      tasks.forEach(function (t) {
        if (t.bundleId && bundleIds.indexOf(t.bundleId) === -1) {
          bundleIds.push(t.bundleId);
        }
      });

      var bundlePromises = bundleIds.map(function (bid) {
        return api.bundles.get(bid).then(function (d) {
          return { id: bid, title: d.bundle.title || 'Untitled' };
        }).catch(function () {
          return { id: bid, title: 'Unknown' };
        });
      });

      Promise.all(bundlePromises).then(function (bundleResults) {
        var bundleMap = {};
        bundleResults.forEach(function (b) {
          bundleMap[b.id] = b.title;
        });

        renderDashboardTaskTable(tasks, bundleMap, usersMap, container);
      });
    }).catch(function (err) {
      container.innerHTML = '';
      showError('Failed to load tasks: ' + err.message);
    });
  }

  function renderDashboardTaskTable(tasks, bundleMap, usersMap, container) {
    var html = '<table class="task-table-compact"><thead><tr>' +
      '<th></th><th>Date</th><th>Description</th><th>Bundle</th><th>Info</th><th>Assignee</th><th>Required Link</th><th>Actions</th>' +
      '</tr></thead><tbody>';
    tasks.forEach(function (t) {
      var isDone = t.status === 'done';
      var rowClass = isDone ? ' class="task-done"' : '';
      var checked = isDone ? ' checked' : '';

      // Checkbox disabled if requiredLinkName is set and link is empty
      var checkboxDisabled = '';
      var artifactBlockTitle = taskArtifactBlockTitle(t);
      if (t.requiredLinkName && !t.link) {
        checkboxDisabled = ' disabled title="Fill in ' + escapeHtml(t.requiredLinkName) + ' link first"';
      } else if (artifactBlockTitle) {
        checkboxDisabled = ' disabled title="' + escapeHtml(artifactBlockTitle) + '"';
      }

      // Bundle badge
      var bundleBadge;
      if (t.bundleId && bundleMap[t.bundleId]) {
        bundleBadge = renderBundleBadgeLink(t.bundleId, bundleMap[t.bundleId]);
      } else {
        bundleBadge = '<span class="badge-adhoc">ad hoc</span>';
      }

      // Instructions link icon
      var instructionsHtml = '';
      if (t.instructionDocId) {
        instructionsHtml = renderInstructionLink(processDocUrl(t.instructionDocId), t.description);
      } else if (t.instructionsUrl) {
        instructionsHtml = renderInstructionLink(t.instructionsUrl, t.description);
      }
      if (t.status === 'waiting') {
        var waitingText = 'Waiting';
        if (t.waitingFor) waitingText += ': ' + t.waitingFor;
        if (t.followUpAt) waitingText += ' · follow up ' + formatDateLabel(t.followUpAt);
        instructionsHtml += '<span class="badge-waiting">' + escapeHtml(waitingText) + '</span>';
      }
      instructionsHtml += '<div class="assistant-context-row">' +
        renderAssistantRefs(t.assistantJobRefs) +
        '<button class="assistant-mini-btn" data-request-assistant-task="' + escapeHtml(t.id) + '" data-request-assistant-bundle="' + escapeHtml(t.bundleId || '') + '">Podcast help</button>' +
        '</div>';

      // Assignee name
      var assigneeHtml = '';
      if (t.assigneeId && usersMap[t.assigneeId]) {
        assigneeHtml = '<span class="badge-assignee">' + escapeHtml(usersMap[t.assigneeId].name) + '</span>';
      }

      // Required link input
      var requiredLinkHtml = '';
      if (t.requiredLinkName) {
        requiredLinkHtml = '<span class="required-link-wrapper">' +
          '<span class="required-link-label">' + escapeHtml(t.requiredLinkName) + ':</span>' +
          '<input type="text" class="required-link-input" data-task-id="' + t.id + '" value="' + escapeHtml(t.link || '') + '" placeholder="URL" />' +
          '</span>';
      }
      var actionsHtml = renderDashboardTaskActions(t);

      html += '<tr' + rowClass + ' data-task-row="' + t.id + '">' +
        '<td class="task-status"><input type="checkbox" class="task-status-checkbox" data-task-id="' + t.id + '" data-status="' + (t.status || 'todo') + '"' + checked + checkboxDisabled + ' /></td>' +
        '<td data-label="Date">' + escapeHtml(t.date) + '</td>' +
        '<td class="task-description" data-label="Description">' + renderMarkdownLinks(t.description) + '</td>' +
        '<td data-label="Bundle">' + bundleBadge + '</td>' +
        '<td data-label="Info">' + instructionsHtml + '</td>' +
        '<td data-label="Assignee">' + assigneeHtml + '</td>' +
        '<td data-label="Required Link">' + requiredLinkHtml + '</td>' +
        '<td data-label="Actions">' + actionsHtml + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;

    // Bundle navigation links
    container.querySelectorAll('[data-nav-bundle]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        currentBundleId = el.getAttribute('data-nav-bundle');
        location.hash = '#/bundles';
      });
    });
    bindAssistantLinks(container);

    container.querySelectorAll('[data-request-assistant-task]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var taskId = btn.getAttribute('data-request-assistant-task');
        var bundleId = btn.getAttribute('data-request-assistant-bundle') || undefined;
        var row = btn.closest('[data-task-row]');
        var title = row ? row.querySelector('.task-description').textContent : 'Podcast assistant';
        requestPodcastAssistantForContext({
          taskId: taskId,
          bundleId: bundleId,
          title: title,
        }, loadDashboardTasks);
      });
    });

    // Status toggle via checkboxes
    container.querySelectorAll('.task-status-checkbox').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-task-id');
        var current = cb.getAttribute('data-status');
        var next = current === 'done' ? 'todo' : 'done';
        api.tasks.update(id, { status: next }).then(function () {
          loadDashboardTasks();
        }).catch(function (err) {
          showError('Failed to update task: ' + err.message);
        });
      });
    });

    // Required link input: save on Enter or blur
    container.querySelectorAll('.required-link-input').forEach(function (inp) {
      var saving = false;
      function saveLink() {
        if (saving) return;
        saving = true;
        var taskId = inp.getAttribute('data-task-id');
        var linkValue = inp.value.trim();
        api.tasks.update(taskId, { link: linkValue }).then(function () {
          loadDashboardTasks();
        }).catch(function (err) {
          showError('Failed to save link: ' + err.message);
          saving = false;
        });
      }
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveLink();
        }
      });
      inp.addEventListener('blur', function () {
        saveLink();
      });
      inp.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    });

    container.querySelectorAll('[data-follow-up-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-follow-up-action');
        var taskId = btn.getAttribute('data-task-id');
        if (action === 'response-received') {
          recordResponseReceived(taskId, btn);
        } else if (action === 'follow-up-sent') {
          recordFollowUpSent(taskId, btn, container);
        }
      });
    });
  }

  function renderDashboardTaskActions(task) {
    if (!task || task.status !== 'waiting') return '<span class="task-action-empty">-</span>';
    var taskComment = escapeHtml(task.comment || '');
    return '<div class="task-action-group">' +
      '<button type="button" class="task-action-btn" data-follow-up-action="response-received" data-task-id="' + task.id + '" data-existing-note="' + taskComment + '">Response received</button>' +
      '<label class="follow-up-next-label">Next <input type="date" class="follow-up-next-date" data-task-id="' + task.id + '" value="' + escapeHtml(defaultNextFollowUpDate()) + '" /></label>' +
      '<button type="button" class="task-action-btn" data-follow-up-action="follow-up-sent" data-task-id="' + task.id + '" data-existing-note="' + taskComment + '">Follow-up sent</button>' +
      '</div>';
  }

  function recordResponseReceived(taskId, btn) {
    if (!taskId) return;
    setButtonBusy(btn, true, 'Response received', 'Saving...');
    api.tasks.update(taskId, {
      status: 'todo',
      comment: appendTaskEventComment(btn.getAttribute('data-existing-note') || '', 'Response received')
    }).then(function () {
      showSuccess('Task moved back to todo.');
      refreshBellBadge();
      loadDashboardTasks();
    }).catch(function (err) {
      showError('Failed to update task: ' + err.message);
      setButtonBusy(btn, false, 'Response received');
    });
  }

  function recordFollowUpSent(taskId, btn, container) {
    if (!taskId) return;
    var input = container.querySelector('.follow-up-next-date[data-task-id="' + taskId + '"]');
    var nextDate = input ? input.value : '';
    if (!nextDate) {
      showError('Choose the next follow-up date.');
      return;
    }
    setButtonBusy(btn, true, 'Follow-up sent', 'Saving...');
    api.tasks.update(taskId, {
      status: 'waiting',
      followUpAt: nextDate,
      comment: appendTaskEventComment(btn.getAttribute('data-existing-note') || '', 'Follow-up sent; next follow-up ' + nextDate)
    }).then(function () {
      showSuccess('Follow-up recorded.');
      refreshBellBadge();
      loadDashboardTasks();
    }).catch(function (err) {
      showError('Failed to record follow-up: ' + err.message);
      setButtonBusy(btn, false, 'Follow-up sent');
    });
  }

  function appendTaskEventComment(existing, eventText) {
    var stamp = new Date().toISOString();
    var line = '[' + stamp + '] ' + eventText;
    return existing ? existing + '\n' + line : line;
  }

  function dedupeTasksById(tasks) {
    var seen = {};
    var out = [];
    (tasks || []).forEach(function (task) {
      if (!task || !task.id || seen[task.id]) return;
      seen[task.id] = true;
      out.push(task);
    });
    return out;
  }

  function isDueFollowUpTask(task) {
    if (!task || task.status !== 'waiting' || !task.followUpAt) return false;
    return String(task.followUpAt).slice(0, 10) <= todayString();
  }

  function formatDateLabel(value) {
    var date = String(value || '').slice(0, 10);
    if (!date) return '';
    var today = todayString();
    if (date === today) return 'today';
    return date;
  }

  function defaultNextFollowUpDate() {
    var d = new Date();
    d.setDate(d.getDate() + 2);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // ── Tasks View ──────────────────────────────────────────────────

  var taskState = {
    rangeMode: false,
    date: '',
    startDate: '',
    endDate: '',
    statusFilter: 'all',
    assigneeFilter: '',
    bundleFilter: ''
  };

  // Cached users map: { id: { id, name, email } }
  var usersCache = null;
  // Cached bundles list for filter dropdown
  var bundlesCache = null;

  function loadUsersOnce() {
    if (usersCache) {
      return Promise.resolve(usersCache);
    }
    return api.users.list().then(function (data) {
      var map = {};
      (data.users || []).forEach(function (u) {
        map[u.id] = u;
      });
      usersCache = map;
      return map;
    }).catch(function () {
      usersCache = {};
      return {};
    });
  }

  function loadBundlesOnce() {
    if (bundlesCache) {
      return Promise.resolve(bundlesCache);
    }
    return api.bundles.list().then(function (data) {
      bundlesCache = data.bundles || [];
      return bundlesCache;
    }).catch(function () {
      bundlesCache = [];
      return [];
    });
  }

  function renderTasks() {
    clearApp();

    var today = todayString();
    taskState.date = today;
    taskState.startDate = today;
    taskState.endDate = today;
    taskState.statusFilter = 'all';
    taskState.assigneeFilter = '';
    taskState.bundleFilter = '';

    // Date filter bar
    var header = document.createElement('div');
    header.className = 'task-toolbar';
    header.innerHTML = '<h2>Tasks</h2>' +
      '<input type="date" id="task-date" value="' + today + '" />' +
      '<button class="btn-today" id="btn-today">Today</button>' +
      '<label class="range-toggle">' +
        '<input type="checkbox" id="range-toggle" />' +
        'Range' +
      '</label>' +
      '<span id="range-end-container" class="task-toolbar-range" style="display:none;">' +
        '<span style="font-size:13px;color:#555;">to</span> ' +
        '<input type="date" id="task-date-end" value="' + today + '" />' +
      '</span>';
    app.appendChild(header);

    // Filter bar
    var filterBar = document.createElement('div');
    filterBar.className = 'filter-bar';
    filterBar.innerHTML =
      '<label for="filter-status">Status</label>' +
      '<select id="filter-status">' +
        '<option value="all">All</option>' +
        '<option value="todo">Todo</option>' +
        '<option value="done">Done</option>' +
      '</select>' +
      '<label for="filter-assignee">Assignee</label>' +
      '<select id="filter-assignee"><option value="">All</option></select>' +
      '<label for="filter-bundle">Bundle</label>' +
      '<select id="filter-bundle"><option value="">All (by date)</option></select>';
    app.appendChild(filterBar);

    var dateInput = document.getElementById('task-date');
    var rangeToggle = document.getElementById('range-toggle');
    var rangeEndContainer = document.getElementById('range-end-container');
    var dateEndInput = document.getElementById('task-date-end');
    var statusFilter = document.getElementById('filter-status');
    var assigneeFilter = document.getElementById('filter-assignee');
    var bundleFilterEl = document.getElementById('filter-bundle');

    // Populate assignee dropdown
    loadUsersOnce().then(function (users) {
      Object.keys(users).forEach(function (uid) {
        var opt = document.createElement('option');
        opt.value = uid;
        opt.textContent = users[uid].name;
        assigneeFilter.appendChild(opt);
      });
      // Also populate the create form assignee dropdown
      populateCreateFormAssignee(users);
    });

    // Populate bundle dropdown
    loadBundlesOnce().then(function (bundles) {
      bundles.forEach(function (b) {
        var opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.title || 'Untitled';
        bundleFilterEl.appendChild(opt);
      });
    });

    // Today button
    document.getElementById('btn-today').addEventListener('click', function () {
      var t = todayString();
      dateInput.value = t;
      taskState.date = t;
      if (taskState.rangeMode) {
        taskState.startDate = t;
      }
      syncFormDate();
      reloadTasks();
    });

    // Single date change
    dateInput.addEventListener('change', function () {
      taskState.date = dateInput.value;
      taskState.startDate = dateInput.value;
      syncFormDate();
      reloadTasks();
    });

    // Range toggle
    rangeToggle.addEventListener('change', function () {
      taskState.rangeMode = rangeToggle.checked;
      if (taskState.rangeMode) {
        rangeEndContainer.style.display = '';
        taskState.startDate = dateInput.value;
        taskState.endDate = dateEndInput.value;
      } else {
        rangeEndContainer.style.display = 'none';
      }
      reloadTasks();
    });

    // End date change
    dateEndInput.addEventListener('change', function () {
      taskState.endDate = dateEndInput.value;
      reloadTasks();
    });

    // Status filter
    statusFilter.addEventListener('change', function () {
      taskState.statusFilter = statusFilter.value;
      reloadTasks();
    });

    // Assignee filter
    assigneeFilter.addEventListener('change', function () {
      taskState.assigneeFilter = assigneeFilter.value;
      reloadTasks();
    });

    // Bundle filter
    bundleFilterEl.addEventListener('change', function () {
      taskState.bundleFilter = bundleFilterEl.value;
      reloadTasks();
    });

    // Create form (no comment field, with assignee dropdown)
    var form = document.createElement('div');
    form.className = 'form-section';
    form.innerHTML =
      '<h3>New Task</h3>' +
      '<div class="form-row">' +
        '<div class="form-group">' +
          '<label for="task-desc">Description</label>' +
          '<input type="text" id="task-desc" placeholder="What needs to be done?" style="width:300px;" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="task-date-input">Date</label>' +
          '<input type="date" id="task-date-input" value="' + today + '" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="task-assignee">Assignee</label>' +
          '<select id="task-assignee"><option value="">None</option></select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>&nbsp;</label>' +
          '<button class="btn-primary" id="task-create-btn">Create</button>' +
        '</div>' +
      '</div>';
    app.appendChild(form);

    function populateCreateFormAssignee(users) {
      var sel = document.getElementById('task-assignee');
      if (!sel) return;
      Object.keys(users).forEach(function (uid) {
        var opt = document.createElement('option');
        opt.value = uid;
        opt.textContent = users[uid].name;
        sel.appendChild(opt);
      });
    }

    document.getElementById('task-create-btn').addEventListener('click', function () {
      var btn = document.getElementById('task-create-btn');
      var desc = document.getElementById('task-desc').value.trim();
      var date = document.getElementById('task-date-input').value;
      var assigneeId = document.getElementById('task-assignee').value;
      if (!desc || !date) {
        showError('Description and date are required.');
        return;
      }
      var data = { description: desc, date: date, source: 'manual' };
      if (assigneeId) data.assigneeId = assigneeId;

      btn.disabled = true;
      api.tasks.create(data).then(function () {
        document.getElementById('task-desc').value = '';
        document.getElementById('task-assignee').value = '';
        reloadTasks();
      }).catch(function (err) {
        showError('Failed to create task: ' + err.message);
      }).finally(function () {
        btn.disabled = false;
      });
    });

    // Table container
    var tableContainer = document.createElement('div');
    tableContainer.id = 'tasks-table';
    app.appendChild(tableContainer);

    function syncFormDate() {
      var formDateInput = document.getElementById('task-date-input');
      if (formDateInput) {
        formDateInput.value = taskState.rangeMode ? taskState.startDate : taskState.date;
      }
    }

    function reloadTasks() {
      var params;
      // If bundle filter is set, use bundleId query (ignore date)
      if (taskState.bundleFilter) {
        params = { bundleId: taskState.bundleFilter };
      } else if (taskState.rangeMode) {
        params = { startDate: taskState.startDate, endDate: taskState.endDate };
      } else {
        params = { date: taskState.date };
      }
      loadTasks(params);
    }

    reloadTasks();
  }

  function loadTasks(params) {
    var container = document.getElementById('tasks-table');
    if (!container) return;
    container.innerHTML = '<p>Loading...</p>';

    // Remove old error banners
    var banners = app.querySelectorAll('.error-banner');
    banners.forEach(function (b) { b.remove(); });

    var isBundleQuery = !!params.bundleId;
    var isRange = params.startDate !== undefined;

    // Load tasks and users in parallel
    Promise.all([
      api.tasks.list(params),
      loadUsersOnce()
    ]).then(function (results) {
      var data = results[0];
      var usersMap = results[1];
      var tasks = data.tasks || [];

      // Apply client-side status filter
      if (taskState.statusFilter && taskState.statusFilter !== 'all') {
        tasks = tasks.filter(function (t) {
          return t.status === taskState.statusFilter;
        });
      }

      // Apply client-side assignee filter
      if (taskState.assigneeFilter) {
        tasks = tasks.filter(function (t) {
          return t.assigneeId === taskState.assigneeFilter;
        });
      }

      if (tasks.length === 0) {
        var msg = isBundleQuery
          ? 'No tasks found for this bundle.'
          : isRange
            ? 'No tasks found for this date range.'
            : 'No tasks found for this date.';
        container.innerHTML = renderEmptyState(
          msg,
          isRange ? 'Try a wider date range or adjust the filters.' : 'Adjust the filters or create a task for this date.',
          []
        );
        return;
      }

      // Sort by date ascending
      tasks.sort(function (a, b) {
        if (a.date < b.date) return -1;
        if (a.date > b.date) return 1;
        return 0;
      });

      // Collect unique bundleIds and fetch bundle titles
      var bundleIds = [];
      tasks.forEach(function (t) {
        if (t.bundleId && bundleIds.indexOf(t.bundleId) === -1) {
          bundleIds.push(t.bundleId);
        }
      });

      var bundlePromises = bundleIds.map(function (bid) {
        return api.bundles.get(bid).then(function (data) {
          return { id: bid, title: data.bundle.title || 'Untitled' };
        }).catch(function () {
          return { id: bid, title: 'Unknown' };
        });
      });

      Promise.all(bundlePromises).then(function (bundleResults) {
        var bundleMap = {};
        bundleResults.forEach(function (b) {
          bundleMap[b.id] = b.title;
        });

        renderTaskTable(tasks, bundleMap, usersMap, container, params);
      });
    }).catch(function (err) {
      container.innerHTML = '';
      showError('Failed to load tasks: ' + err.message);
    });
  }

  function renderTaskTable(tasks, bundleMap, usersMap, container, params) {
      var html = '<table class="task-table-compact"><thead><tr>' +
        '<th></th><th>Date</th><th>Description</th><th>Bundle</th><th>Info</th><th>Assignee</th><th>Required Link</th>' +
        '</tr></thead><tbody>';
      tasks.forEach(function (t) {
        var isDone = t.status === 'done';
        var rowClass = isDone ? ' class="task-done"' : '';
        var checked = isDone ? ' checked' : '';

        // Checkbox disabled if requiredLinkName is set and link is empty
        var checkboxDisabled = '';
        var artifactBlockTitle = taskArtifactBlockTitle(t);
        if (t.requiredLinkName && !t.link) {
          checkboxDisabled = ' disabled title="Fill in ' + escapeHtml(t.requiredLinkName) + ' link first"';
        } else if (artifactBlockTitle) {
          checkboxDisabled = ' disabled title="' + escapeHtml(artifactBlockTitle) + '"';
        }

        // Bundle badge
        var bundleBadge;
        if (t.bundleId && bundleMap[t.bundleId]) {
          bundleBadge = renderBundleBadgeLink(t.bundleId, bundleMap[t.bundleId]);
        } else {
          bundleBadge = '<span class="badge-adhoc">ad hoc</span>';
        }

        // Instructions link icon
        var instructionsHtml = '';
        if (t.instructionDocId) {
          instructionsHtml = renderInstructionLink(processDocUrl(t.instructionDocId), t.description);
        } else if (t.instructionsUrl) {
          instructionsHtml = renderInstructionLink(t.instructionsUrl, t.description);
        }
        var assistantHtml = '<div class="assistant-context-row">' +
          renderAssistantRefs(t.assistantJobRefs) +
          '<button class="assistant-mini-btn" data-request-assistant-task="' + escapeHtml(t.id) + '" data-request-assistant-bundle="' + escapeHtml(t.bundleId || '') + '">Podcast help</button>' +
          '</div>';

        // Assignee name
        var assigneeHtml = '';
        if (t.assigneeId && usersMap[t.assigneeId]) {
          assigneeHtml = '<span class="badge-assignee">' + escapeHtml(usersMap[t.assigneeId].name) + '</span>';
        }

        // Required link input
        var requiredLinkHtml = '';
        if (t.requiredLinkName) {
          requiredLinkHtml = '<span class="required-link-wrapper">' +
            '<span class="required-link-label">' + escapeHtml(t.requiredLinkName) + ':</span>' +
            '<input type="text" class="required-link-input" data-task-id="' + t.id + '" value="' + escapeHtml(t.link || '') + '" placeholder="URL" />' +
            '</span>';
        }

        html += '<tr' + rowClass + ' data-task-row="' + t.id + '">' +
          '<td class="task-status"><input type="checkbox" class="task-status-checkbox" data-task-id="' + t.id + '" data-status="' + (t.status || 'todo') + '"' + checked + checkboxDisabled + ' /></td>' +
          '<td data-label="Date">' + escapeHtml(t.date) + '</td>' +
          '<td class="task-description editable" data-label="Description" data-field="description" data-task-id="' + t.id + '">' + renderMarkdownLinks(t.description) + '</td>' +
          '<td data-label="Bundle">' + bundleBadge + '</td>' +
          '<td data-label="Info">' + instructionsHtml + assistantHtml + '</td>' +
          '<td data-label="Assignee">' + assigneeHtml + '</td>' +
          '<td data-label="Required Link">' + requiredLinkHtml + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;

      // Bundle navigation links
      container.querySelectorAll('[data-nav-bundle]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          currentBundleId = el.getAttribute('data-nav-bundle');
          location.hash = '#/bundles';
        });
      });
      bindAssistantLinks(container);

      container.querySelectorAll('[data-request-assistant-task]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var taskId = btn.getAttribute('data-request-assistant-task');
          var bundleId = btn.getAttribute('data-request-assistant-bundle') || undefined;
          var row = btn.closest('[data-task-row]');
          var title = row ? row.querySelector('.task-description').textContent : 'Podcast assistant';
          requestPodcastAssistantForContext({
            taskId: taskId,
            bundleId: bundleId,
            title: title,
          }, function () {
            loadTasks(params);
          });
        });
      });

      // Status toggle via checkboxes
      container.querySelectorAll('.task-status-checkbox').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var id = cb.getAttribute('data-task-id');
          var current = cb.getAttribute('data-status');
          var next = current === 'done' ? 'todo' : 'done';
          api.tasks.update(id, { status: next }).then(function () {
            loadTasks(params);
          }).catch(function (err) {
            showError('Failed to update task: ' + err.message);
          });
        });
      });

      // Required link input: save on Enter or blur
      container.querySelectorAll('.required-link-input').forEach(function (inp) {
        var saving = false;
        function saveLink() {
          if (saving) return;
          saving = true;
          var taskId = inp.getAttribute('data-task-id');
          var linkValue = inp.value.trim();
          api.tasks.update(taskId, { link: linkValue }).then(function () {
            loadTasks(params);
          }).catch(function (err) {
            showError('Failed to save link: ' + err.message);
            saving = false;
          });
        }
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            saveLink();
          }
        });
        inp.addEventListener('blur', function () {
          saveLink();
        });
        // Prevent click from triggering row editable behavior
        inp.addEventListener('click', function (e) {
          e.stopPropagation();
        });
      });

      // Inline editing for description
      container.querySelectorAll('td.editable').forEach(function (cell) {
        cell.addEventListener('click', function () {
          // Prevent opening a second editor
          if (cell.querySelector('input')) return;

          var field = cell.getAttribute('data-field');
          var taskId = cell.getAttribute('data-task-id');
          var originalValue = cell.textContent;

          var input = document.createElement('input');
          input.type = 'text';
          input.className = 'inline-edit-input';
          input.value = originalValue;

          cell.textContent = '';
          cell.appendChild(input);
          input.focus();
          input.select();

          var saving = false;

          function save() {
            if (saving) return;
            var newValue = input.value.trim();

            // Description cannot be empty
            if (field === 'description' && newValue === '') {
              cancel();
              return;
            }

            // If unchanged, just cancel
            if (newValue === originalValue) {
              cancel();
              return;
            }

            saving = true;
            var updateData = {};
            updateData[field] = newValue;
            api.tasks.update(taskId, updateData).then(function () {
              loadTasks(params);
            }).catch(function (err) {
              showError('Failed to update task: ' + err.message);
              cancel();
            });
          }

          function cancel() {
            cell.textContent = originalValue;
          }

          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          });

          input.addEventListener('blur', function () {
            if (!saving) {
              save();
            }
          });
        });
      });
  }

  // ── Bundles View ───────────────────────────────────────────────

  var currentBundleId = null;
  var bundleState = {
    search: ''
  };

  function renderBundles() {
    clearApp();

    if (currentBundleId) {
      renderBundleDetail(currentBundleId);
      return;
    }

    var header = document.createElement('div');
    header.className = 'page-header';
    header.innerHTML =
      '<div>' +
        '<h2>Bundles</h2>' +
        '<div class="page-subtitle" id="bundle-count">Active and archived work packages</div>' +
      '</div>' +
      '<div class="page-actions">' +
        '<input type="search" id="bundle-search" class="search-input" placeholder="Search bundles" value="' + escapeHtml(bundleState.search) + '" />' +
      '</div>';
    app.appendChild(header);

    document.getElementById('bundle-search').addEventListener('input', function (e) {
      bundleState.search = e.target.value.trim().toLowerCase();
      loadBundles();
    });

    // Create form
    var podcastForm = document.createElement('div');
    podcastForm.className = 'podcast-start-section';
    podcastForm.innerHTML =
      '<h3>Start Podcast Workflow</h3>' +
      '<div class="form-row">' +
        '<div class="form-group">' +
          '<label for="podcast-topic">Topic or title</label>' +
          '<input type="text" id="podcast-topic" placeholder="Episode topic" style="width:220px;" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="podcast-guest">Guest</label>' +
          '<input type="text" id="podcast-guest" placeholder="Guest name" style="width:180px;" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="podcast-anchor">Live stream date</label>' +
          '<input type="date" id="podcast-anchor" value="' + todayString() + '" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="podcast-email">Guest email</label>' +
          '<input type="text" id="podcast-email" placeholder="Optional" style="width:180px;" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="podcast-source-note">Source note</label>' +
          '<input type="text" id="podcast-source-note" placeholder="Optional context" style="width:220px;" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label>&nbsp;</label>' +
          '<button class="btn-primary" id="podcast-start-btn" disabled aria-busy="true">Loading Podcast...</button>' +
        '</div>' +
      '</div>';
    app.appendChild(podcastForm);
    bindPodcastStartForm();

    var form = document.createElement('div');
    form.className = 'form-section';
    form.innerHTML =
      '<h3>New Bundle</h3>' +
      '<div class="form-row">' +
        '<div class="form-group">' +
          '<label for="bundle-title">Title</label>' +
          '<input type="text" id="bundle-title" placeholder="Bundle title" style="width:250px;" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="bundle-anchor">Anchor Date</label>' +
          '<input type="date" id="bundle-anchor" value="' + todayString() + '" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="bundle-desc">Description</label>' +
          '<input type="text" id="bundle-desc" placeholder="Optional" style="width:250px;" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="bundle-template">Template</label>' +
          '<select id="bundle-template"><option value="">No template</option></select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>&nbsp;</label>' +
          '<button class="btn-primary" id="bundle-create-btn">Create</button>' +
        '</div>' +
      '</div>';
    app.appendChild(form);

    // Populate template dropdown
    loadTemplateDropdown();

    document.getElementById('bundle-create-btn').addEventListener('click', function () {
      var btn = document.getElementById('bundle-create-btn');
      var title = document.getElementById('bundle-title').value.trim();
      var anchorDate = document.getElementById('bundle-anchor').value;
      var description = document.getElementById('bundle-desc').value.trim();
      var templateId = document.getElementById('bundle-template').value;
      if (!title || !anchorDate) {
        showError('Title and anchor date are required.');
        return;
      }
      var data = { title: title, anchorDate: anchorDate };
      if (description) data.description = description;
      if (templateId) data.templateId = templateId;
      setButtonBusy(btn, true, 'Create', 'Creating...');
      var cardsContainer = document.getElementById('bundles-table');
      if (cardsContainer) cardsContainer.innerHTML = '<p>Creating bundle...</p>';
      api.bundles.create(data).then(function () {
        document.getElementById('bundle-title').value = '';
        document.getElementById('bundle-desc').value = '';
        document.getElementById('bundle-template').value = '';
        bundleState.search = title.toLowerCase();
        var search = document.getElementById('bundle-search');
        if (search) search.value = bundleState.search;
        showSuccess('Bundle created.');
        loadBundles();
      }).catch(function (err) {
        showError('Failed to create bundle: ' + err.message);
      }).finally(function () {
        setButtonBusy(btn, false, 'Create');
      });
    });

    var cardsContainer = document.createElement('div');
    cardsContainer.id = 'bundles-table';
    app.appendChild(cardsContainer);

    loadBundles();
  }

  function bindPodcastStartForm() {
    var btn = document.getElementById('podcast-start-btn');
    if (!btn) return;
    var podcastTemplate = null;
    var templateReady = false;
    function setPodcastStartUnavailable(label) {
      templateReady = false;
      btn.disabled = true;
      btn.textContent = label;
      btn.removeAttribute('aria-busy');
    }
    function setPodcastStartReady(template) {
      podcastTemplate = template;
      templateReady = true;
      btn.disabled = false;
      btn.textContent = 'Start Podcast';
      btn.removeAttribute('aria-busy');
    }
    api.templates.list().then(function (data) {
      var templates = data.templates || [];
      podcastTemplate = findPodcastTemplate(templates);
      if (!podcastTemplate) {
        setPodcastStartUnavailable('Podcast template missing');
      } else {
        setPodcastStartReady(podcastTemplate);
      }
    }).catch(function () {
      setPodcastStartUnavailable('Podcast template unavailable');
    });

    btn.addEventListener('click', function () {
      var topic = document.getElementById('podcast-topic').value.trim();
      var guest = document.getElementById('podcast-guest').value.trim();
      var anchorDate = document.getElementById('podcast-anchor').value;
      var guestEmail = document.getElementById('podcast-email').value.trim();
      var sourceNote = document.getElementById('podcast-source-note').value.trim();
      if (!templateReady || !podcastTemplate) {
        showError('Podcast template is not available.');
        return;
      }
      if (!topic || !guest || !anchorDate) {
        showError('Topic, guest, and live stream date are required.');
        return;
      }
      var title = 'Podcast: ' + anchorDate + ' - ' + topic + ' - ' + guest;
      var descriptionParts = ['Guest: ' + guest, 'Topic: ' + topic];
      if (guestEmail) descriptionParts.push('Guest email: ' + guestEmail);
      if (sourceNote) descriptionParts.push('Source note: ' + sourceNote);

      setButtonBusy(btn, true, 'Start Podcast', 'Starting...');
      api.bundles.create({
        title: title,
        anchorDate: anchorDate,
        description: descriptionParts.join('\n'),
        templateId: podcastTemplate.id,
      }).then(function (created) {
        var bundle = created.bundle;
        var tasks = created.tasks || [];
        if (!guestEmail) return { bundle: bundle, tasks: tasks };
        return seedRequiredLinkFromLaunch(bundle, tasks, 'Guest email', guestEmail).then(function () {
          return { bundle: bundle, tasks: tasks };
        });
      }).then(function (created) {
        bundlesCache = null;
        currentBundleId = created.bundle.id;
        showSuccess('Podcast workflow started.');
        renderBundles();
      }).catch(function (err) {
        showError('Failed to start Podcast workflow: ' + err.message);
      }).finally(function () {
        if (templateReady && podcastTemplate) {
          setButtonBusy(btn, false, 'Start Podcast');
        } else {
          setPodcastStartUnavailable('Podcast template unavailable');
        }
      });
    });
  }

  function findPodcastTemplate(templates) {
    function taskCount(template) {
      return (template.taskDefinitions && template.taskDefinitions.length) || 0;
    }
    function hasPodcastTag(template) {
      return Array.isArray(template.tags) && template.tags.indexOf('podcast') !== -1;
    }
    function hasPodcastSource(template) {
      return Array.isArray(template.sourceDocIds) && template.sourceDocIds.indexOf('task-template.tasks.podcast') !== -1;
    }
    function nameIsPodcast(template) {
      return String(template.name || '').trim().toLowerCase() === 'podcast';
    }
    return templates.find(function (template) {
      return template.type === 'podcast' && taskCount(template) >= 40;
    }) || templates.find(hasPodcastSource) || templates.find(function (template) {
      return nameIsPodcast(template) && taskCount(template) >= 40;
    }) || templates.find(function (template) {
      return hasPodcastTag(template) && taskCount(template) >= 40;
    }) || templates.find(function (template) {
      return template.type === 'podcast';
    }) || null;
  }

  function seedRequiredLinkFromLaunch(bundle, tasks, linkName, url) {
    var updates = [];
    var existingLinks = bundle.bundleLinks || [];
    var nextLinks = updateBundleLinksByName(existingLinks, linkName, url);
    updates.push(api.bundles.update(bundle.id, { bundleLinks: nextLinks }));
    var task = (tasks || []).find(function (item) {
      return item.requiredLinkName === linkName;
    });
    if (task) {
      updates.push(api.tasks.update(task.id, { link: url }));
    }
    return Promise.all(updates);
  }

  function updateBundleLinksByName(links, name, url) {
    var matched = false;
    var next = (links || []).map(function (link) {
      if (link.name === name) {
        matched = true;
        return { name: link.name, url: url };
      }
      return { name: link.name, url: link.url };
    });
    if (!matched) next.push({ name: name, url: url });
    return next;
  }

  function loadTemplateDropdown() {
    var select = document.getElementById('bundle-template');
    if (!select) return;
    api.templates.list().then(function (data) {
      var templates = data.templates || [];
      templates.forEach(function (t) {
        var taskCount = (t.taskDefinitions && t.taskDefinitions.length) || 0;
        var option = document.createElement('option');
        option.value = t.id;
        option.textContent = (t.name || 'Unnamed') + ' (' + taskCount + ' tasks)';
        select.appendChild(option);
      });
    }).catch(function () {
      // Gracefully handle — dropdown just shows "No template"
    });
  }

  function loadBundles() {
    var container = document.getElementById('bundles-table');
    if (!container) return;
    container.innerHTML = '<p>Loading...</p>';

    var banners = app.querySelectorAll('.error-banner');
    banners.forEach(function (b) { b.remove(); });

    api.bundles.list().then(function (data) {
      var bundles = data.bundles || [];
      var totalCount = bundles.length;
      var countEl = document.getElementById('bundle-count');
      if (countEl) {
        countEl.textContent = totalCount + ' bundle' + (totalCount !== 1 ? 's' : '') + ' available';
      }
      if (bundles.length === 0) {
        container.innerHTML = renderEmptyState(
          'No bundles yet',
          'Use the form above to create a bundle from scratch or instantiate one from a template.',
          []
        );
        return;
      }

      if (bundleState.search) {
        bundles = bundles.filter(function (b) {
          var haystack = [
            b.title || '',
            b.description || '',
            b.anchorDate || '',
            b.status || '',
            b.stage || '',
            (b.tags || []).join(' ')
          ].join(' ').toLowerCase();
          return haystack.indexOf(bundleState.search) !== -1;
        });
      }

      if (countEl) {
        countEl.textContent = bundles.length + ' of ' + totalCount + ' bundle' + (totalCount !== 1 ? 's' : '') + ' shown';
      }

      if (bundles.length === 0) {
        container.innerHTML = renderEmptyState(
          'No bundles match your search',
          'Clear or broaden the search to see more bundles.',
          []
        );
        return;
      }

      // Fetch tasks for each bundle to compute progress
      var taskPromises = bundles.map(function (b) {
        return api.bundles.tasks(b.id).then(function (taskData) {
          return { bundleId: b.id, tasks: taskData.tasks || [] };
        }).catch(function () {
          return { bundleId: b.id, tasks: [] };
        });
      });

      Promise.all(taskPromises).then(function (taskResults) {
        var taskMap = {};
        taskResults.forEach(function (r) {
          taskMap[r.bundleId] = r.tasks;
        });

        container.innerHTML = '';
        var cardsDiv = document.createElement('div');
        cardsDiv.className = 'bundle-cards';

        bundles.forEach(function (b) {
          var tasks = taskMap[b.id] || [];
          var doneCount = tasks.filter(function (t) { return t.status === 'done'; }).length;
          var totalCount = tasks.length;
          var badgeClass = 'progress-badge' + (totalCount > 0 && doneCount === totalCount ? ' all-done' : '');

          var descText = b.description || '';
          var truncatedDesc = descText.length > 100 ? descText.substring(0, 100) + '...' : descText;

          var card = document.createElement('div');
          card.className = 'bundle-card';
          card.setAttribute('data-card-bundle-id', b.id);
          card.innerHTML =
            '<a class="bundle-card-title" href="#/bundles" data-bundle-id="' + b.id + '" aria-label="Open bundle ' + escapeHtml(b.title || 'Untitled') + '">' + escapeHtml(b.title) + '</a>' +
            '<div class="bundle-card-date">' + escapeHtml(b.anchorDate || '') + '</div>' +
            (truncatedDesc ? '<div class="bundle-card-desc">' + escapeHtml(truncatedDesc) + '</div>' : '') +
            '<div class="bundle-card-footer">' +
              '<span class="' + badgeClass + '">' + doneCount + ' / ' + totalCount + ' done</span>' +
              '<div class="card-footer-actions">' +
                '<a class="card-action-link" href="#/bundles" data-bundle-id="' + b.id + '">Open bundle</a>' +
                '<button class="btn-danger" data-delete-bundle="' + b.id + '">Delete</button>' +
              '</div>' +
            '</div>';
          cardsDiv.appendChild(card);
        });

        container.appendChild(cardsDiv);

        container.querySelectorAll('.bundle-card').forEach(function (cardEl) {
          cardEl.addEventListener('click', function (e) {
            if (e.target.closest('button')) return;
            if (e.target.closest('[data-bundle-id]')) return;
            currentBundleId = cardEl.getAttribute('data-card-bundle-id');
            renderBundles();
          });
        });

        // Click on bundle title -> detail view
        container.querySelectorAll('[data-bundle-id]').forEach(function (el) {
          el.addEventListener('click', function (e) {
            e.preventDefault();
            currentBundleId = el.getAttribute('data-bundle-id');
            renderBundles();
          });
        });

        // Delete bundle
        container.querySelectorAll('[data-delete-bundle]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.getAttribute('data-delete-bundle');
            var titleEl = btn.closest('.bundle-card').querySelector('.bundle-card-title');
            var title = titleEl ? titleEl.textContent : 'this bundle';
            if (!confirm('Delete bundle: "' + title + '"?')) return;
            setButtonBusy(btn, true, 'Delete', 'Deleting...');
            api.bundles.delete(id).then(function () {
              showSuccess('Bundle deleted.');
              loadBundles();
            }).catch(function (err) {
              showError('Failed to delete bundle: ' + err.message);
              setButtonBusy(btn, false, 'Delete');
            });
          });
        });
      });
    }).catch(function (err) {
      container.innerHTML = '';
      showError('Failed to load bundles: ' + err.message);
    });
  }

  // Stage transition map: current stage -> { label, nextStage }
  var stageTransitions = {
    'preparation': { label: 'Mark Announced', nextStage: 'announced' },
    'announced': { label: 'Mark After-Event', nextStage: 'after-event' },
    'after-event': { label: 'Mark Done', nextStage: 'done' },
  };

  function renderBundleDetail(bundleId) {
    var backBtn = document.createElement('button');
    backBtn.className = 'btn-back';
    backBtn.textContent = '\u2190 Back to Home';
    backBtn.addEventListener('click', function () {
      currentBundleId = null;
      location.hash = '#/';
    });
    app.appendChild(backBtn);

    var detailContainer = document.createElement('div');
    detailContainer.id = 'bundle-detail';
    detailContainer.innerHTML = '<p>Loading...</p>';
    app.appendChild(detailContainer);

    loadBundleDetail(bundleId);
  }

  function loadBundleDetail(bundleId) {
    var container = document.getElementById('bundle-detail');
    if (!container) return;

    var banners = app.querySelectorAll('.error-banner');
    banners.forEach(function (b) { b.remove(); });

    // Load bundle, tasks, and users in parallel
    Promise.all([
      api.bundles.get(bundleId),
      api.bundles.tasks(bundleId),
      loadUsersOnce(),
      api.assistantJobs.list({ bundleId: bundleId }),
      api.artifacts.list({ bundleId: bundleId })
    ]).then(function (results) {
      var bundle = results[0].bundle;
      var tasks = results[1].tasks || [];
      var usersMap = results[2];
      var assistantJobs = results[3].jobs || [];
      var artifacts = results[4].artifacts || [];

      // Sort tasks by date ascending
      tasks.sort(function (a, b) {
        return (a.date || '').localeCompare(b.date || '');
      });

      var doneCount = tasks.filter(function (t) { return t.status === 'done'; }).length;
      var totalCount = tasks.length;
      var fileTasks = tasks.filter(function (task) { return task.requiresFile; });
      return Promise.all(fileTasks.map(function (task) {
        return api.files.list({ taskId: task.id }).then(function (data) {
          return { taskId: task.id, files: data.files || [] };
        }).catch(function () {
          return { taskId: task.id, files: [] };
        });
      })).then(function (fileResults) {
        var filesByTask = {};
        fileResults.forEach(function (result) {
          filesByTask[result.taskId] = result.files;
        });
        return {
          bundle: bundle,
          tasks: tasks,
          usersMap: usersMap,
          assistantJobs: assistantJobs,
          artifacts: artifacts,
          doneCount: doneCount,
          totalCount: totalCount,
          filesByTask: filesByTask,
        };
      });
    }).then(function (detail) {
      var bundle = detail.bundle;
      var tasks = detail.tasks;
      var usersMap = detail.usersMap;
      var assistantJobs = detail.assistantJobs;
      var artifacts = detail.artifacts;
      var doneCount = detail.doneCount;
      var totalCount = detail.totalCount;
      var filesByTask = detail.filesByTask;

      container.innerHTML = '';

      // ── Header: emoji + title ──
      var headerDiv = document.createElement('div');
      headerDiv.className = 'bundle-detail-header';

      var titleEl = document.createElement('h2');
      titleEl.textContent = (bundle.emoji ? bundle.emoji + ' ' : '') + (bundle.title || '');
      headerDiv.appendChild(titleEl);
      container.appendChild(headerDiv);

      // ── Badges row: anchor date, stage, status, progress ──
      var badgesDiv = document.createElement('div');
      badgesDiv.className = 'bundle-detail-badges';

      if (bundle.anchorDate) {
        var anchorBadge = document.createElement('span');
        anchorBadge.className = 'badge-anchor-date';
        anchorBadge.textContent = bundle.anchorDate;
        badgesDiv.appendChild(anchorBadge);
      }

      var stage = bundle.stage || 'preparation';
      var stageBadge = document.createElement('span');
      stageBadge.className = 'badge-stage ' + stage;
      stageBadge.textContent = stage === 'after-event' ? 'after-event' : stage;
      stageBadge.setAttribute('data-testid', 'stage-badge');
      badgesDiv.appendChild(stageBadge);

      // Stage transition button
      var transition = stageTransitions[stage];
      if (transition) {
        var stageBtn = document.createElement('button');
        stageBtn.className = 'btn-stage';
        stageBtn.textContent = transition.label;
        stageBtn.setAttribute('data-testid', 'stage-transition-btn');
        stageBtn.addEventListener('click', function () {
          api.bundles.update(bundleId, { stage: transition.nextStage }).then(function () {
            loadBundleDetail(bundleId);
          }).catch(function (err) {
            showError('Failed to update stage: ' + err.message);
          });
        });
        badgesDiv.appendChild(stageBtn);
      }

      var statusBadge = document.createElement('span');
      statusBadge.className = 'badge-status ' + (bundle.status || 'active');
      statusBadge.textContent = bundle.status || 'active';
      badgesDiv.appendChild(statusBadge);

      var progressBadgeClass = 'progress-badge' + (totalCount > 0 && doneCount === totalCount ? ' all-done' : '');
      var progressBadge = document.createElement('span');
      progressBadge.className = progressBadgeClass;
      progressBadge.textContent = doneCount + '/' + totalCount + ' done';
      progressBadge.setAttribute('data-testid', 'progress-badge');
      badgesDiv.appendChild(progressBadge);

      container.appendChild(badgesDiv);

      // ── Description ──
      if (bundle.description) {
        var descDiv = document.createElement('div');
        descDiv.className = 'bundle-detail-desc';
        descDiv.innerHTML = renderMarkdownLinks(bundle.description);
        container.appendChild(descDiv);
      }

      var contextSection = document.createElement('div');
      contextSection.className = 'workflow-context-panel';
      contextSection.setAttribute('data-testid', 'workflow-context');
      contextSection.innerHTML = renderWorkflowContext(bundle, tasks, filesByTask);
      container.appendChild(contextSection);

      // ── References section (read-only) ──
      var refs = bundle.references || [];
      if (refs.length > 0) {
        var refsSection = document.createElement('div');
        refsSection.className = 'references-section';
        var refsHeader = document.createElement('h3');
        refsHeader.textContent = 'References';
        refsSection.appendChild(refsHeader);

        refs.forEach(function (ref) {
          var a = document.createElement('a');
          a.className = 'reference-link';
          a.href = ref.url || '#';
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = ref.name || ref.url;
          refsSection.appendChild(a);
        });

        container.appendChild(refsSection);
      }

      // ── Bundle Links section (editable) ──
      var bundleLinksSection = document.createElement('div');
      bundleLinksSection.className = 'bundle-links-editable';
      var blHeader = document.createElement('h3');
      blHeader.textContent = 'Bundle Links';
      bundleLinksSection.appendChild(blHeader);

      var currentBundleLinks = bundle.bundleLinks || [];

      currentBundleLinks.forEach(function (bl, idx) {
        var row = document.createElement('div');
        var isEmpty = !bl.url || !bl.url.trim();
        row.className = 'bundle-link-row' + (isEmpty ? ' bundle-link-row--empty' : '');

        var label = document.createElement('span');
        label.className = 'bundle-link-label';
        label.textContent = bl.name;
        row.appendChild(label);

        var urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'bundle-link-url-input';
        urlInput.placeholder = 'https://...';
        urlInput.value = bl.url || '';
        urlInput.setAttribute('data-link-index', idx);
        row.appendChild(urlInput);

        var saveBtn = document.createElement('button');
        saveBtn.className = 'btn-save-link';
        saveBtn.textContent = 'Save';
        saveBtn.setAttribute('data-link-save-index', idx);
        saveBtn.addEventListener('click', function () {
          var newUrl = urlInput.value.trim();
          var updatedLinks = currentBundleLinks.map(function (link, i) {
            if (i === idx) {
              return { name: link.name, url: newUrl };
            }
            return { name: link.name, url: link.url };
          });
          api.bundles.update(bundleId, { bundleLinks: updatedLinks }).then(function () {
            loadBundleDetail(bundleId);
          }).catch(function (err) {
            showError('Failed to save link: ' + err.message);
          });
        });
        row.appendChild(saveBtn);

        bundleLinksSection.appendChild(row);
      });

      // Add link form
      var addLinkForm = document.createElement('div');
      addLinkForm.className = 'add-link-form';
      addLinkForm.innerHTML =
        '<input type="text" id="add-bl-name" placeholder="Link name" style="width:130px;" />' +
        '<input type="text" id="add-bl-url" placeholder="https://..." style="width:250px;" />' +
        '<button class="btn-primary" id="add-bl-btn" style="padding:5px 12px;font-size:12px;">Add</button>';
      bundleLinksSection.appendChild(addLinkForm);
      container.appendChild(bundleLinksSection);

      var assistantContainer = document.createElement('div');
      assistantContainer.id = 'bundle-assistant-jobs';
      container.appendChild(assistantContainer);
      renderAssistantJobsList(assistantContainer, assistantJobs, {
        title: 'Assistant support for this workflow',
        onDone: function () { loadBundleDetail(bundleId); },
      });

      var artifactsContainer = document.createElement('div');
      artifactsContainer.innerHTML = renderArtifactPanel(artifacts);
      container.appendChild(artifactsContainer);

      // Add link handler
      setTimeout(function () {
        var addBtn = document.getElementById('add-bl-btn');
        if (addBtn) {
          addBtn.addEventListener('click', function () {
            var name = document.getElementById('add-bl-name').value.trim();
            var url = document.getElementById('add-bl-url').value.trim();
            if (!name) {
              showError('Link name is required.');
              return;
            }
            var updatedLinks = currentBundleLinks.map(function (l) {
              return { name: l.name, url: l.url };
            });
            updatedLinks.push({ name: name, url: url || '' });
            api.bundles.update(bundleId, { bundleLinks: updatedLinks }).then(function () {
              loadBundleDetail(bundleId);
            }).catch(function (err) {
              showError('Failed to add link: ' + err.message);
            });
          });
        }
      }, 0);

      // ── Tasks table ──
      var tasksHeader = document.createElement('h3');
      tasksHeader.textContent = 'Tasks';
      tasksHeader.style.marginBottom = '12px';
      container.appendChild(tasksHeader);

      var tasksContainer = document.createElement('div');
      tasksContainer.id = 'bundle-tasks-table';
      container.appendChild(tasksContainer);

      renderBundleTasksTable(bundleId, tasks, usersMap, bundle, filesByTask);
    }).catch(function (err) {
      container.innerHTML = '';
      showError('Failed to load bundle: ' + err.message);
    });
  }

  function renderWorkflowContext(bundle, tasks, filesByTask) {
    var today = todayString();
    var active = tasks.filter(function (task) { return task.status !== 'done'; });
    var overdue = active.filter(function (task) { return task.date && task.date < today; });
    var waiting = active.filter(function (task) { return task.status === 'waiting'; });
    var followUps = waiting.filter(isDueFollowUpTask);
    var missingLinks = (bundle.bundleLinks || []).filter(function (link) { return !link.url; });
    var missingFiles = active.filter(function (task) {
      return task.requiresFile && (!filesByTask[task.id] || filesByTask[task.id].length === 0);
    });
    var nextTasks = active.slice().sort(function (a, b) {
      return (a.date || '').localeCompare(b.date || '');
    }).slice(0, 3);
    return '<div class="workflow-context-grid">' +
      '<div class="workflow-context-metric"><span>Next due</span><strong>' + escapeHtml(nextTasks.map(function (task) { return task.date + ' · ' + task.description; }).join(' | ') || 'None') + '</strong></div>' +
      '<div class="workflow-context-metric"><span>Overdue</span><strong>' + overdue.length + '</strong></div>' +
      '<div class="workflow-context-metric"><span>Waiting</span><strong>' + waiting.length + '</strong></div>' +
      '<div class="workflow-context-metric"><span>Follow-ups due</span><strong>' + followUps.length + '</strong></div>' +
      '<div class="workflow-context-metric"><span>Missing links</span><strong>' + missingLinks.length + '</strong></div>' +
      '<div class="workflow-context-metric"><span>Missing files</span><strong>' + missingFiles.length + '</strong></div>' +
    '</div>';
  }

  function renderBundleTasksTable(bundleId, tasks, usersMap, bundle, filesByTask) {
    var container = document.getElementById('bundle-tasks-table');
    if (!container) return;

    container.innerHTML = '';

    if (tasks.length === 0) {
      container.innerHTML = '<div class="empty-state">No tasks for this bundle.</div>';
      return;
    }

    // Keep backward-compat class on the container div
    container.className = 'bundle-tasks-table task-checklist';

    // Split tasks: active (not done) sorted by date, done at the bottom
    var activeTasks = tasks.filter(function (t) { return t.status !== 'done'; });
    var doneTasks = tasks.filter(function (t) { return t.status === 'done'; });

    function buildTaskRow(t) {
      var isDone = t.status === 'done';
      var hasRequiredLink = !!t.requiredLinkName;
      var linkFilled = !!(t.link && t.link.trim());
      var taskFiles = filesByTask[t.id] || [];
      var fileProofMissing = !!t.requiresFile && taskFiles.length === 0;
      var artifactBlockTitle = taskArtifactBlockTitle(t);
      var checkboxDisabled = (hasRequiredLink && !linkFilled) || fileProofMissing || !!artifactBlockTitle;
      // A task is a milestone if it has stageOnComplete set
      var isMilestone = !!t.stageOnComplete;

      var rowClasses = 'task-checklist-row';
      if (isDone) rowClasses += ' task-done';
      if (isMilestone) rowClasses += ' milestone-task-row';

      var row = document.createElement('div');
      row.className = rowClasses;
      row.setAttribute('data-task-row', t.id);
      if (isMilestone) row.setAttribute('data-testid', 'milestone-task-row');

      // ── Checkbox column ──
      var checkboxCol = document.createElement('div');
      checkboxCol.className = 'task-checklist-checkbox-col';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'task-status-checkbox';
      checkbox.checked = isDone;
      checkbox.disabled = checkboxDisabled;
      if (artifactBlockTitle) checkbox.title = artifactBlockTitle;
      if (fileProofMissing) checkbox.title = 'Attach required file first';
      checkbox.setAttribute('data-task-checkbox', t.id);
      checkbox.addEventListener('change', function () {
        var newStatus = checkbox.checked ? 'done' : 'todo';
        api.tasks.update(t.id, { status: newStatus }).then(function () {
          loadBundleDetail(bundleId);
        }).catch(function (err) {
          showError('Failed to update task: ' + err.message);
          checkbox.checked = !checkbox.checked;
        });
      });
      checkboxCol.appendChild(checkbox);
      row.appendChild(checkboxCol);

      // ── Body column ──
      var body = document.createElement('div');
      body.className = 'task-checklist-body';

      // Main line: description + instructions icon
      var mainLine = document.createElement('div');
      mainLine.className = 'task-checklist-main-line';

      var descSpan = document.createElement('span');
      descSpan.className = 'task-description';
      descSpan.innerHTML = renderMarkdownLinks(t.description || '');
      mainLine.appendChild(descSpan);

      if (t.instructionDocId) mainLine.insertAdjacentHTML('beforeend', renderInstructionLink(processDocUrl(t.instructionDocId), t.description));
      else if (t.instructionsUrl) mainLine.insertAdjacentHTML('beforeend', renderInstructionLink(t.instructionsUrl, t.description));

      body.appendChild(mainLine);

      // Meta line: date + assignee
      var metaLine = document.createElement('div');
      metaLine.className = 'task-checklist-meta';

      if (t.date) {
        var dateSpan = document.createElement('span');
        dateSpan.className = 'task-meta-date';
        dateSpan.textContent = t.date;
        metaLine.appendChild(dateSpan);
      }

      if (t.assigneeId && usersMap[t.assigneeId]) {
        var assigneeBadge = document.createElement('span');
        assigneeBadge.className = 'badge-assignee';
        assigneeBadge.textContent = usersMap[t.assigneeId].name;
        metaLine.appendChild(assigneeBadge);
      }

      if (metaLine.hasChildNodes()) {
        body.appendChild(metaLine);
      }

      body.insertAdjacentHTML('beforeend', renderInstructionContext(t));

      // Required link input inline under description
      if (hasRequiredLink) {
        var wrapper = document.createElement('div');
        wrapper.className = 'required-link-wrapper';
        wrapper.style.marginTop = '4px';

        var linkLabel = document.createElement('span');
        linkLabel.className = 'required-link-label';
        linkLabel.textContent = t.requiredLinkName + ':';
        wrapper.appendChild(linkLabel);

        var linkInput = document.createElement('input');
        linkInput.type = 'text';
        linkInput.className = 'required-link-input';
        linkInput.placeholder = 'https://...';
        linkInput.value = t.link || '';
        linkInput.setAttribute('data-required-link-task', t.id);
        wrapper.appendChild(linkInput);

        var saveReqBtn = document.createElement('button');
        saveReqBtn.className = 'btn-save-link';
        saveReqBtn.textContent = 'Save';
        saveReqBtn.style.fontSize = '11px';
        saveReqBtn.style.padding = '2px 8px';
        saveReqBtn.setAttribute('data-save-required-link', t.id);
        saveReqBtn.addEventListener('click', (function (task) {
          return function () {
            var input = container.querySelector('[data-required-link-task="' + task.id + '"]');
            var newUrl = input ? input.value.trim() : '';

            // Update task link
            var taskUpdatePromise = api.tasks.update(task.id, { link: newUrl });

            // Also update the bundle's bundleLinks entry
            var currentLinks = (bundle.bundleLinks || []).map(function (bl) {
              if (bl.name === task.requiredLinkName) {
                return { name: bl.name, url: newUrl };
              }
              return { name: bl.name, url: bl.url };
            });
            var bundleUpdatePromise = api.bundles.update(bundleId, { bundleLinks: currentLinks });

            Promise.all([taskUpdatePromise, bundleUpdatePromise]).then(function () {
              loadBundleDetail(bundleId);
            }).catch(function (err) {
              showError('Failed to save link: ' + err.message);
            });
          };
        })(t));
        wrapper.appendChild(saveReqBtn);

        body.appendChild(wrapper);
      }

      if (t.requiresFile) {
        var fileWrapper = document.createElement('div');
        fileWrapper.className = 'required-file-wrapper';
        fileWrapper.setAttribute('data-required-file-wrapper', t.id);
        fileWrapper.innerHTML =
          '<span class="required-link-label">Required file:</span>' +
          '<input type="file" class="required-file-input" data-required-file-task="' + escapeHtml(t.id) + '" />' +
          '<button class="btn-save-link" data-upload-required-file="' + escapeHtml(t.id) + '">Attach</button>' +
          (taskFiles.length ? '<span class="proof-present">' + taskFiles.length + ' file' + (taskFiles.length !== 1 ? 's' : '') + ' attached</span>' : '<span class="proof-missing">Missing file</span>');
        body.appendChild(fileWrapper);
      }

      if (t.status === 'waiting') {
        var waitingRow = document.createElement('div');
        waitingRow.className = 'waiting-task-row';
        waitingRow.innerHTML =
          '<span class="badge-waiting">Waiting: ' + escapeHtml(t.waitingFor || 'external reply') + (t.followUpAt ? ' · follow up ' + escapeHtml(formatDateLabel(t.followUpAt)) : '') + '</span>' +
          renderDashboardTaskActions(t);
        body.appendChild(waitingRow);
      } else if (!isDone) {
        var waitForm = document.createElement('div');
        waitForm.className = 'waiting-form';
        waitForm.innerHTML =
          '<input type="text" class="waiting-for-input" data-waiting-for-task="' + escapeHtml(t.id) + '" placeholder="Waiting for" />' +
          '<input type="date" class="waiting-followup-input" data-waiting-followup-task="' + escapeHtml(t.id) + '" value="' + escapeHtml(defaultNextFollowUpDate()) + '" />' +
          '<input type="text" class="waiting-note-input" data-waiting-note-task="' + escapeHtml(t.id) + '" placeholder="Note" />' +
          '<button type="button" class="task-action-btn" data-mark-waiting-task="' + escapeHtml(t.id) + '">Mark waiting</button>';
        body.appendChild(waitForm);
      }

      if (t.artifactRefs && t.artifactRefs.length) {
        body.insertAdjacentHTML('beforeend', renderArtifactRefs(t.artifactRefs));
      }

      var assistantRow = document.createElement('div');
      assistantRow.className = 'assistant-context-row';
      assistantRow.innerHTML = renderAssistantRefs(t.assistantJobRefs);
      var requestAssistantBtn = document.createElement('button');
      requestAssistantBtn.className = 'assistant-mini-btn';
      requestAssistantBtn.type = 'button';
      requestAssistantBtn.textContent = 'Podcast help';
      requestAssistantBtn.addEventListener('click', function () {
        requestPodcastAssistantForContext({
          taskId: t.id,
          bundleId: bundleId,
          title: t.description || bundle.title || 'Podcast assistant',
        }, function () {
          loadBundleDetail(bundleId);
        });
      });
      assistantRow.appendChild(requestAssistantBtn);
      body.appendChild(assistantRow);
      bindAssistantLinks(body);

      row.appendChild(body);
      return row;
    }

    // Render active tasks
    activeTasks.forEach(function (t) {
      container.appendChild(buildTaskRow(t));
    });

    // Render done tasks in a separate section
    if (doneTasks.length > 0) {
      var doneHeading = document.createElement('div');
      doneHeading.className = 'task-section-heading';
      doneHeading.textContent = 'Done (' + doneTasks.length + ')';
      container.appendChild(doneHeading);

      doneTasks.forEach(function (t) {
        container.appendChild(buildTaskRow(t));
      });
    }

    container.querySelectorAll('[data-upload-required-file]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var taskId = btn.getAttribute('data-upload-required-file');
        var input = container.querySelector('[data-required-file-task="' + taskId + '"]');
        if (!input || !input.files || !input.files[0]) {
          showError('Choose a file to attach.');
          return;
        }
        var formData = new FormData();
        formData.append('taskId', taskId);
        formData.append('category', 'document');
        formData.append('file', input.files[0]);
        setButtonBusy(btn, true, 'Attach', 'Attaching...');
        api.files.upload(formData).then(function () {
          showSuccess('File attached.');
          loadBundleDetail(bundleId);
        }).catch(function (err) {
          showError('Failed to attach file: ' + err.message);
          setButtonBusy(btn, false, 'Attach');
        });
      });
    });

    container.querySelectorAll('[data-mark-waiting-task]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var taskId = btn.getAttribute('data-mark-waiting-task');
        var waitingFor = (container.querySelector('[data-waiting-for-task="' + taskId + '"]') || {}).value || '';
        var followUpAt = (container.querySelector('[data-waiting-followup-task="' + taskId + '"]') || {}).value || '';
        var note = (container.querySelector('[data-waiting-note-task="' + taskId + '"]') || {}).value || '';
        waitingFor = waitingFor.trim();
        note = note.trim();
        if (!waitingFor || !followUpAt || !note) {
          showError('Waiting tasks need who, follow-up date, and a note.');
          return;
        }
        setButtonBusy(btn, true, 'Mark waiting', 'Saving...');
        api.tasks.update(taskId, {
          status: 'waiting',
          waitingFor: waitingFor,
          followUpAt: followUpAt,
          comment: appendTaskEventComment('', 'Waiting for ' + waitingFor + ': ' + note)
        }).then(function () {
          showSuccess('Task marked waiting.');
          refreshBellBadge();
          loadBundleDetail(bundleId);
        }).catch(function (err) {
          showError('Failed to mark waiting: ' + err.message);
          setButtonBusy(btn, false, 'Mark waiting');
        });
      });
    });

    container.querySelectorAll('[data-follow-up-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-follow-up-action');
        var taskId = btn.getAttribute('data-task-id');
        if (action === 'response-received') {
          recordResponseReceivedFromWorkflow(taskId, btn, bundleId);
        } else if (action === 'follow-up-sent') {
          recordFollowUpSentFromWorkflow(taskId, btn, container, bundleId);
        }
      });
    });
  }

  function recordResponseReceivedFromWorkflow(taskId, btn, bundleId) {
    if (!taskId) return;
    setButtonBusy(btn, true, 'Response received', 'Saving...');
    api.tasks.update(taskId, {
      status: 'todo',
      comment: appendTaskEventComment(btn.getAttribute('data-existing-note') || '', 'Response received')
    }).then(function () {
      showSuccess('Task moved back to todo.');
      refreshBellBadge();
      loadBundleDetail(bundleId);
    }).catch(function (err) {
      showError('Failed to update task: ' + err.message);
      setButtonBusy(btn, false, 'Response received');
    });
  }

  function recordFollowUpSentFromWorkflow(taskId, btn, container, bundleId) {
    if (!taskId) return;
    var input = container.querySelector('.follow-up-next-date[data-task-id="' + taskId + '"]');
    var nextDate = input ? input.value : '';
    if (!nextDate) {
      showError('Choose the next follow-up date.');
      return;
    }
    setButtonBusy(btn, true, 'Follow-up sent', 'Saving...');
    api.tasks.update(taskId, {
      status: 'waiting',
      followUpAt: nextDate,
      comment: appendTaskEventComment(btn.getAttribute('data-existing-note') || '', 'Follow-up sent; next follow-up ' + nextDate)
    }).then(function () {
      showSuccess('Follow-up recorded.');
      refreshBellBadge();
      loadBundleDetail(bundleId);
    }).catch(function (err) {
      showError('Failed to record follow-up: ' + err.message);
      setButtonBusy(btn, false, 'Follow-up sent');
    });
  }

  function renderAssistantJobsList(container, jobs, options) {
    var title = options && options.title ? options.title : 'Assistant jobs';
    var onDone = options && options.onDone;
    var html = '<div class="assistant-panel" data-testid="assistants-panel"><h3>' + escapeHtml(title) + '</h3>';
    if (!jobs || jobs.length === 0) {
      html += '<div class="empty-state">No assistant jobs for this context.</div></div>';
      container.innerHTML = html;
      return;
    }
    jobs.forEach(function (job) {
      var updated = job.updatedAt ? 'Updated ' + job.updatedAt : '';
      var attempts = 'Attempt ' + (job.attemptCount || 0) + '/' + (job.maxAttempts || 1);
      html += '<div class="assistant-job-row" data-assistant-job-row="' + escapeHtml(job.id) + '">' +
        '<div>' +
          '<div class="assistant-job-title">' + escapeHtml(job.title || job.assistantType || 'Assistant job') + '</div>' +
          '<div class="assistant-job-meta">' + escapeHtml(job.assistantType || 'assistant') + ' &middot; ' + escapeHtml(attempts) + (updated ? ' &middot; ' + escapeHtml(updated) : '') + '</div>' +
          (job.lastError ? '<div class="assistant-job-next">Error: ' + escapeHtml(job.lastError.summary || job.lastError.code || 'Assistant failed') + '</div>' : '') +
        '</div>' +
        '<div>' + renderAssistantStatus(job.status) + '<div class="assistant-job-next">' + escapeHtml(assistantNextAction(job)) + '</div></div>' +
        '<div class="assistant-job-actions">' + assistantJobActionsHtml(job) + '</div>' +
      '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
    bindAssistantActionButtons(container, onDone);
  }

  function renderAssistants() {
    clearApp();
    app.classList.remove('dashboard-wide');

    var header = document.createElement('div');
    header.className = 'page-header';
    header.innerHTML =
      '<div><h2>Assistants</h2><div class="page-subtitle">Workflow support jobs that are running, failed, or need review</div></div>';
    app.appendChild(header);

    var createPanel = document.createElement('div');
    createPanel.className = 'assistant-panel';
    createPanel.innerHTML =
      '<h3>Request podcast help</h3>' +
      '<div class="assistant-create-grid">' +
        '<div class="form-group"><label for="assistant-bundle-select">Workflow</label><select id="assistant-bundle-select"><option value="">Select workflow</option></select></div>' +
        '<div class="form-group"><label for="assistant-task-select">Task</label><select id="assistant-task-select"><option value="">Workflow-level job</option></select></div>' +
        '<div class="form-group"><label for="assistant-title-input">Title</label><input type="text" id="assistant-title-input" placeholder="Podcast prep assistant" /></div>' +
        '<button class="btn-primary" id="assistant-create-btn">Queue job</button>' +
      '</div>';
    app.appendChild(createPanel);

    var queueContainer = document.createElement('div');
    queueContainer.id = 'assistants-queue';
    queueContainer.innerHTML = '<p>Loading...</p>';
    app.appendChild(queueContainer);

    function reloadQueue() {
      api.assistantJobs.list().then(function (data) {
        var jobs = data.jobs || [];
        var riskJobs = jobs.filter(function (job) {
          return ['waiting_approval', 'failed', 'running', 'queued', 'retrying'].indexOf(job.status) !== -1;
        });
        var orderedJobs = riskJobs.concat(jobs.filter(function (job) {
          return riskJobs.indexOf(job) === -1;
        })).slice(0, 40);
        renderAssistantJobsList(queueContainer, orderedJobs, { title: 'Assistant queue', onDone: reloadQueue });
      }).catch(function (err) {
        queueContainer.innerHTML = '';
        showError('Failed to load assistant jobs: ' + err.message);
      });
    }

    function loadTaskOptions(bundleId) {
      var taskSelect = document.getElementById('assistant-task-select');
      taskSelect.innerHTML = '<option value="">Workflow-level job</option>';
      if (!bundleId) return;
      api.bundles.tasks(bundleId).then(function (data) {
        (data.tasks || []).forEach(function (task) {
          var opt = document.createElement('option');
          opt.value = task.id;
          opt.textContent = task.description || task.id;
          taskSelect.appendChild(opt);
        });
      }).catch(function () {});
    }

    api.bundles.list().then(function (data) {
      var bundleSelect = document.getElementById('assistant-bundle-select');
      (data.bundles || []).forEach(function (bundle) {
        var opt = document.createElement('option');
        opt.value = bundle.id;
        opt.textContent = bundle.title || bundle.id;
        bundleSelect.appendChild(opt);
      });
      bundleSelect.addEventListener('change', function () {
        loadTaskOptions(bundleSelect.value);
      });
    }).catch(function () {});

    document.getElementById('assistant-create-btn').addEventListener('click', function () {
      var bundleId = document.getElementById('assistant-bundle-select').value;
      var taskId = document.getElementById('assistant-task-select').value;
      var title = document.getElementById('assistant-title-input').value.trim();
      if (!bundleId && !taskId) {
        showError('Select a workflow or task before requesting assistant help.');
        return;
      }
      requestPodcastAssistantForContext({
        bundleId: bundleId || undefined,
        taskId: taskId || undefined,
        title: title || 'Podcast prep assistant',
      }, reloadQueue);
    });

    reloadQueue();
  }

  // ── Templates View ──────────────────────────────────────────────

  var currentTemplateId = null;
  var templateState = {
    search: ''
  };

  function renderTemplates() {
    clearApp();

    if (currentTemplateId) {
      renderTemplateEditor(currentTemplateId);
      return;
    }

    var header = document.createElement('div');
    header.className = 'page-header';
    header.innerHTML =
      '<div>' +
        '<h2>Templates</h2>' +
        '<div class="page-subtitle" id="template-count">Reusable task blueprints</div>' +
      '</div>' +
      '<div class="page-actions">' +
        '<input type="search" id="template-search" class="search-input" placeholder="Search templates" value="' + escapeHtml(templateState.search) + '" />' +
      '</div>';
    app.appendChild(header);

    document.getElementById('template-search').addEventListener('input', function (e) {
      templateState.search = e.target.value.trim().toLowerCase();
      loadTemplateCards();
    });

    var cardsContainer = document.createElement('div');
    cardsContainer.id = 'templates-container';
    app.appendChild(cardsContainer);

    loadTemplateCards();
  }

  function loadTemplateCards() {
    var container = document.getElementById('templates-container');
    if (!container) return;
    container.innerHTML = '<p>Loading...</p>';

    var banners = app.querySelectorAll('.error-banner');
    banners.forEach(function (b) { b.remove(); });

    api.templates.list().then(function (data) {
      var templates = data.templates || [];
      var totalCount = templates.length;
      var countEl = document.getElementById('template-count');
      if (countEl) {
        countEl.textContent = totalCount + ' template' + (totalCount !== 1 ? 's' : '') + ' available';
      }
      if (templates.length === 0) {
        container.innerHTML = renderEmptyState(
          'No templates yet',
          'Seed or create templates to turn repeatable work into reusable task plans.',
          []
        );
        return;
      }

      if (templateState.search) {
        templates = templates.filter(function (t) {
          var haystack = [
            t.name || '',
            t.type || '',
            t.triggerType || '',
            (t.tags || []).join(' ')
          ].join(' ').toLowerCase();
          return haystack.indexOf(templateState.search) !== -1;
        });
      }

      if (countEl) {
        countEl.textContent = templates.length + ' of ' + totalCount + ' template' + (totalCount !== 1 ? 's' : '') + ' shown';
      }

      if (templates.length === 0) {
        container.innerHTML = renderEmptyState(
          'No templates match your search',
          'Clear or broaden the search to see more templates.',
          []
        );
        return;
      }

      container.innerHTML = '';
      var cardsDiv = document.createElement('div');
      cardsDiv.className = 'template-cards';

      templates.forEach(function (t) {
        var taskCount = (t.taskDefinitions && t.taskDefinitions.length) || 0;
        var triggerType = t.triggerType || 'manual';
        var tags = t.tags || [];

        var card = document.createElement('div');
        card.className = 'template-card';
        card.setAttribute('data-template-id', t.id);

        var titleText = (t.emoji ? t.emoji + ' ' : '') + escapeHtml(t.name || 'Unnamed');
        var titleDiv = document.createElement('div');
        titleDiv.className = 'template-card-title';
        titleDiv.innerHTML = titleText;
        card.appendChild(titleDiv);

        var metaDiv = document.createElement('div');
        metaDiv.className = 'template-card-meta';

        if (t.type) {
          var typeBadge = document.createElement('span');
          typeBadge.className = 'badge-type';
          typeBadge.textContent = t.type;
          metaDiv.appendChild(typeBadge);
        }

        tags.forEach(function (tag) {
          var tagBadge = document.createElement('span');
          tagBadge.className = 'badge-tag';
          tagBadge.textContent = tag;
          metaDiv.appendChild(tagBadge);
        });

        var triggerBadge = document.createElement('span');
        triggerBadge.className = 'badge-trigger ' + triggerType;
        triggerBadge.textContent = triggerType;
        metaDiv.appendChild(triggerBadge);

        card.appendChild(metaDiv);

        var tasksDiv = document.createElement('div');
        tasksDiv.className = 'template-card-tasks';
        tasksDiv.textContent = taskCount + ' task' + (taskCount !== 1 ? 's' : '');

        var footerDiv = document.createElement('div');
        footerDiv.className = 'template-card-footer';
        footerDiv.appendChild(tasksDiv);

        var actionSpan = document.createElement('span');
        actionSpan.className = 'card-action-text';
        actionSpan.textContent = 'Edit template';
        footerDiv.appendChild(actionSpan);
        card.appendChild(footerDiv);

        function openTemplate() {
          currentTemplateId = t.id;
          renderTemplates();
        }

        card.addEventListener('click', openTemplate);
        makeKeyboardCard(card, 'Open template ' + (t.name || 'Unnamed'), openTemplate);

        cardsDiv.appendChild(card);
      });

      container.appendChild(cardsDiv);
    }).catch(function (err) {
      container.innerHTML = '';
      showError('Failed to load templates: ' + err.message);
    });
  }

  function renderTemplateEditor(templateId) {
    var backBtn = document.createElement('button');
    backBtn.className = 'btn-back';
    backBtn.textContent = '\u2190 Back to Templates';
    backBtn.addEventListener('click', function () {
      currentTemplateId = null;
      renderTemplates();
    });
    app.appendChild(backBtn);

    var editorContainer = document.createElement('div');
    editorContainer.id = 'template-editor-container';
    editorContainer.innerHTML = '<p>Loading...</p>';
    app.appendChild(editorContainer);

    // Load template and users in parallel
    Promise.all([
      api.templates.get(templateId),
      api.users.list()
    ]).then(function (results) {
      var template = results[0].template;
      var users = (results[1] && results[1].users) || [];
      buildTemplateEditorForm(template, users, editorContainer);
    }).catch(function (err) {
      editorContainer.innerHTML = '';
      showError('Failed to load template: ' + err.message);
    });
  }

  function buildTemplateEditorForm(template, users, container) {
    container.innerHTML = '';

    var editor = document.createElement('div');
    editor.className = 'template-editor';

    var editorHeader = document.createElement('div');
    editorHeader.className = 'template-editor-header';
    editorHeader.innerHTML =
      '<div>' +
        '<h2>' + escapeHtml(template.name || 'Untitled template') + '</h2>' +
        '<div class="page-subtitle" id="template-editor-summary">Template editor</div>' +
      '</div>';
    editor.appendChild(editorHeader);

    var saveBar = document.createElement('div');
    saveBar.className = 'save-bar template-save-bar';
    saveBar.innerHTML =
      '<button class="btn-primary" id="tpl-save-btn">Save</button>' +
      '<span class="save-feedback" id="tpl-save-feedback">No unsaved changes</span>';
    editor.appendChild(saveBar);

    // ---- Basic Info Section ----
    var basicH3 = document.createElement('h3');
    basicH3.textContent = 'Basic Info';
    editor.appendChild(basicH3);

    var basicRow = document.createElement('div');
    basicRow.className = 'editor-row';
    basicRow.innerHTML =
      '<div class="editor-group">' +
        '<label for="tpl-name">Name</label>' +
        '<input type="text" id="tpl-name" value="' + escapeHtml(template.name || '') + '" style="width:200px;" />' +
      '</div>' +
      '<div class="editor-group">' +
        '<label for="tpl-type">Type</label>' +
        '<input type="text" id="tpl-type" value="' + escapeHtml(template.type || '') + '" style="width:150px;" />' +
      '</div>' +
      '<div class="editor-group">' +
        '<label for="tpl-emoji">Emoji</label>' +
        '<input type="text" id="tpl-emoji" value="' + escapeHtml(template.emoji || '') + '" style="width:60px;" />' +
      '</div>' +
      '<div class="editor-group">' +
        '<label for="tpl-tags">Tags (comma-separated)</label>' +
        '<input type="text" id="tpl-tags" value="' + escapeHtml((template.tags || []).join(', ')) + '" style="width:200px;" />' +
      '</div>' +
      '<div class="editor-group">' +
        '<label for="tpl-assignee">Default Assignee</label>' +
        '<select id="tpl-assignee"></select>' +
      '</div>';
    editor.appendChild(basicRow);

    // Populate assignee dropdown after DOM insertion
    setTimeout(function () {
      var assigneeSelect = document.getElementById('tpl-assignee');
      if (assigneeSelect) {
        assigneeSelect.innerHTML = '<option value="">(none)</option>';
        users.forEach(function (u) {
          var opt = document.createElement('option');
          opt.value = u.id;
          opt.textContent = u.name;
          if (template.defaultAssigneeId === u.id) opt.selected = true;
          assigneeSelect.appendChild(opt);
        });
      }
    }, 0);

    // ---- Trigger Config Section ----
    var triggerH3 = document.createElement('h3');
    triggerH3.textContent = 'Trigger Config';
    editor.appendChild(triggerH3);

    var triggerDiv = document.createElement('div');
    var isAutomatic = template.triggerType === 'automatic';
    triggerDiv.innerHTML =
      '<div class="radio-group">' +
        '<label><input type="radio" name="tpl-trigger" value="manual"' + (!isAutomatic ? ' checked' : '') + ' /> Manual</label>' +
        '<label><input type="radio" name="tpl-trigger" value="automatic"' + (isAutomatic ? ' checked' : '') + ' /> Automatic</label>' +
      '</div>' +
      '<div class="trigger-fields" id="trigger-auto-fields" style="display:' + (isAutomatic ? 'block' : 'none') + ';">' +
        '<div class="editor-row">' +
          '<div class="editor-group">' +
            '<label for="tpl-cron">Cron Expression</label>' +
            '<input type="text" id="tpl-cron" value="' + escapeHtml(template.triggerSchedule || '') + '" style="width:200px;" placeholder="0 9 * * 1" />' +
          '</div>' +
          '<div class="editor-group">' +
            '<label for="tpl-lead-days">Lead Days</label>' +
            '<input type="number" id="tpl-lead-days" value="' + (template.triggerLeadDays != null ? template.triggerLeadDays : '') + '" style="width:100px;" />' +
          '</div>' +
        '</div>' +
        '<div style="font-size:12px;color:#888;margin-top:4px;">Example: 0 9 * * 1 = Every Monday at 9am</div>' +
      '</div>';
    editor.appendChild(triggerDiv);

    // Toggle trigger fields visibility
    setTimeout(function () {
      var radios = document.querySelectorAll('input[name="tpl-trigger"]');
      radios.forEach(function (r) {
        r.addEventListener('change', function () {
          var autoFields = document.getElementById('trigger-auto-fields');
          if (autoFields) {
            autoFields.style.display = r.value === 'automatic' ? 'block' : 'none';
          }
        });
      });
    }, 0);

    // ---- References Section ----
    var refsH3 = document.createElement('h3');
    refsH3.textContent = 'References';
    editor.appendChild(refsH3);

    var refsContainer = document.createElement('div');
    refsContainer.id = 'tpl-references-list';
    editor.appendChild(refsContainer);

    var addRefBtn = document.createElement('button');
    addRefBtn.className = 'btn-add';
    addRefBtn.textContent = '+ Add Reference';
    addRefBtn.addEventListener('click', function () {
      addReferenceRow(refsContainer, '', '');
      notifyTemplateEditorChanged(refsContainer);
    });
    editor.appendChild(addRefBtn);

    // ---- Bundle Link Definitions Section ----
    var bldH3 = document.createElement('h3');
    bldH3.textContent = 'Bundle Link Definitions';
    editor.appendChild(bldH3);

    var bldContainer = document.createElement('div');
    bldContainer.id = 'tpl-bundlelinks-list';
    editor.appendChild(bldContainer);

    var addBldBtn = document.createElement('button');
    addBldBtn.className = 'btn-add';
    addBldBtn.textContent = '+ Add Bundle Link';
    addBldBtn.addEventListener('click', function () {
      addBundleLinkRow(bldContainer, '');
      notifyTemplateEditorChanged(bldContainer);
    });
    editor.appendChild(addBldBtn);

    // ---- Task Definitions Section ----
    var tdH3 = document.createElement('h3');
    tdH3.textContent = 'Task Definitions';
    editor.appendChild(tdH3);

    var tdContainer = document.createElement('div');
    tdContainer.id = 'tpl-taskdefs-list';
    editor.appendChild(tdContainer);

    var addTdBtn = document.createElement('button');
    addTdBtn.className = 'btn-add';
    addTdBtn.id = 'add-task-def-btn';
    addTdBtn.textContent = '+ Add Task';
    addTdBtn.addEventListener('click', function () {
      var count = tdContainer.querySelectorAll('.task-def-item').length;
      addTaskDefItem(tdContainer, {
        refId: 'task-' + (count + 1),
        description: '',
        offsetDays: 0
      }, users);
      notifyTemplateEditorChanged(tdContainer);
    });
    editor.appendChild(addTdBtn);

    container.appendChild(editor);

    // Populate references
    var refs = template.references || [];
    refs.forEach(function (ref) {
      addReferenceRow(refsContainer, ref.name, ref.url);
    });

    // Populate bundle link definitions
    var blds = template.bundleLinkDefinitions || [];
    blds.forEach(function (bld) {
      addBundleLinkRow(bldContainer, bld.name);
    });

    // Populate task definitions
    var tds = template.taskDefinitions || [];
    tds.forEach(function (td) {
      addTaskDefItem(tdContainer, td, users);
    });

    // Setup drag-and-drop for task definitions
    setupTaskDefDragDrop(tdContainer);

    // Save handler
    document.getElementById('tpl-save-btn').addEventListener('click', function () {
      saveTemplate(template.id);
    });

    function updateEditorSummary() {
      var summary = document.getElementById('template-editor-summary');
      if (!summary) return;
      var taskCount = tdContainer.querySelectorAll('.task-def-item').length;
      var refCount = refsContainer.querySelectorAll('.ref-row').length;
      var linkCount = bldContainer.querySelectorAll('.bld-row').length;
      summary.textContent = taskCount + ' task' + (taskCount !== 1 ? 's' : '') +
        ' · ' + refCount + ' reference' + (refCount !== 1 ? 's' : '') +
        ' · ' + linkCount + ' bundle link' + (linkCount !== 1 ? 's' : '');
    }

    function markDirty() {
      updateEditorSummary();
      var feedback = document.getElementById('tpl-save-feedback');
      if (!feedback) return;
      if (feedback.classList.contains('dirty')) return;
      feedback.textContent = 'Unsaved changes';
      feedback.className = 'save-feedback dirty';
    }

    editor.addEventListener('input', markDirty);
    editor.addEventListener('change', markDirty);
    editor.addEventListener('template-editor-changed', markDirty);
    editor.addEventListener('template-editor-reordered', updateEditorSummary);
    updateEditorSummary();
  }

  function notifyTemplateEditorChanged(el) {
    if (!el) return;
    el.dispatchEvent(new CustomEvent('template-editor-changed', { bubbles: true }));
  }

  function addReferenceRow(container, name, url) {
    var row = document.createElement('div');
    row.className = 'list-item-row ref-row';
    row.innerHTML =
      '<input type="text" class="ref-name" placeholder="Name" value="' + escapeHtml(name) + '" style="width:150px;" />' +
      '<input type="url" class="ref-url" placeholder="https://..." value="' + escapeHtml(url) + '" style="width:300px;" />';

    var removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      row.remove();
      notifyTemplateEditorChanged(container);
    });
    row.appendChild(removeBtn);
    container.appendChild(row);
  }

  function addBundleLinkRow(container, name) {
    var row = document.createElement('div');
    row.className = 'list-item-row bld-row';
    row.innerHTML =
      '<input type="text" class="bld-name" placeholder="Link name" value="' + escapeHtml(name) + '" style="width:200px;" />';

    var removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      row.remove();
      notifyTemplateEditorChanged(container);
    });
    row.appendChild(removeBtn);
    container.appendChild(row);
  }

  function addTaskDefItem(container, td, users) {
    var item = document.createElement('div');
    item.className = 'task-def-item';
    item.setAttribute('draggable', 'true');

    var header = document.createElement('div');
    header.className = 'task-def-header';

    var dragHandle = document.createElement('span');
    dragHandle.className = 'task-def-drag-handle';
    dragHandle.textContent = '\u2630';
    dragHandle.title = 'Drag to reorder';
    header.appendChild(dragHandle);

    var refIdSpan = document.createElement('span');
    refIdSpan.style.cssText = 'font-size:12px;color:#999;';
    refIdSpan.textContent = 'refId: ' + escapeHtml(td.refId || '');
    refIdSpan.className = 'td-refid-display';
    header.appendChild(refIdSpan);

    var removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      item.remove();
      notifyTemplateEditorChanged(container);
    });
    header.appendChild(removeBtn);

    item.appendChild(header);

    // Hidden refId field
    var refIdInput = document.createElement('input');
    refIdInput.type = 'hidden';
    refIdInput.className = 'td-refid';
    refIdInput.value = td.refId || '';
    item.appendChild(refIdInput);

    // Fields row
    var fieldsDiv = document.createElement('div');
    fieldsDiv.className = 'task-def-fields';

    // Description
    fieldsDiv.innerHTML =
      '<div class="editor-group">' +
        '<label>Description</label>' +
        '<input type="text" class="td-description" value="' + escapeHtml(td.description || '') + '" style="width:250px;" />' +
      '</div>' +
      '<div class="editor-group">' +
        '<label>Offset Days</label>' +
        '<input type="number" class="td-offset" value="' + (td.offsetDays != null ? td.offsetDays : 0) + '" style="width:80px;" />' +
      '</div>';

    // Assignee dropdown
    var assigneeGroup = document.createElement('div');
    assigneeGroup.className = 'editor-group';
    assigneeGroup.innerHTML = '<label>Assignee</label>';
    var assigneeSelect = document.createElement('select');
    assigneeSelect.className = 'td-assignee';
    assigneeSelect.innerHTML = '<option value="">(default)</option>';
    users.forEach(function (u) {
      var opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name;
      if (td.assigneeId === u.id) opt.selected = true;
      assigneeSelect.appendChild(opt);
    });
    assigneeGroup.appendChild(assigneeSelect);
    fieldsDiv.appendChild(assigneeGroup);

    // Instructions URL
    var instrGroup = document.createElement('div');
    instrGroup.className = 'editor-group';
    instrGroup.innerHTML =
      '<label>Instructions URL</label>' +
      '<input type="text" class="td-instructions" value="' + escapeHtml(td.instructionsUrl || '') + '" style="width:250px;" />';
    fieldsDiv.appendChild(instrGroup);

    // Required link name
    var rlnGroup = document.createElement('div');
    rlnGroup.className = 'editor-group';
    rlnGroup.innerHTML =
      '<label>Required Link Name</label>' +
      '<input type="text" class="td-required-link" value="' + escapeHtml(td.requiredLinkName || '') + '" style="width:150px;" />';
    fieldsDiv.appendChild(rlnGroup);

    item.appendChild(fieldsDiv);

    // Checkboxes row
    var checkboxDiv = document.createElement('div');
    checkboxDiv.style.cssText = 'display:flex;gap:16px;margin-top:8px;flex-wrap:wrap;align-items:center;';

    // Is milestone
    var milestoneLabel = document.createElement('label');
    milestoneLabel.className = 'task-def-checkbox';
    var milestoneCheck = document.createElement('input');
    milestoneCheck.type = 'checkbox';
    milestoneCheck.className = 'td-milestone';
    if (td.isMilestone) milestoneCheck.checked = true;
    milestoneLabel.appendChild(milestoneCheck);
    milestoneLabel.appendChild(document.createTextNode(' Is Milestone'));
    checkboxDiv.appendChild(milestoneLabel);

    // Stage on complete (only visible if milestone)
    var stageGroup = document.createElement('div');
    stageGroup.className = 'editor-group td-stage-group';
    stageGroup.style.display = td.isMilestone ? '' : 'none';
    stageGroup.innerHTML = '<label>Stage on Complete</label>';
    var stageSelect = document.createElement('select');
    stageSelect.className = 'td-stage';
    var stageOptions = ['', 'announced', 'after-event', 'done'];
    stageOptions.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s || '(none)';
      if (td.stageOnComplete === s) opt.selected = true;
      stageSelect.appendChild(opt);
    });
    stageGroup.appendChild(stageSelect);
    checkboxDiv.appendChild(stageGroup);

    // Toggle stage visibility on milestone change
    milestoneCheck.addEventListener('change', function () {
      stageGroup.style.display = milestoneCheck.checked ? '' : 'none';
      notifyTemplateEditorChanged(container);
    });

    // Requires file
    var fileLabel = document.createElement('label');
    fileLabel.className = 'task-def-checkbox';
    var fileCheck = document.createElement('input');
    fileCheck.type = 'checkbox';
    fileCheck.className = 'td-requires-file';
    if (td.requiresFile) fileCheck.checked = true;
    fileLabel.appendChild(fileCheck);
    fileLabel.appendChild(document.createTextNode(' Requires File'));
    checkboxDiv.appendChild(fileLabel);

    item.appendChild(checkboxDiv);
    container.appendChild(item);
  }

  function setupTaskDefDragDrop(container) {
    var dragSrc = null;

    container.addEventListener('dragstart', function (e) {
      var item = e.target.closest('.task-def-item');
      if (!item) return;
      dragSrc = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    });

    container.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var item = e.target.closest('.task-def-item');
      if (!item || item === dragSrc) return;

      // Remove drag-over from all items
      container.querySelectorAll('.task-def-item').forEach(function (el) {
        el.classList.remove('drag-over');
      });
      item.classList.add('drag-over');
    });

    container.addEventListener('drop', function (e) {
      e.preventDefault();
      var item = e.target.closest('.task-def-item');
      if (!item || !dragSrc || item === dragSrc) return;

      // Determine position
      var items = Array.from(container.querySelectorAll('.task-def-item'));
      var dragIdx = items.indexOf(dragSrc);
      var dropIdx = items.indexOf(item);

      if (dragIdx < dropIdx) {
        container.insertBefore(dragSrc, item.nextSibling);
      } else {
        container.insertBefore(dragSrc, item);
      }
      container.dispatchEvent(new CustomEvent('template-editor-reordered', { bubbles: true }));
      notifyTemplateEditorChanged(container);
    });

    container.addEventListener('dragend', function () {
      container.querySelectorAll('.task-def-item').forEach(function (el) {
        el.classList.remove('dragging');
        el.classList.remove('drag-over');
      });
      dragSrc = null;
    });
  }

  function saveTemplate(templateId) {
    var feedback = document.getElementById('tpl-save-feedback');
    feedback.textContent = 'Saving...';
    feedback.className = 'save-feedback';

    var name = document.getElementById('tpl-name').value.trim();
    var type = document.getElementById('tpl-type').value.trim();
    var emoji = document.getElementById('tpl-emoji').value.trim();
    var tagsStr = document.getElementById('tpl-tags').value.trim();
    var assigneeId = document.getElementById('tpl-assignee').value;

    var tags = tagsStr ? tagsStr.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; }) : [];

    // Trigger config
    var triggerRadio = document.querySelector('input[name="tpl-trigger"]:checked');
    var triggerType = triggerRadio ? triggerRadio.value : 'manual';
    var triggerSchedule = document.getElementById('tpl-cron').value.trim();
    var triggerLeadDaysStr = document.getElementById('tpl-lead-days').value.trim();
    var triggerLeadDays = triggerLeadDaysStr ? parseInt(triggerLeadDaysStr, 10) : undefined;

    // References
    var references = [];
    document.querySelectorAll('#tpl-references-list .ref-row').forEach(function (row) {
      var refName = row.querySelector('.ref-name').value.trim();
      var refUrl = row.querySelector('.ref-url').value.trim();
      if (refName || refUrl) {
        references.push({ name: refName, url: refUrl });
      }
    });

    // Bundle link definitions
    var bundleLinkDefinitions = [];
    document.querySelectorAll('#tpl-bundlelinks-list .bld-row').forEach(function (row) {
      var bldName = row.querySelector('.bld-name').value.trim();
      if (bldName) {
        bundleLinkDefinitions.push({ name: bldName });
      }
    });

    // Task definitions
    var taskDefinitions = [];
    document.querySelectorAll('#tpl-taskdefs-list .task-def-item').forEach(function (item) {
      var refId = item.querySelector('.td-refid').value.trim();
      var description = item.querySelector('.td-description').value.trim();
      var offsetDays = parseInt(item.querySelector('.td-offset').value, 10) || 0;
      var isMilestone = item.querySelector('.td-milestone').checked;
      var stageOnComplete = item.querySelector('.td-stage').value || undefined;
      var tdAssigneeId = item.querySelector('.td-assignee').value || undefined;
      var instructionsUrl = item.querySelector('.td-instructions').value.trim() || undefined;
      var requiredLinkName = item.querySelector('.td-required-link').value.trim() || undefined;
      var requiresFile = item.querySelector('.td-requires-file').checked;

      var tdObj = {
        refId: refId,
        description: description,
        offsetDays: offsetDays
      };

      if (isMilestone) tdObj.isMilestone = true;
      if (stageOnComplete && isMilestone) tdObj.stageOnComplete = stageOnComplete;
      if (tdAssigneeId) tdObj.assigneeId = tdAssigneeId;
      if (instructionsUrl) tdObj.instructionsUrl = instructionsUrl;
      if (requiredLinkName) tdObj.requiredLinkName = requiredLinkName;
      if (requiresFile) tdObj.requiresFile = true;

      taskDefinitions.push(tdObj);
    });

    var updateData = {
      name: name,
      type: type,
      emoji: emoji || undefined,
      tags: tags.length > 0 ? tags : undefined,
      defaultAssigneeId: assigneeId || undefined,
      triggerType: triggerType,
      references: references.length > 0 ? references : undefined,
      bundleLinkDefinitions: bundleLinkDefinitions.length > 0 ? bundleLinkDefinitions : undefined,
      taskDefinitions: taskDefinitions
    };

    if (triggerType === 'automatic') {
      if (triggerSchedule) updateData.triggerSchedule = triggerSchedule;
      if (triggerLeadDays !== undefined && !isNaN(triggerLeadDays)) updateData.triggerLeadDays = triggerLeadDays;
    }

    api.templates.update(templateId, updateData).then(function () {
      feedback.textContent = 'Saved successfully!';
      feedback.className = 'save-feedback success';
      showSuccess('Template saved.');
    }).catch(function (err) {
      feedback.textContent = 'Save failed: ' + err.message;
      feedback.className = 'save-feedback error';
    });
  }


  // ── Recurring View ──────────────────────────────────────────────

  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var recurringState = {
    search: ''
  };

  function scheduleSummary(config) {
    if (config.cronExpression) {
      var parts = config.cronExpression.split(/\s+/);
      if (parts.length === 5) {
        if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*') return 'Daily';
        if (parts[2] === '*' && parts[3] === '*' && parts[4] !== '*') {
          var dayIndex = parseInt(parts[4], 10);
          return 'Weekly (' + (DAY_NAMES[dayIndex] || ('day ' + parts[4])) + ')';
        }
        if (parts[2] !== '*' && parts[3] === '*' && parts[4] === '*') return 'Monthly (day ' + parts[2] + ')';
      }
      return config.cronExpression;
    }
    if (config.schedule === 'daily') return 'Daily';
    if (config.schedule === 'weekly') return 'Weekly (' + DAY_NAMES[config.dayOfWeek] + ')';
    if (config.schedule === 'monthly') return 'Monthly (day ' + config.dayOfMonth + ')';
    return config.schedule;
  }

  function cronForSchedule(schedule, dayValue) {
    if (schedule === 'daily') return '0 9 * * *';
    if (schedule === 'weekly') return '0 9 * * ' + dayValue;
    if (schedule === 'monthly') return '0 9 ' + dayValue + ' * *';
    return '';
  }

  function renderRecurring() {
    clearApp();

    var header = document.createElement('h2');
    header.textContent = 'Recurring Tasks';
    app.appendChild(header);

    // Create form
    var form = document.createElement('div');
    form.className = 'form-section';
    form.innerHTML =
      '<h3>New Recurring Config</h3>' +
      '<div class="form-row">' +
        '<div class="form-group">' +
          '<label for="rec-desc">Description</label>' +
          '<input type="text" id="rec-desc" placeholder="Task description" style="width:300px;" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="rec-schedule">Schedule</label>' +
          '<select id="rec-schedule">' +
            '<option value="daily">Daily</option>' +
            '<option value="weekly">Weekly</option>' +
            '<option value="monthly">Monthly</option>' +
          '</select>' +
        '</div>' +
        '<div class="form-group" id="rec-day-group" style="display:none;">' +
          '<label for="rec-day" id="rec-day-label">Day</label>' +
          '<input type="number" id="rec-day" min="0" max="31" style="width:80px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label>State</label>' +
          '<label class="inline-checkbox">' +
            '<input type="checkbox" id="rec-enabled" checked />' +
            'Enabled' +
          '</label>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>&nbsp;</label>' +
          '<button class="btn-primary" id="rec-create-btn">Create</button>' +
        '</div>' +
      '</div>';
    app.appendChild(form);

    var scheduleSelect = document.getElementById('rec-schedule');
    var dayGroup = document.getElementById('rec-day-group');
    var dayInput = document.getElementById('rec-day');
    var dayLabel = document.getElementById('rec-day-label');

    function updateDayField() {
      var val = scheduleSelect.value;
      if (val === 'weekly') {
        dayGroup.style.display = '';
        dayLabel.textContent = 'Day of Week (0=Sun, 6=Sat)';
        dayInput.min = '0';
        dayInput.max = '6';
        dayInput.value = '';
      } else if (val === 'monthly') {
        dayGroup.style.display = '';
        dayLabel.textContent = 'Day of Month (1-31)';
        dayInput.min = '1';
        dayInput.max = '31';
        dayInput.value = '';
      } else {
        dayGroup.style.display = 'none';
        dayInput.value = '';
      }
    }

    scheduleSelect.addEventListener('change', updateDayField);

    document.getElementById('rec-create-btn').addEventListener('click', function () {
      var btn = document.getElementById('rec-create-btn');
      var desc = document.getElementById('rec-desc').value.trim();
      var schedule = scheduleSelect.value;
      var enabled = document.getElementById('rec-enabled').checked;
      if (!desc) {
        showError('Description is required.');
        return;
      }
      var dayValue = dayInput.value;
      if ((schedule === 'weekly' || schedule === 'monthly') && dayValue === '') {
        showError('Choose a day for this recurring schedule.');
        return;
      }
      var data = { description: desc, cronExpression: cronForSchedule(schedule, dayValue) };
      if (schedule === 'weekly') {
        var dayOfWeek = parseInt(dayValue, 10);
        if (Number.isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
          showError('Day of week must be between 0 and 6.');
          return;
        }
      } else if (schedule === 'monthly') {
        var dayOfMonth = parseInt(dayValue, 10);
        if (Number.isNaN(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
          showError('Day of month must be between 1 and 31.');
          return;
        }
      }
      data.enabled = enabled;
      setButtonBusy(btn, true, 'Create', 'Creating...');
      api.recurring.create(data).then(function () {
        document.getElementById('rec-desc').value = '';
        document.getElementById('rec-enabled').checked = true;
        scheduleSelect.value = 'daily';
        dayInput.value = '';
        updateDayField();
        showSuccess('Recurring config created.');
        loadRecurring();
      }).catch(function (err) {
        showError('Failed to create recurring config: ' + err.message);
      }).finally(function () {
        setButtonBusy(btn, false, 'Create');
      });
    });

    // Generate section
    var genSection = document.createElement('div');
    genSection.className = 'form-section';
    genSection.innerHTML =
      '<h3>Generate Tasks</h3>' +
      '<div class="form-row">' +
        '<div class="form-group">' +
          '<label for="gen-start">Start Date</label>' +
          '<input type="date" id="gen-start" value="' + todayString() + '" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="gen-end">End Date</label>' +
          '<input type="date" id="gen-end" value="' + todayString() + '" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label>&nbsp;</label>' +
          '<button class="btn-primary" id="gen-btn">Generate</button>' +
        '</div>' +
      '</div>' +
      '<div id="gen-result" style="margin-top:12px;font-size:14px;"></div>';
    app.appendChild(genSection);

    document.getElementById('gen-btn').addEventListener('click', function () {
      var btn = document.getElementById('gen-btn');
      var startDate = document.getElementById('gen-start').value;
      var endDate = document.getElementById('gen-end').value;
      var resultDiv = document.getElementById('gen-result');
      setButtonBusy(btn, true, 'Generate', 'Generating...');
      resultDiv.textContent = 'Generating...';
      api.recurring.generate({ startDate: startDate, endDate: endDate }).then(function (data) {
        var count = (data.generated || []).length;
        var skipped = data.skipped || 0;
        resultDiv.textContent = 'Generated ' + count + ' task(s), skipped ' + skipped + ' duplicate(s).';
        showSuccess('Tasks generated.');
      }).catch(function (err) {
        resultDiv.textContent = '';
        showError('Failed to generate tasks: ' + err.message);
      }).finally(function () {
        setButtonBusy(btn, false, 'Generate');
      });
    });

    // Table container
    var tableContainer = document.createElement('div');
    tableContainer.id = 'recurring-table';
    app.appendChild(tableContainer);

    var listToolbar = document.createElement('div');
    listToolbar.className = 'list-toolbar';
    listToolbar.innerHTML =
      '<div class="section-summary" id="recurring-count">Recurring configs</div>' +
      '<input type="search" id="recurring-search" class="search-input" placeholder="Search recurring tasks" value="' + escapeHtml(recurringState.search) + '" />';
    app.insertBefore(listToolbar, tableContainer);

    document.getElementById('recurring-search').addEventListener('input', function (e) {
      recurringState.search = e.target.value.trim().toLowerCase();
      loadRecurring();
    });

    loadRecurring();
  }

  function loadRecurring() {
    var container = document.getElementById('recurring-table');
    if (!container) return;
    container.innerHTML = '<p>Loading...</p>';

    var banners = app.querySelectorAll('.error-banner');
    banners.forEach(function (b) { b.remove(); });

    api.recurring.list().then(function (data) {
      var configs = data.recurringConfigs || [];
      var totalCount = configs.length;
      var countEl = document.getElementById('recurring-count');
      if (countEl) {
        countEl.textContent = totalCount + ' recurring config' + (totalCount !== 1 ? 's' : '');
      }
      if (configs.length === 0) {
        container.innerHTML = renderEmptyState(
          'No recurring configs yet',
          'Create a schedule above to generate repeatable tasks automatically.',
          []
        );
        return;
      }

      if (recurringState.search) {
        configs = configs.filter(function (c) {
          var haystack = [c.description || '', scheduleSummary(c), c.enabled ? 'enabled' : 'disabled'].join(' ').toLowerCase();
          return haystack.indexOf(recurringState.search) !== -1;
        });
      }

      if (countEl) {
        countEl.textContent = configs.length + ' of ' + totalCount + ' recurring config' + (totalCount !== 1 ? 's' : '') + ' shown';
      }

      if (configs.length === 0) {
        container.innerHTML = renderEmptyState(
          'No recurring configs match your search',
          'Clear or broaden the search to see more recurring configs.',
          []
        );
        return;
      }

      var html = '<table class="responsive-table"><thead><tr>' +
        '<th>Description</th><th>Schedule</th><th>Enabled</th><th>Actions</th>' +
        '</tr></thead><tbody>';
      configs.forEach(function (c) {
        var enabledText = c.enabled ? 'Yes' : 'No';
        html += '<tr>' +
          '<td data-label="Description">' + escapeHtml(c.description) + '</td>' +
          '<td data-label="Schedule">' + escapeHtml(scheduleSummary(c)) + '</td>' +
          '<td data-label="Enabled">' + enabledText + '</td>' +
          '<td data-label="Actions">' +
            '<button class="btn-danger" data-delete-recurring="' + c.id + '" data-rec-desc="' + escapeHtml(c.description) + '">Delete</button>' +
          '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;

      // Delete handlers
      container.querySelectorAll('[data-delete-recurring]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-delete-recurring');
          var desc = btn.getAttribute('data-rec-desc');
          if (!confirm('Delete recurring config: "' + desc + '"?')) return;
          setButtonBusy(btn, true, 'Delete', 'Deleting...');
          api.recurring.delete(id).then(function () {
            showSuccess('Recurring config deleted.');
            loadRecurring();
          }).catch(function (err) {
            showError('Failed to delete: ' + err.message);
            setButtonBusy(btn, false, 'Delete');
          });
        });
      });
    }).catch(function (err) {
      container.innerHTML = '';
      showError('Failed to load recurring configs: ' + err.message);
    });
  }

  // ── Utility ─────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
  }

  function renderMarkdownLinks(str) {
    if (!str) return '';
    var escaped = escapeHtml(str);
    return escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
})();
