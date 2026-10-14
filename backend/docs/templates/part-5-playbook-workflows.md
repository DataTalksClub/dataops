# Templates Reference — Part 5: Playbook Workflows & Persona Mapping

> Part 5 of the [templates reference](../templates.md):
> This part documents the operational playbook templates for Grace (`grace@datatalks.club`) and Valeriia (`valeriia@datatalks.club`), their task sequences, timing offsets, and DataOps integration points.

## 1. Course Launch Workflow (`course`)

- Type: `course`
- Display:
  - Tags: Course, Education, Launch
  - Title: {COURSE_NAME} {YEAR} Cohort
- Anchor date: Course start date ($T+0$, always a Monday)
- Primary Assignee: Valeriia (`00000000-0000-0000-0000-000000000002`)
- Trigger: Manual. Instantiated when a new Zoomcamp cohort is announced (~8–12 weeks before start).

### Phases & Tasks

#### Phase 1: Launch Preparation (`preparation`)
- `confirm-cohort-schedule` ($T-60$d): Review previous outline, confirm start date and project blocks, record in `00-cohort-brief.md`. (Assignee: Valeriia)
- `create-course-platform-record` ($T-56$d): Run `course-management-agent` to create course on `courses.datatalks.club`, repoint registration campaign, verify outline with Monday 23:00 UTC deadlines. (Assignee: Valeriia, Instructions: `docs/playbooks/01-course-platform-setup.md`)
- `setup-course-repo-cohort` ($T-50$d): Create `cohorts/<year>/` folder, archive replaced modules under `cohorts/<year-1>/`, update root README. (Assignee: Valeriia, Instructions: `docs/playbooks/01-course-repo-cohort-setup.md`)
- `update-cross-platform-assets` ($T-45$d): Update website course article, FAQ YAML, and schema.org structured data. (Assignee: Valeriia, Instructions: `docs/playbooks/01-course-assets-map.md`)
- `setup-pre-course-events` ($T-40$d): Create pre-course workshop and Q&A webinar on Luma, Meetup, and LinkedIn Events. (Assignee: Grace)
- `draft-welcome-email-sequence` ($T-35$d): Update welcome email copy and automated onboarding sequence in Mailchimp. (Assignee: Valeriia)

#### Phase 2: Launch Promotion (`announced`)
- `announce-registration-open` ($T-30$d): Main launch announcement across DTC LinkedIn, X, Slack, and Alexey accounts. (Assignee: Valeriia)
- `post-reddit-launch-announcement` ($T-30$d): First Reddit post announcing cohort registration in dedicated subreddit. (Assignee: Valeriia, Proof: Reddit URL)
- `launch-influencer-outreach` ($T-28$d): Reach out to targeted technical influencers from `influencer-outreach-directory.md`. (Assignee: Grace)
- `host-pre-course-qa-webinar` ($T-14$d): Host live Q&A webinar at 17:00 Berlin time to answer learner questions. (Assignee: Alexey / Grace)
- `publish-educational-micro-lessons` ($T-10$d): Publish 2-3 educational concept posts highlighting tools taught in the course. (Assignee: Valeriia)
- `final-setup-and-prerequisites-push` ($T-3$d): Share local environment setup guide and prerequisites checklist. (Assignee: Valeriia)
- `host-live-course-launch-stream` ($T+0$d): Stream live kickoff stream at 17:00 Berlin time. Milestone shifts card to `after-event`. (Assignee: Alexey / Grace)
- `post-reddit-starts-today` ($T+0$d): Second Reddit post announcing the cohort begins today. (Assignee: Valeriia, Proof: Reddit URL)

#### Phase 3: Cohort Support & Closeout (`after-event`)
- `publish-weekly-module-rhythm` ($T+7$d to $T+42$d): Weekly module announcement on Mondays, homework reminder on Fridays. (Assignee: Valeriia)
- `open-and-support-project-phase` ($T+49$d): Launch project guidelines, evaluation rubrics, and peer review etiquette. (Assignee: Valeriia)
- `issue-completion-certificates` ($T+End+7$d): Verify peer reviews, calculate passing grades, and issue completion certificates. (Assignee: Valeriia)
- `conduct-cohort-retrospective` ($T+End+14$d): Document final numbers, what worked, channel ROI, and next year changes. (Assignee: Valeriia / Alexey, Instructions: `docs/playbooks/03-retrospective.md`)

---

## 2. Weekly Social Media Workflow (`social-media`)

- Type: `social-media`
- Display:
  - Tags: Social media, Content, Typefully
  - Title: Weekly social posts (Week of {DATE})
- Anchor date: Monday of the target week
- Primary Assignee: Valeriia (`00000000-0000-0000-0000-000000000002`)
- Trigger: Automatic weekly recurring card generated on Friday for the upcoming week.

### Tasks
1. `review-upcoming-milestones` (-3d, Friday): Review upcoming Zoomcamp module, podcast release, webinar, and Book of the Week.
2. `draft-weekly-typefully-queue` (-2d, Saturday/Sunday): Draft 5 posts in Typefully following the 13 primary post types.
3. `alexey-draft-review` (-1d, Sunday): Alexey reviews and approves personal account drafts. (Assignee: Alexey)
4. `queue-scheduled-posts` (0d, Monday): Confirm scheduling across peak engagement windows (09:00 and 15:00 Berlin time).
5. `engage-and-collect-faq` (+4d, Friday): Reply to comments, gather objections, and feed into course FAQ.

---

## 3. Weekly Newsletter Workflow (`newsletter`)

- Type: `newsletter`
- Display:
  - Tags: Newsletter, Mailchimp, Sponsors
  - Title: Weekly email #{NUMBER}
- Anchor date: Newsletter publish day (Thursday)
- Primary Assignee: Valeriia (Assembly & Delivery)
- Secondary Assignee: Grace (Sponsor document intake & chasing)
- Trigger: Automatic recurring card created 14 days before publication.

### Key Division of Tasks
- Grace handles sponsor communications, asset collection, and billing details.
- Valeriia populates the Mailchimp campaign blocks (Sponsored, Book of the Week, Podcast, Course CTA, Curated links).
- Alexey reviews final test email and gives sign-off.
