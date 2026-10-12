---
title: "Course Assets Map"
summary: "Map of repositories, file paths, website articles, FAQ configs, and structured data across all Zoomcamps."
doc_type: reference
tags:
  - course
  - assets
  - mapping
  - reference
owner_role: course-launch-owner
systems:
  - github
  - website
  - course-platform
---

# Course Assets Map

Where every course asset lives, so a new cohort is a list of known files rather than a search.
Use this with `01-launch-checklist.md`. The checklist says *what* to update; this says *where* it is.

## Repositories

| Repo | Local path | What it holds |
| :--- | :--- | :--- |
| `DataTalksClub/playbooks` | `~/git/playbooks` | Playbooks, campaign workspaces, copy banks, proof libraries. |
| `DataTalksClub/datatalksclub.github.io` | `~/git/datatalksclub.github.io` | Website: course articles, FAQ data, schema.org course data. |
| Course repo, one per course | see table below | Course materials, cohort folders, course README. |
| `DataTalksClub/course-management-platform` | — | Platform itself. Cohorts are created via `course-management-agent`. |

## Per-Course Assets

| Course | Course repo | Website article | FAQ data | schema.org data |
| :--- | :--- | :--- | :--- | :--- |
| **Machine Learning** | `machine-learning-zoomcamp` | `_posts/2023-08-17-machine-learning-zoomcamp.md` | `_data/faqs/machine-learning-zoomcamp.yml` | `_includes/course-structured-data/machine-learning-zoomcamp-structured-data.html` |
| **Data Engineering** | `data-engineering-zoomcamp` | `_posts/2023-11-18-data-engineering-zoomcamp.md` | `_data/faqs/data-engineering-zoomcamp.yml` | `_includes/course-structured-data/data-engineering-zoomcamp-structured-data.html` |
| **MLOps** | `mlops-zoomcamp` | `_posts/2024-03-07-mlops-zoomcamp.md` | `_data/faqs/mlops-zoomcamp.yml` | `_includes/course-structured-data/mlops-zoomcamp-structured-data.html` |
| **LLM** | `llm-zoomcamp` | `_posts/2024-11-11-llm-zoomcamp.md` | `_data/faqs/llm-zoomcamp.yml` | `_includes/course-structured-data/llm-zoomcamp-structured-data.html` |
| **AI Dev Tools** | `ai-dev-tools-zoomcamp` | `_posts/2025-09-23-ai-dev-tools-zoomcamp.md` | `_data/faqs/ai-dev-tools-zoomcamp.yml` | `_includes/course-structured-data/ai-dev-tools-zoomcamp-structured-data.html` |

Website paths are relative to `datatalksclub.github.io`.

## Slugs and URLs

| Course | Platform slug | Registration page | Hashtag |
| :--- | :--- | :--- | :--- |
| **Machine Learning** | `ml-zoomcamp-<year>` | `courses.datatalks.club/register/ml-zoomcamp/` | `#mlzoomcamp` |
| **Data Engineering** | `de-zoomcamp-<year>` | Airtable form | `#dezoomcamp` |
| **MLOps** | `mlops-zoomcamp-<year>` | Airtable form | `mlopszoomcamp` |
| **LLM** | `llm-zoomcamp-<year>` | Airtable form | `#llmzoomcamp` |
| **AI Dev Tools** | `ai-dev-tools-<year>` | `courses.datatalks.club/register/ai-dev-tools/` | `#aidevtools` |

## Subreddits (2 Posts per Cohort)

Each course gets two Reddit posts: one a month before the start announcing the cohort, and one on the start day.

| Course | Subreddit | Size | Confirmed |
| :--- | :--- | :--- | :--- |
| **Machine Learning** | `r/learnmachinelearning` | ~200k | Yes |
| **Data Engineering** | `r/dataengineering` | — | Yes |
| **MLOps** | `r/mlops` (or `r/MachineLearning`, `r/datascience`) | — | Check status first |
| **LLM** | `r/LLMDevs` | ~161k | Proposed |
| **AI Dev Tools** | `r/ChatGPTCoding` | ~383k | Proposed |

Rules before posting:
- Read subreddit self-promotion rules.
- Write genuinely for the community; do not copy/paste commercial ads.
- Add required flairs and check for megathreads.

## Order of Execution for New Cohort Launch

1. **Platform:** Run `course-management-agent` to create course cohort, repoint registration campaign, verify outline.
2. **Course Repo:** Create `cohorts/<year>/README.md`, archive replaced modules into `cohorts/<year-1>/`, update root README.
3. **Website:** Update article, FAQ YAML, and schema.org dates.
4. **Events:** Create pre-course workshop and Q&A on Luma, Meetup, LinkedIn Events.
5. **Promotion:** Schedule phased campaigns across DTC & Alexey social accounts, newsletter, and community channels.
