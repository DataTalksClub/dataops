---
title: "Course Platform Setup"
summary: "Process for creating cohorts, registration campaigns, and course outlines on courses.datatalks.club via course-management-agent."
doc_type: sop
tags:
  - course
  - platform
  - setup
  - sop
owner_role: course-launch-owner
systems:
  - course-platform
  - course-management-agent
---

# Course Platform Setup

This process creates the cohort on the course management platform: the course record, the registration campaign that produces the registration link, and the course outline of homework and project deadlines.

Run it early. Almost every other launch task needs the registration link, the start date, and the deadline schedule, so the campaign calendar, website banner, GitHub README, and welcome email all block on this.

## How to Make the Changes

Use the **course management agent** project (`~/git/course-management-agent`) to create and update everything on the platform. It owns the platform workflows, the credentials, and the guardrails around deleting content that has submissions.

Ask it for what you want in plain terms, for example:

- "Create the ML Zoomcamp 2026 cohort starting September 14, copy the plan from last year, deadlines on Mondays."
- "Point the ml-zoomcamp registration campaign at the 2026 cohort."
- "Open hw01 for ML Zoomcamp 2026 and add its questions."
- "Show me the current outline for ml-zoomcamp-2026."

Do not hand-edit the platform through the admin UI for these tasks. Going through the project keeps the cohort, the registration campaign, and the outline consistent, and it verifies the result afterwards.

## 1. Decide the Schedule

Every deadline is **Monday at 23:00 UTC**, for homeworks and for both project deadlines. That is fixed, not a per-cohort decision: learners only have to remember one rule, and the leaderboard and scoring stay consistent across cohorts.

That leaves two things to decide:

- **Start date:** Zoomcamps start on a Monday.
- **Project blocks:** Where the midterm and capstone slots sit between the modules, and how many weeks each block gets.

Start from the previous cohort's outline and shift it rather than designing a new schedule. Ask the project for last year's outline, then adjust: change the year, move every deadline onto a Monday, and widen the gaps that fall across holidays. December and early January usually need more room.

Record the final schedule in the campaign's `00-cohort-brief.md` before anything is created.

## 2. Create the Course

Ask for a new cohort, giving the start date, the end date, and the previous cohort to copy settings from.

Decisions that belong to you, not the tool:

- The cohort slug, normally `<course_short>-zoomcamp-<year>`. Match whatever the previous cohort used.
- The end date, which is the last peer review deadline.
- Whether the certificate rules changed this year. If they did not, carry over the previous cohort's passing rules.

## 3. Create the Registration Campaign

The registration campaign owns the public registration page and produces the registration link used in every piece of launch copy.

The campaign slug carries no year. It stays stable across cohorts, and each year it is repointed at the new course. If the campaign already exists from a previous cohort, repoint it. Do not create a second one.

The campaign's marketing blurb, page description, cover image, and video link are learner-facing copy. Draft them from the copy bank. A placeholder here ships straight to the registration page, so treat it as an asset, not a config value.

## 4. Create the Course Outline

The outline is the set of homeworks and projects with their deadlines.

Rules for the outline:

- **Homeworks start closed and empty.** Questions come from each module's `homework.md` once that module is ready. Adding them at outline time risks publishing an unfinished homework.
- **Keep the previous cohort's slugs.** Learners, scripts, and old links depend on them, and gaps such as a missing `hw07` are usually intentional because that slot is a project.
- **Every project needs both deadlines**, submission and peer review.

Each homework is opened when its module goes live, not during setup.

## 5. Verify

Ask the project to read the outline back, then confirm:

- Every deadline falls on a Monday at 23:00 UTC.
- Every homework is closed with no questions.
- Every project has both deadlines.
- No holiday week swallows a deadline.
- The registration page loads and shows the right cohort.

## 6. Record the Outline

Write the confirmed schedule into the campaign folder:

- Put the deadline tables in `campaigns/<course>-<year>/processes/00-cohort-brief.md`.
- Put the course platform URL and registration URL into `campaigns/<course>-<year>/course.yaml`.
- Use those deadlines when filling `02-campaign-calendar.csv`, so module announcements and deadline reminders line up with the real dates.

## Checklist

- [ ] Previous cohort outline reviewed
- [ ] Start date and project blocks confirmed
- [ ] Course created with the correct slug, dates, and certificate settings
- [ ] Registration campaign created or repointed to the new course
- [ ] Registration page loads and shows the right cohort
- [ ] Homeworks created, closed, and empty
- [ ] Projects created with both deadlines
- [ ] Outline verified against Monday deadlines and holiday weeks
- [ ] Registration page copy written, not left as placeholder
- [ ] Schedule recorded in the cohort brief and campaign `course.yaml`
