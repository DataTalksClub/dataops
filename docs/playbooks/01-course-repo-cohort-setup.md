---
title: "Course Repo Cohort Setup"
summary: "Process for opening a new cohort in a course GitHub repo, maintaining cohort folder structures, and archiving previous modules."
doc_type: sop
tags:
  - course
  - github
  - repo
  - setup
  - sop
owner_role: course-launch-owner
systems:
  - github
  - git
---

# Course Repo Cohort Setup

This process opens a new cohort in the course GitHub repo: the `cohorts/<year>/` folder learners work from, and the archive of any module the new cohort replaces.

Run it alongside `01-course-platform-setup.md`. The platform holds deadlines and submissions; the repo holds the materials, the homework, and the record of what each cohort actually studied.

## The Two Rules

**The repo root is always the current cohort.** Module folders at the top level — `01-.../`, `02-.../` — hold the version being taught right now. Nobody should have to guess which copy is live.

**`cohorts/<year>/` is the record of one cohort.** It holds that cohort's homework, its links, and the module content as it stood that year, so a learner who took the 2025 edition can still find what they were taught after the 2026 rewrite lands.

Everything below follows from those two.

## 1. Open the New Cohort Folder

Copy the previous cohort's structure into `cohorts/<year>/` and update it:

```text
cohorts/<year>/
  README.md
  <module>/homework.md
  workshops/            if the cohort runs workshops with their own homework
  project.md            if the course keeps project instructions per cohort
```

The cohort `README.md` is short and links-first:

```markdown
# <Course> <Year>

* [Course management platform](https://courses.datatalks.club/<slug>-<year>/)
* [FAQ](https://datatalks.club/faq/<course>.html)

Homework:

* [Module 1: <Title>](01-<slug>/homework.md)
* Module 2: <Title> — coming
```

List every module from the start, marking the unwritten ones `— coming`. Learners use this page to find their homework, and a module that is missing entirely reads as an error, while `— coming` reads as a schedule.

Name the module folders to match the module folders at the repo root. When a module is renamed between cohorts, the new cohort folder takes the new name.

Homework carries over as a starting point, not as a copy to ship. Re-solve it against the current materials before opening it: tool versions move, output changes, and a question that was fair last year can become unanswerable.

## 2. Archive Any Module the New Cohort Replaces

When a module at the repo root is rewritten, renamed, or dropped, copy its **previous content** into the previous cohort's folder before the rewrite lands:

```text
cohorts/<year-1>/<old-module-folder>/
  README.md
  any supporting files the module had
```

Use the folder name the module had then, not the new one. It is the previous cohort's module, so it keeps that year's name.

Then link the archive from the new module so the trail is visible:

```markdown
## Previous Cohort Materials

Related material from the previous cohort:

- [Archived module](../cohorts/<year-1>/<old-module>/)
```

## 3. Update the Root README

The syllabus section lists the current modules, in the current order, with the current titles. Check that:

- module numbers match the folder numbers
- module titles match the `# Module N — Title` heading in each module README
- the start date, cohort links, and events table point at this cohort

When modules are renumbered, the numbers move in the article filenames too.

## Checklist

- [ ] `cohorts/<year>/README.md` created, linking the platform and the FAQ
- [ ] Every module listed, unwritten ones marked `— coming`
- [ ] Homework folders created per module, named to match the root module folders
- [ ] Homework re-solved against the current materials before opening
- [ ] Replaced or renamed modules archived under `cohorts/<year-1>/` with their old folder names
- [ ] New modules link back to the archived version under "Previous Cohort Materials"
- [ ] Root README syllabus, dates, and events table updated
- [ ] Article filenames still match their module folders
