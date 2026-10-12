---
title: "Course Launch Checklist"
summary: "Comprehensive checklist covering platform setup, repo configuration, asset updates, events, promotion, and outreach."
doc_type: checklist
tags:
  - course
  - launch
  - checklist
owner_role: course-launch-owner
systems:
  - course-platform
  - github
  - mailchimp
  - luma
---

# Course Launch Checklist

Master operational checklist for launching a Zoomcamp cohort.

## 1. Course Platform Setup
*Assignee: Valeriia* (Blocks most other tasks; run first)

- [ ] Confirm start date (Monday) and project blocks (deadlines are Monday 23:00 UTC)
- [ ] Create course on `courses.datatalks.club` using `course-management-agent`
- [ ] Repoint the registration campaign to this cohort
- [ ] Create the course outline: homeworks closed & empty, projects with both deadlines
- [ ] Verify outline and test public registration page
- [ ] Record schedule in `00-cohort-brief.md` and campaign metadata

## 2. Course Repo Cohort Setup
*Assignee: Valeriia*

- [ ] Create `cohorts/<year>/` folder with README and per-module homework folders
- [ ] Mark upcoming modules as `— coming` in the cohort README
- [ ] Archive replaced/renamed modules under `cohorts/<year-1>/`
- [ ] Link archived modules from the new ones under "Previous Cohort Materials"
- [ ] Re-solve carried-over homework questions against current libraries
- [ ] Update root README syllabus, dates, and links

## 3. Cross-Platform Asset Updates
*Assignee: Valeriia*

- [ ] Update course GitHub README (registration link, platform link, dates)
- [ ] Update website course article (`_posts/...`)
- [ ] Update all-courses guide article
- [ ] Update FAQ data (`_data/faqs/...`)
- [ ] Update schema.org structured data (`_includes/...`)
- [ ] Update website CTA banner
- [ ] Update welcome email sequence (`00-welcome-email.md`)

## 4. Events
*Assignee: Grace*

Events start at **17:00 Europe/Berlin** on Mondays or Tuesdays.

- [ ] Create pre-course workshop events on Luma, Meetup, LinkedIn Events
- [ ] Create pre-course Q&A webinar (T-14 days)
- [ ] Create launch stream (T+0, course start date)
- [ ] Set up StreamYard broadcast and invite Alexey / guest speakers
- [ ] Add event links to campaign calendar

## 5. Promotion & Social Media
*Assignee: Valeriia (Approver: Alexey)*

- [ ] DTC newsletter announcement block
- [ ] Alexey newsletter (AI Shipping Blog) announcement
- [ ] DTC LinkedIn & Twitter/X announcements
- [ ] Alexey LinkedIn & Twitter/X drafts in Typefully
- [ ] DTC Slack `#announcements` message
- [ ] YouTube community post & video description links
- [ ] Reddit post 1 (T-30 days): Registration is open
- [ ] Reddit post 2 (T+0): Cohort starts today

## 6. Outreach (Extra Push)
*Assignees: Grace & Valeriia*

- [ ] Alumni outreach (previous Zoomcamp graduates)
- [ ] Influencer outreach from directory
- [ ] Partner & sponsor cross-posts
- [ ] External tech podcast appearances for Alexey

## 7. Cohort Retrospective
*Assignees: Valeriia & Alexey* (T+Course_End + 7 to 14 days)

- [ ] Gather final registration numbers, hw01 count, and project submissions
- [ ] Log completion certificates issued
- [ ] Document what worked, what failed, and best-performing channels
- [ ] Record changes needed for next year in `03-retrospective.md`
