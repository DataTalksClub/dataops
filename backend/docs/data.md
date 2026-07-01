# Data Analysis: Trello Board & CSV Spreadsheets

## Source Data Overview

We have three data files in `data/`:

| File | Size | Description |
|------|------|-------------|
| `qVB6fAUG - datatalksclub.json` | 8.7 MB | Full Trello board export (DataTalksClub) |
| `TODO list - todo.csv` | 2 KB | Open/pending tasks from a Google Spreadsheet |
| `TODO list - done.csv` | 658 KB | Completed tasks from a Google Spreadsheet |

---

## 1. Trello Board Structure

### Board: DataTalksClub

**Lists (columns):**

| List | Status | Cards |
|------|--------|-------|
| Templates | active | 17 (13 are template cards) |
| Preparation | active | 49 |
| Announced | active | 22 |
| After event | active | 12 |
| Done (multiple archived) | closed | ~467 |

**Labels (9 total):**

| Label | Color | Cards |
|-------|-------|-------|
| Podcast | red | 168 |
| Open-Source Spotlight | purple | 96 |
| Webinar | yellow | 74 |
| Newsletter | blue | 60 |
| Book of the Week | green | 53 |
| Workshop | sky | 50 |
| Social media | black | 25 |
| Maven Lightning Lesson | lime | 5 |
| Office Hours | pink | 3 |

### Card Structure

Each Trello card has:
- **name**: Title with emoji prefix and type tag, e.g. `🎙️ [Podcast] 2026-Feb-15 - Topic - Speaker`
- **desc**: Description, usually with links to Google Docs
- **labels**: Content type categorization
- **idList**: Which list (workflow stage) the card is in
- **checklists**: Detailed step-by-step task lists (99.6% of cards have checklists)
- **isTemplate**: Boolean flag for template cards
- **due**, **dueComplete**: Optional due date tracking
- **dateLastActivity**: Last modification timestamp
- **closed**: Archived status

### Template Cards (13 total, `isTemplate: true`)

Templates define reusable workflows for recurring content types:

| # | Template | Checklists | Items |
|---|----------|-----------|-------|
| 1 | Newsletter Weekly email #XXX | 5 | 15 |
| 2 | Book of the Week | 7 | 20 |
| 3 | Podcast | 10 | 40 |
| 4 | Webinar | 9 | 28 |
| 5 | Workshop | 9 | 30 |
| 6 | Open-Source Spotlight | 5 | 14 |
| 7 | Course | 3 | 8 |
| 8 | Social media Weekly posts | 1 | 5 |
| 9 | Tax Report | 1 | 8 |
| 10 | Valeriia invoice | 0 | 0 |
| 11 | Maven LL | 2 | 7 |
| 12 | Office Hours | 1 | 5 |
| 13 | Newsletter #133 (legacy, older version) | 1 | 14 |

Each template has **multiple checklists** (workflow phases), and each checklist has **multiple items** (individual steps). Most items include links to process docs.

### Checklist Item Structure

```
{
  name: "Create a MailChimp campaign ([doc](https://docs.google.com/...))",
  state: "incomplete" | "complete",
  due: null | ISO date,
  idMember: null | member_id,
  pos: number (ordering)
}
```

### Naming Convention

Cards follow: `Emoji [Type] Date - Topic - Person`
- Newsletter: `📰 [Newsletter] Weekly email #XXX (DD MMM YYYY)`
- Podcast: `🎙️ [Podcast] 2026-MMM-DD - Topic - Name`
- Webinar: `📺 [Webinar] 2026-MMM-DD - Topic - Speaker`
- Workshop: `🔧 [Workshop] 2026-MMM-DD - Title - Name`
- Book: `📚 [Book of the Week] YYYY-MM-DD - Book - Author(s)`
- OSS: `⚙️ [Open-Source Spotlight] - Tool - Name`

---

## 2. CSV Spreadsheet Structure

### `TODO list - todo.csv` (open tasks)

Columns: `Date, Task, Notes, Status, Date finished, DONE`

- 27 rows of pending tasks
- Status is mostly `NEW`, a couple `DONE`
- Dates range from 2024-07-23 to 2026-02-23
- Tasks are ad-hoc (not template-based): podcast invites, video management, email processing
- Some tasks have multiline content (descriptions spanning multiple lines)

### `TODO list - done.csv` (completed tasks)

Columns: `Date, Task, Notes, Status, Date finished, Process document title, Process document link, Comment, ...`

- ~300+ rows of completed tasks
- Status is mostly `DONE`, occasional `NEW` or `DONEDONE` (typo)
- Date range: 2024 to 2026-02-20
- Highly repetitive recurring tasks:
  - "Invite people to Slack from https://airtable.com/..." (daily)
  - "Create new trello cards if necessary and go through existing ones" (daily)
  - "Make sure the newsletter for the next week is prepared" (weekly)
  - "Prepare a newsletter for the week after next" (weekly)
  - "Backup the mailing list from mailchimp to google drive" (weekly)
  - "Create a slack dump" (monthly)
  - "Process email ..." (ad-hoc, from email forwarding)
- Some rows are blank separators
- Additional empty columns after "Comment" (artifacts from spreadsheet)

---

## 3. Application Data Model (DataTasks)

### Templates

```javascript
{
  id: UUID,
  name: string,            // e.g. "Newsletter"
  type: string,            // e.g. "newsletter", "podcast", "webinar"
  emoji: string | null,    // e.g. "📰", "🎙️"
  tags: string[],          // e.g. ["Newsletter"]
  defaultAssigneeId: string | null,
  references: [{ name: string, url: string }],       // fixed links for every bundle
  bundleLinkDefinitions: [{ name: string }],          // link slots to fill per bundle
  triggerType: "automatic" | "manual",
  triggerSchedule: string | null,   // cron expression
  triggerLeadDays: number | null,   // days before anchor to create bundle
  taskDefinitions: [
    {
      refId: string,       // e.g. "collect-topics"
      description: string, // e.g. "Collect newsletter topics and links"
      offsetDays: number,  // e.g. -10 (10 days before anchor)
      isMilestone: boolean | null,
      assigneeId: string | null,
      instructionsUrl: string | null,
      requiredLinkName: string | null,  // e.g. "Luma"
      requiresFile: boolean | null
    }
  ],
  createdAt: ISO timestamp,
  updatedAt: ISO timestamp
}
```

Templates are flat: one level of task definitions. No nested checklists or sub-steps.

### Bundles

```javascript
{
  id: UUID,
  title: string,           // e.g. "Newsletter #150 (24 Feb 2026)"
  anchorDate: "YYYY-MM-DD",// base date for offset calculation
  description: string | null,
  templateId: string | null,
  status: "active" | "archived",
  emoji: string | null,    // inherited from template
  references: [{ name: string, url: string }],  // from template, read-only
  bundleLinks: [{ name: string, url: string }],  // fillable slots
  tags: string[],          // inherited from template
  createdAt: ISO timestamp,
  updatedAt: ISO timestamp
}
```

### Tasks

```javascript
{
  id: UUID,
  description: string,     // what needs to be done
  date: "YYYY-MM-DD",      // due date
  status: "todo" | "done" | "archived",
  comment: string | null,  // notes (not shown on main views)
  instructionsUrl: string | null,  // link to how-to document
  link: string | null,     // URL deliverable (e.g. Luma event link)
  requiredLinkName: string | null, // if set, task needs link before completion
  assigneeId: string | null,
  bundleId: UUID | null,   // link to bundle
  source: "manual" | "telegram" | "email" | "recurring" | "template",
  templateTaskRef: string | null,  // refId from template
  tags: string[],
  createdAt: ISO timestamp,
  updatedAt: ISO timestamp
}
```

### Recurring Configs

```javascript
{
  id: UUID,
  description: string,
  cronExpression: string,   // cron notation for schedule
  assigneeId: string | null,
  enabled: boolean,
  createdAt: ISO timestamp,
  updatedAt: ISO timestamp
}
```

---

## 4. Mapping: Trello/CSV -> Application

### 4.1 Trello Templates -> Application Templates

**Challenge**: Trello templates have a **two-level hierarchy** (checklists -> items), but the app has a **flat list** of task definitions.

**Mapping approach**: Flatten checklists into task definitions. Each checklist item becomes a task definition. The checklist name is used as a prefix/group identifier.

| Trello | App Template |
|--------|-------------|
| Template card name | `name` |
| Label name (Podcast, etc.) | `type` |
| Checklist items (flattened) | `taskDefinitions[]` |
| Checklist item text | `taskDefinitions[].description` |
| Checklist name + item index | `taskDefinitions[].refId` |
| (derived from checklist order) | `taskDefinitions[].offsetDays` |

**offsetDays derivation**: Trello templates don't have explicit day offsets. The migration script assigns offsets based on checklist ordering (early checklists get negative offsets, later ones get 0 or positive). This requires manual review.

### 4.2 Trello Cards (non-template) -> Bundles + Tasks

Each non-template Trello card in active lists (Preparation, Announced, After event) maps to a Bundle, with its checklist items becoming Tasks.

| Trello Card | App Entity |
|-------------|-----------|
| Card | Bundle |
| Card name | Bundle `title` |
| Card due date or date from name | Bundle `anchorDate` |
| Card description | Bundle `description` |
| Card attachments (non-Trello URLs) | Bundle `bundleLinks` |
| Card label emoji + tag | Bundle `emoji` + `tags` |
| Checklist items | Tasks (linked via `bundleId`) |
| Item text | Task `description` |
| Item state (complete/incomplete) | Task `status` (done/todo) |
| Item markdown links | Task `instructionsUrl` (first link extracted) |

### 4.3 CSV Tasks -> Tasks (standalone)

CSV tasks map directly to standalone tasks (no bundle):

| CSV Column | Task Field |
|-----------|-----------|
| Date | `date` |
| Task | `description` |
| Notes | `comment` |
| Status (NEW) | `status` = "todo" |
| Status (DONE) | `status` = "done" |
| (no bundle) | `bundleId` = null |
| "manual" | `source` = "manual" |

### 4.4 Recurring Tasks (from CSV patterns) -> Recurring Configs

Several tasks in the CSV repeat daily/weekly. These should become recurring configs:

| Pattern | Schedule | Description |
|---------|----------|-------------|
| "Invite people to Slack from..." | daily | Invite people to Slack from Airtable |
| "Create new trello cards if necessary..." | daily | Create new Trello cards and go through existing ones |
| "Make sure the newsletter for the next week is prepared" | weekly (Tue?) | Ensure newsletter is prepared for next week |
| "Prepare a newsletter for the week after next" | weekly | Prepare newsletter for week after next |
| "Backup the mailing list from mailchimp to google drive" | weekly | Backup MailChimp mailing list to Google Drive |
| "Create a slack dump" | monthly | Create Slack dump |

---

## 5. Inconsistencies & Issues

### 5.1 Structural Mismatch: Template Depth

Trello: Templates have nested checklists (2 levels: checklist -> items). A Podcast template has 10 checklists with 40+ items total.

App: Templates have flat `taskDefinitions[]` (1 level). Each definition is a single task.

Impact: Flattening loses the grouping context. A 40-item podcast template becomes 40 flat tasks. Consider either:
- Prefixing descriptions with checklist name: `"[Reach out] Create a proposed calendar invite..."`
- Or treating each checklist as a separate "phase" in the description

### 5.2 No offsetDays in Trello

Trello templates don't store relative day offsets. Items are ordered by position but don't have explicit timing. The migration must assign reasonable offsets manually or use a heuristic (e.g., distribute items across the timeline based on checklist order).

### 5.3 Template Types

Trello has 13 templates covering 10 content types. The app's `type` field only has 3 seed values: "newsletter", "course", "event".

New types needed: podcast, webinar, workshop, oss (open-source spotlight), social-media, tax-report, invoice, maven-ll, office-hours.

The app's `type` field is a free-form string, so this is not a code change - just new values.

### 5.4 CSV Data Quality

- Some rows are blank (separator lines in spreadsheet)
- One status value is `DONEDONE` (typo, should be `DONE`)
- Some statuses are `Done` (lowercase D) vs `DONE`
- Date formats vary: `2026-02-20` vs `2025-02-17 00:00:00` vs `02 Dec 2025`
- Some tasks in "done.csv" have status `NEW` - they are actually done 
- Multiline task descriptions (contain newlines within CSV quoted fields)
- Extra empty columns in done.csv

### 5.5 Rich Text in Checklist Items

Trello checklist items contain markdown links to process docs:
```
"Create a MailChimp campaign ([doc](https://docs.google.com/...))"
```

The app now has a dedicated `instructionsUrl` field on tasks. The migration extracts the first markdown link as `instructionsUrl` and cleans the description.

### 5.6 Card Description vs Task Comment

Trello card descriptions contain extensive links to Google Docs (overview docs, process docs). These map to the bundle's `references` array and the bundle's `description` field.

### 5.7 Done Cards (Historical Data)

The Trello board has ~467 cards in archived "Done" lists. These represent historical completed work. Importing them all would flood the system. Consider only importing active cards (Preparation, Announced, After event lists).

