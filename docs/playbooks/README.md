---
title: "DataTalks.Club Operational Playbooks & Assistant Workflows"
summary: "Canonical operational playbooks imported from DataTalksClub/playbooks for community, course cohort operations, events, and newsletter workflows."
doc_type: playbook
tags:
  - playbooks
  - operations
  - assistant
  - personas
  - community
  - courses
owner_role: operations-assistant
systems:
  - work-engine
  - docs
  - calendar
  - newsletter
  - sponsor-crm
---

# Operational Playbooks & Assistant Workflows

This directory contains the operational playbooks imported into DataOps from `DataTalksClub/playbooks`. They guide daily execution for personal assistants, community managers, and course operators.

## Personas & Responsibilities

| Persona | Email / ID | Primary Domain | Core Playbooks & Workflows |
| :--- | :--- | :--- | :--- |
| **Grace** | `grace@datatalks.club`<br/>`00000000-0000-0000-0000-000000000001` | Community & Event Management | Podcasts, Webinars, Workshops, Office Hours, Book of the Week, Slack Invitations & Moderation, Sponsor Intake & Chasing, Luma Listings. |
| **Valeriia** | `valeriia@datatalks.club`<br/>`00000000-0000-0000-0000-000000000002` | Course Launches & Content Operations | Zoomcamp Cohort Launches, Course Platform Setup, Repo Cohort Setup, Launch Checklists, Campaign Calendars, Typefully Social Drafting, Mailchimp Newsletter Assembly, Cohort Retrospectives. |
| **Alexey** | `alexey@datatalks.club`<br/>`00000000-0000-0000-0000-000000000003` | Founder, Lead Instructor & Approver | Final tone and approval for personal channels (Alexey LinkedIn/X, AI Shipping Blog), Zoomcamp Launch Stream Hosting, Live Q&A Sessions, Invoicing / Finom Approvals. |

## Playbook Inventory

| Playbook | Purpose | Primary Persona | DataOps Entity |
| :--- | :--- | :--- | :--- |
| [00-cohort-brief.md](00-cohort-brief.md) | Decisions for a new Zoomcamp cohort (dates, target, intensity, channels). | Valeriia | Card Template kickoff task (`workflow.course`) |
| [01-course-platform-setup.md](01-course-platform-setup.md) | Platform setup on `courses.datatalks.club` via `course-management-agent`. | Valeriia | Process Doc & Card Task (`launch-preparation`) |
| [01-course-repo-cohort-setup.md](01-course-repo-cohort-setup.md) | GitHub repo cohort folder versioning, archiving previous modules, homework review. | Valeriia | Process Doc & Card Task (`launch-preparation`) |
| [01-course-assets-map.md](01-course-assets-map.md) | Exact directory and file map for all 5 Zoomcamps across repos and website. | Valeriia | Process Doc Reference |
| [01-launch-checklist.md](01-launch-checklist.md) | Master checklist spanning platform, repo, asset updates, events, and outreach. | Valeriia | Card Template Task Checklist (`workflow.course`) |
| [02-campaign-calendar-reference.md](02-campaign-calendar-reference.md) | 77-slot phased social & email launch cadence (T-12 weeks through wrap-up). | Valeriia | Calendar & Work Queue tasks |
| [02-course-launch-social-system.md](02-course-launch-social-system.md) | 8-phase promotional strategy, post types, proof assets, channel guidelines. | Valeriia | Process Doc (Strategy Guide) |
| [03-retrospective.md](03-retrospective.md) | Post-cohort evaluation template for metrics, feedback, and next-year improvements. | Valeriia / Alexey | Card Task (`cohort-closeout`) |
| [social-post-taxonomy.md](social-post-taxonomy.md) | 13 primary post types & 5 modifiers for Typefully social drafting. | Valeriia | Process Doc Reference |
| [influencer-outreach-directory.md](influencer-outreach-directory.md) | Verified outreach list of AI/ML/Data practitioners for campaign amplification. | Grace / Valeriia | Process Doc & Outreach CRM |
| [podcast-outreach-directory.md](podcast-outreach-directory.md) | External tech podcasts directory for Alexey guest appearances and cross-promo. | Grace / Valeriia | Process Doc & Outreach CRM |

## Key Rules & Fixed Standards

1. **Deadlines are always Monday at 23:00 UTC:** Never schedule homework or project submissions on other days or times.
2. **Events start at 17:00 Europe/Berlin:** Webinars, workshops, and launch streams run at 17:00 Berlin time on Mondays or Tuesdays.
3. **Pre-course Q&A is at T-14 days:** Held two weeks before course launch to address learner questions and confirm readiness.
4. **Launch Stream is on Start Day (T+0):** Always on a Monday at 17:00 Berlin time.
5. **Reddit has a strict 2-post rule:** Exactly one post at T-30 days (announcing registration) and one post on start day (starts today). Never spam or crosspost.
