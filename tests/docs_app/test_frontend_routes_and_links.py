from __future__ import annotations

import json
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
APP_JS = REPO_ROOT / "frontend" / "src" / "app.js"


def _extract_function(source: str, name: str) -> str:
    marker = f"function {name}("
    start = source.index(marker)
    function_start = start
    if source[max(0, start - 6) : start] == "async ":
        function_start = start - 6
    paren = source.index("(", start)
    paren_depth = 0
    signature_end = paren
    for index in range(paren, len(source)):
        if source[index] == "(":
            paren_depth += 1
        elif source[index] == ")":
            paren_depth -= 1
            if paren_depth == 0:
                signature_end = index
                break
    brace = source.index("{", signature_end)
    depth = 0
    for index in range(brace, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[function_start : index + 1]
    raise AssertionError(f"Could not extract function {name}")


def _run_app_js_functions(assertions: str, function_names: list[str]) -> dict:
    source = APP_JS.read_text(encoding="utf-8")
    functions = "\n\n".join(_extract_function(source, name) for name in function_names)
    script = f"""
const assert = require("node:assert/strict");
let allDocuments = [];
let documentIdMap = new Map();
let currentDoc = null;
let domainFilter = {{ value: "" }};
let typeFilter = {{ value: "" }};
let systemFilter = {{ value: "" }};
let tagFilter = {{ value: "" }};
const warnedOutsideContent = new Set();
const pushed = [];
const actionCalls = [];
const window = {{ location: {{ pathname: "/" }} }};
const history = {{
  pushState(state, _title, url) {{
    pushed.push({{ state, url }});
    window.location.pathname = url;
  }}
}};
const requestCalls = [];
const refreshCalls = [];
let mockRequestHandler = async (url, options = {{}}) => {{
  throw new Error(`Unhandled request: ${{url}}`);
}};
async function request(url, options = {{}}) {{
  requestCalls.push({{ url: String(url), options }});
  return mockRequestHandler(url, options);
}}
function workApiUrl(path) {{ return `/work${{path}}`; }}
async function refreshOperationsWorkSnapshot(options = {{}}) {{ refreshCalls.push(options); }}
function todayIsoDate() {{ return "2026-06-27"; }}
function reportError(message) {{ actionCalls.push({{ type: "error", message }}); }}
function resolveImageSrc(src) {{ return src; }}
function openDocument(path) {{ actionCalls.push({{ type: "doc", path }}); }}
function openTaskPanel(taskId) {{ actionCalls.push({{ type: "task", taskId }}); }}
function openBundlePanel(bundleId) {{ actionCalls.push({{ type: "bundle", bundleId }}); }}
function openQuickWorkflowForm(options) {{ actionCalls.push({{ type: "startWorkflow", options }}); }}
function makeElement(tag) {{
  const element = {{
    tagName: tag.toUpperCase(),
    type: "",
    className: "",
    textContent: "",
    value: "",
    disabled: false,
    hidden: false,
    children: [],
    listeners: {{}},
    style: {{}},
    classList: {{
      values: [],
      add(...names) {{
        this.values.push(...names);
      }},
    }},
    append(...items) {{
      for (const item of items) {{
        if (item && typeof item === "object") item.parentNode = this;
        this.children.push(item);
      }}
    }},
    replaceChildren(...items) {{
      this.children = [];
      this.append(...items);
    }},
    addEventListener(type, handler) {{
      this.listeners[type] = handler;
    }},
    setAttribute(name, value) {{
      this[name] = String(value);
    }},
    querySelector(selector) {{
      if (!selector.startsWith(".")) return null;
      const className = selector.slice(1);
      const stack = [...this.children];
      while (stack.length > 0) {{
        const child = stack.shift();
        if (!child || typeof child !== "object") continue;
        const classes = String(child.className || "").split(/\\s+/).filter(Boolean);
        if (classes.includes(className)) return child;
        stack.unshift(...(child.children || []));
      }}
      return null;
    }},
    remove() {{
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }},
    click() {{
      if (this.listeners.click) return this.listeners.click({{ type: "click" }});
    }},
  }};
  return element;
}}
const bodyElement = makeElement("body");
const document = {{
  body: bodyElement,
  createElement(tag) {{
    return makeElement(tag);
  }},
  createTextNode(text) {{
    return {{ nodeType: 3, textContent: String(text) }};
  }},
}};
{functions}
void (async () => {{
{assertions}
console.log(JSON.stringify({{ ok: true, pushed }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    result = subprocess.run(
        ["node", "-e", script],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def test_direct_doc_and_folder_urls_map_to_content_paths_and_push_visible_urls():
    result = _run_app_js_functions(
        """
window.location.pathname = "/finance/reference/invoices.md";
assert.equal(docPathFromLocation(), "content/finance/reference/invoices.md");
assert.equal(folderPathFromLocation(), "");

window.location.pathname = "/content/systems/airtable/sops/update-record.md";
assert.equal(docPathFromLocation(), "content/systems/airtable/sops/update-record.md");

window.location.pathname = "/finance/bookkeeping";
assert.equal(docPathFromLocation(), "");
assert.equal(folderPathFromLocation(), "finance/bookkeeping");

window.location.pathname = "/content/finance/bookkeeping";
assert.equal(folderPathFromLocation(), "finance/bookkeeping");

allDocuments = [
  { path: "content/finance/bookkeeping/sops/create-invoice.md" },
  { path: "content/systems/airtable/sops/update-record.md" },
];
assert.equal(folderExists("finance/bookkeeping"), true);
assert.equal(folderExists("finance/payroll"), false);

setDocumentUrl("content/finance/reference/invoices.md");
assert.equal(pushed.at(-1).url, "/finance/reference/invoices.md");
assert.deepEqual(pushed.at(-1).state, { path: "content/finance/reference/invoices.md" });

setFolderUrl("systems/airtable/sops");
assert.equal(pushed.at(-1).url, "/systems/airtable/sops");
assert.deepEqual(pushed.at(-1).state, { folder: "systems/airtable/sops" });
""",
        [
            "cleanPath",
            "docPathFromLocation",
            "folderPathFromLocation",
            "folderExists",
            "setDocumentUrl",
            "setFolderUrl",
        ],
    )

    assert result["ok"] is True


def test_markdown_renderer_handles_tables_code_quotes_images_and_safe_external_links():
    result = _run_app_js_functions(
        """
const html = markdownToHtml([
  "| Name | Value |",
  "| --- | --- |",
  "| CRM | `paid` |",
  "",
  "```",
  "<unsafe>",
  "```",
  "",
  "![Chart](../images/chart.png)",
  "",
  "[External](https://example.com) and [unsafe](javascript:alert(1))"
].join("\\n"));

assert.match(html, /<table><thead><tr><th>Name<\\/th><th>Value<\\/th><\\/tr><\\/thead>/);
assert.match(html, /<td><code>paid<\\/code><\\/td>/);
assert.match(html, /<pre><code>&lt;unsafe&gt;<\\/code><\\/pre>/);
assert.match(html, /<img src="\\.\\.\\/images\\/chart\\.png" alt="Chart" loading="lazy">/);
assert.match(html, /href="https:\\/\\/example\\.com" target="_blank" rel="noopener"/);
assert.match(html, /<a href="#">unsafe<\\/a>/);
""",
        [
            "markdownToHtml",
            "splitTableRow",
            "inlineMd",
            "resolveMarkdownDocLink",
            "resolveDocReference",
            "resolveDocReference",
            "escapeHtmlAttr",
            "escapeHtml",
        ],
    )

    assert result["ok"] is True


def test_filter_and_highlight_helpers_match_sidebar_search_expectations():
    result = _run_app_js_functions(
        """
const documents = [
  { path: "content/finance/reference/invoices.md", domain: "finance", doc_type: "reference", systems: ["finom"], tags: ["money"], title: "Invoices" },
  { path: "content/systems/airtable/sops/update-record.md", domain: "systems", doc_type: "sop", systems: ["airtable"], tags: ["crm"], title: "Update Airtable" },
  { path: "content/finance/sops/pay-vat.md", domain: "finance", doc_type: "sop", systems: ["finom"], tags: ["tax"], title: "Pay VAT" },
];

domainFilter.value = "finance";
typeFilter.value = "sop";
systemFilter.value = "finom";
tagFilter.value = "tax";
assert.deepEqual(filterDocuments(documents).map((doc) => doc.path), ["content/finance/sops/pay-vat.md"]);
assert.equal(activeFilterCount(), 4);

const el = { textContent: "", innerHTML: "" };
setHighlightedText(el, "Invoice (USD) <draft>", "invoice (usd)");
assert.equal(el.innerHTML, "<mark>Invoice</mark> <mark>(USD)</mark> &lt;draft&gt;");
assert.equal(titleFromMarkdown("---\\ntitle: \\"CRM Invoice\\"\\n---\\n# Fallback"), "CRM Invoice");
assert.equal(basename("content/finance/sops/pay-vat.md"), "pay vat");
""",
        [
            "filterDocuments",
            "activeFilterCount",
            "setHighlightedText",
            "escapeRegex",
            "titleFromMarkdown",
            "basename",
            "cleanPath",
        ],
    )

    assert result["ok"] is True


def test_operations_home_model_builds_daily_lanes_from_live_work_payloads():
    result = _run_app_js_functions(
        """
const docs = [
  {
    path: "content/tasks/templates/newsletter.md",
    title: "Newsletter Task Template",
    summary: "Git-backed DataOps workflow template for the Newsletter operational workflow.",
    doc_type: "task-template",
    tags: ["Newsletter", "task-template", "newsletter"],
  },
  {
    path: "content/tasks/templates/podcast.md",
    title: "Podcast Task Template",
    summary: "Git-backed DataOps workflow template for the Podcast operational workflow.",
    doc_type: "task-template",
    tags: ["Podcast", "task-template", "podcast"],
  },
  {
    path: "content/tasks/templates/social-media.md",
    title: "Social Media Weekly Task Template",
    summary: "Git-backed DataOps workflow template for the Social Media Weekly operational workflow.",
    doc_type: "task-template",
    tags: ["Social media", "task-template", "social-media"],
  },
  {
    path: "content/media/podcast/templates/remind-guest.md",
    title: "Podcast reminder email",
    summary: "Follow up with the guest before the event.",
    doc_type: "template",
    tags: ["podcast", "email"],
  },
  {
    path: "content/finance/reference/invoices-receipts-and-statements.md",
    title: "Invoices, Receipts, And Statements",
    summary: "Finance reference.",
    doc_type: "reference",
    tags: ["finance"],
  },
];

const model = buildOperationsHomeModel(docs, {
  today: "2026-06-27",
  draftPaths: ["content/media/podcast/templates/remind-guest.md"],
  workSnapshot: {
    loaded: true,
    tasks: [
      {
        id: "task-today",
        description: "Publish newsletter",
        date: "2026-06-27",
        status: "todo",
        assigneeId: "ops",
      },
      {
        id: "task-unassigned",
        description: "Unassigned urgent work",
        date: "2026-06-27",
        status: "todo",
      },
      {
        id: "task-other-owner",
        description: "Other owner task",
        date: "2026-06-27",
        status: "todo",
        assigneeId: "other",
      },
      {
        id: "task-overdue",
        description: "Upload podcast recording",
        date: "2026-06-25",
        status: "todo",
        bundleId: "bundle-podcast",
        requiredLinkName: "Recording link",
      },
      {
        id: "task-waiting",
        description: "Confirm guest bio",
        date: "2026-06-28",
        status: "waiting",
        waitingFor: "guest",
        followUpAt: "2026-06-27",
        bundleId: "bundle-podcast",
      },
      {
        id: "task-done",
        description: "Completed task",
        date: "2026-06-27",
        status: "done",
      },
    ],
    bundles: [
      {
        id: "bundle-podcast",
        title: "Podcast episode: streaming systems",
        anchorDate: "2026-06-26",
        stage: "post-production",
        status: "active",
        bundleLinks: [{ name: "YouTube", url: "" }],
      },
      {
        id: "bundle-archived",
        title: "Archived bundle",
        status: "archived",
      },
    ],
    bundleTasks: {
      "bundle-podcast": [
        { id: "task-overdue", description: "Upload podcast recording", date: "2026-06-25", status: "todo", bundleId: "bundle-podcast", requiredLinkName: "Recording link" },
        { id: "task-waiting", description: "Confirm guest bio", date: "2026-06-28", status: "waiting", waitingFor: "guest", followUpAt: "2026-06-27", bundleId: "bundle-podcast" },
        { id: "task-complete", description: "Prepare notes", date: "2026-06-24", status: "done", bundleId: "bundle-podcast" },
      ],
    },
    currentOperatorId: "ops",
  },
  recurringSnapshot: {
    loaded: true,
    recurringConfigs: [
      { id: "rec-newsletter", description: "Weekly newsletter", cronExpression: "0 9 * * 3", enabled: true },
      { id: "rec-tax", description: "Monthly tax report", cronExpression: "0 10 5 * *", enabled: false },
    ],
  },
});

assert.equal(model.stats.totalDocs, 5);
assert.equal(model.stats.workflowTemplates, 3);
assert.equal(model.stats.recurringTemplates, 2);
assert.equal(model.stats.liveLoaded, true);
assert.equal(model.stats.todayTasks, 2);
assert.equal(model.stats.overdueTasks, 1);
assert.equal(model.stats.waitingTasks, 1);
assert.equal(model.stats.followUpTasks, 1);
assert.equal(model.stats.missingProofTasks, 1);
assert.equal(model.stats.activeBundles, 1);
assert.equal(model.stats.recurringConfigs, 2);
assert.equal(model.stats.enabledRecurringConfigs, 1);
assert.deepEqual(model.recurring.configs.map((config) => config.id), ["rec-newsletter", "rec-tax"]);
assert.deepEqual(model.recurring.enabled.map((config) => config.id), ["rec-newsletter"]);
assert.deepEqual(model.recurring.disabled.map((config) => config.id), ["rec-tax"]);
assert.deepEqual(model.templates.map((template) => template.slug), ["newsletter", "podcast", "social-media"]);
assert.equal(model.templates[0].title, "Newsletter");
assert.equal(model.templates[0].recurring, true);
assert.equal(model.templates[1].atRisk, true);

const lanes = Object.fromEntries(model.lanes.map((lane) => [lane.id, lane]));
assert.deepEqual(model.lanes.map((lane) => lane.id), ["overdue", "followups", "today", "waiting", "bundles"]);
assert.deepEqual(lanes.today.items.map((item) => item.title), ["Publish newsletter", "Unassigned urgent work"]);
assert.deepEqual(lanes.today.items.map((item) => item.taskId), ["task-today", "task-unassigned"]);
assert.equal(lanes.today.items[0].nextAction, "Mark done");
assert.match(lanes.today.items[0].meta, /No proof required/);
assert.equal(model.stats.currentOperatorId, "ops");
assert.deepEqual(lanes.overdue.items.map((item) => item.title), ["Upload podcast recording"]);
assert.equal(lanes.overdue.items[0].nextAction, "Add Recording link");
assert.equal(lanes.overdue.items[0].proof.label, "Missing proof: Recording link");
assert.equal(lanes.followups.items[0].summary, "Waiting for guest; follow up Today");
assert.equal(lanes.followups.items[0].nextAction, "Follow up");
assert.deepEqual(lanes.waiting.items.map((item) => item.title), []);
assert.equal(lanes.bundles.items[0].title, "Podcast episode: streaming systems");
assert.equal(lanes.bundles.items[0].bundleId, "bundle-podcast");
assert.equal(lanes.bundles.items[0].progress.done, 1);
assert.equal(lanes.bundles.items[0].progress.total, 3);
assert.equal(lanes.bundles.items[0].progress.overdue, 1);
assert.equal(lanes.bundles.items[0].progress.waiting, 1);
assert.equal(lanes.bundles.items[0].progress.missingLinks, 2);
assert.equal(lanes.bundles.items[0].progress.missingProof, 2);
assert.equal(lanes.bundles.items[0].progress.nextDueTask.id, "task-overdue");
assert.match(lanes.bundles.items[0].summary, /Next: Upload podcast recording/);
assert.equal(lanes.bundles.items[0].risk, "high");
assert.equal(model.futureSections.map((section) => section.title).join(", "), "Inbox, Assistant Jobs, Process Quality");
assert.equal(model.references.some((ref) => ref.title === "DataOps V1 Goal" && ref.href.includes(".goal-v1.md")), true);
assert.equal(model.references.some((ref) => ref.path === "content/finance/reference/invoices-receipts-and-statements.md"), true);
""",
        [
            "buildOperationsHomeModel",
            "normalizeOperationsWorkSnapshot",
            "normalizeBundleTaskMap",
            "tasksFromWorkPayload",
            "bundlesFromWorkPayload",
            "recurringConfigsFromPayload",
            "currentOperatorIdFromPayload",
            "normalizeOperationsRecurringSnapshot",
            "allWorkTasks",
            "dedupeWorkTasks",
            "sortWorkTasks",
            "taskSortDate",
            "isOpenWorkTask",
            "isTaskDueToday",
            "isCurrentOperatorTodayTask",
            "isTaskOverdue",
            "isWaitingOrFollowUpTask",
            "isFollowUpDueTask",
            "taskDate",
            "isActiveWorkBundle",
            "sortActiveWorkBundles",
            "summarizeBundleProgress",
            "nextDueOpenTask",
            "missingBundleLinks",
            "hasTaskFileEvidence",
            "taskProofState",
            "taskRequiresApprovedArtifact",
            "hasApprovedArtifactEvidence",
            "taskSourceLabel",
            "taskNextActionLabel",
            "isWorkflowTemplateDoc",
            "summarizeWorkflowTemplate",
            "workflowSlugFromDoc",
            "workflowPriority",
            "isRecurringWorkflowSlug",
            "isAtRiskWorkflowSlug",
            "isFollowUpDoc",
            "operationItemFromTemplate",
            "operationItemFromDoc",
            "operationItemFromTask",
            "operationItemFromBundle",
            "workTaskTitle",
            "workBundleTitle",
            "recurringConfigTitle",
            "formatTaskDateMeta",
            "labelizeWorkValue",
            "todayIsoDate",
            "addDaysIso",
            "toIsoDate",
            "parseIsoDateValue",
            "compareIsoDate",
            "isBeforeIsoDate",
            "dedupeOperationItems",
            "buildOperationsFutureSections",
            "buildOperationsReferenceLinks",
            "basename",
            "cleanPath",
        ],
    )

    assert result["ok"] is True


def test_operations_home_model_distinguishes_empty_live_data_from_unavailable_work_api():
    result = _run_app_js_functions(
        """
const docs = [
  {
    path: "content/tasks/templates/newsletter.md",
    title: "Newsletter Task Template",
    summary: "Git-backed DataOps workflow template for the Newsletter operational workflow.",
    doc_type: "task-template",
    tags: ["task-template"],
  },
];

const emptyLive = buildOperationsHomeModel(docs, {
  today: "2026-06-27",
  workSnapshot: { loaded: true, tasks: [], bundles: [] },
});
assert.equal(emptyLive.stats.liveLoaded, true);
assert.equal(emptyLive.lanes.find((lane) => lane.id === "today").empty, "No live tasks due today.");
assert.equal(emptyLive.lanes.every((lane) => lane.items.length === 0), true);
assert.equal(emptyLive.runtime.connected, true);
assert.deepEqual(emptyLive.runtime.errors, []);

const unavailable = buildOperationsHomeModel(docs, {
  today: "2026-06-27",
  workSnapshot: { loaded: false, errors: ["Unexpected non-JSON API response"] },
});
assert.equal(unavailable.stats.liveLoaded, false);
assert.equal(unavailable.templates.length, 1);
assert.equal(unavailable.lanes.every((lane) => lane.items.length === 0), true);
assert.match(unavailable.lanes.find((lane) => lane.id === "overdue").empty, /unavailable/);
assert.equal(unavailable.runtime.connected, false);
assert.deepEqual(unavailable.runtime.errors, ["Unexpected non-JSON API response"]);

assert.deepEqual(recurringConfigsFromPayload({ configs: [{ id: "rec-local" }] }).map((config) => config.id), ["rec-local"]);
assert.equal(currentOperatorIdFromPayload({ user: { id: "ops" } }), "ops");
""",
        [
            "buildOperationsHomeModel",
            "normalizeOperationsWorkSnapshot",
            "normalizeBundleTaskMap",
            "tasksFromWorkPayload",
            "bundlesFromWorkPayload",
            "recurringConfigsFromPayload",
            "currentOperatorIdFromPayload",
            "normalizeOperationsRecurringSnapshot",
            "allWorkTasks",
            "dedupeWorkTasks",
            "sortWorkTasks",
            "taskSortDate",
            "isOpenWorkTask",
            "isTaskDueToday",
            "isCurrentOperatorTodayTask",
            "isTaskOverdue",
            "isWaitingOrFollowUpTask",
            "isFollowUpDueTask",
            "taskDate",
            "isActiveWorkBundle",
            "sortActiveWorkBundles",
            "summarizeBundleProgress",
            "nextDueOpenTask",
            "missingBundleLinks",
            "hasTaskFileEvidence",
            "taskProofState",
            "taskRequiresApprovedArtifact",
            "hasApprovedArtifactEvidence",
            "taskSourceLabel",
            "taskNextActionLabel",
            "isWorkflowTemplateDoc",
            "summarizeWorkflowTemplate",
            "workflowSlugFromDoc",
            "workflowPriority",
            "isRecurringWorkflowSlug",
            "isAtRiskWorkflowSlug",
            "isFollowUpDoc",
            "operationItemFromTemplate",
            "operationItemFromDoc",
            "operationItemFromTask",
            "operationItemFromBundle",
            "workTaskTitle",
            "workBundleTitle",
            "recurringConfigTitle",
            "formatTaskDateMeta",
            "labelizeWorkValue",
            "todayIsoDate",
            "addDaysIso",
            "toIsoDate",
            "parseIsoDateValue",
            "compareIsoDate",
            "isBeforeIsoDate",
            "dedupeOperationItems",
            "buildOperationsFutureSections",
            "buildOperationsReferenceLinks",
            "basename",
            "cleanPath",
        ],
    )

    assert result["ok"] is True


def test_operations_home_runtime_and_future_sections_render_honest_states():
    result = _run_app_js_functions(
        """
const runtime = renderOperationsRuntimeState({
  connected: false,
  errors: ["Unexpected non-JSON API response"],
});
assert.equal(runtime.className, "ops-runtime-state");
assert.equal(runtime.children[0].textContent, "Live work data unavailable");
assert.match(runtime.children[1].textContent, /could not load \\/work\\/api/);
assert.equal(runtime.children[2].children[0].textContent, "Unexpected non-JSON API response");

const connected = renderOperationsRuntimeState({ connected: true, errors: [] });
assert.equal(connected, null);

const future = renderOperationsFutureSections(buildOperationsFutureSections());
assert.equal(future.className, "ops-section ops-future-section");
assert.equal(future.children[0].children[0].textContent, "Incoming And Quality Signals");
const cards = future.children[1].children;
assert.equal(cards.length, 3);
assert.equal(cards[0].children[0].textContent, "Inbox");
assert.equal(cards[0].children[1].textContent, "Not connected yet");
assert.match(cards[0].children[2].textContent, /#31/);
assert.equal(cards[1].children[0].textContent, "Assistant Jobs");
assert.match(cards[1].children[2].textContent, /#30/);
assert.equal(cards[2].children[0].textContent, "Process Quality");
assert.match(cards[2].children[2].textContent, /#35/);
""",
        [
            "buildOperationsFutureSections",
            "renderOperationsRuntimeState",
            "renderOperationsFutureSections",
        ],
    )

    assert result["ok"] is True


def test_recurring_schedule_helpers_format_and_build_cron_expressions():
    result = _run_app_js_functions(
        """
assert.equal(formatRecurringSchedule("15 9 * * *"), "Daily at 09:15");
assert.equal(formatRecurringSchedule("0 10 * * 3"), "Weekly on Wednesday at 10:00");
assert.equal(formatRecurringSchedule("30 8 5 * *"), "Monthly on day 5 at 08:30");

assert.equal(cronExpressionFromRecurringForm("daily", "09:15", "1", "1"), "15 9 * * *");
assert.equal(cronExpressionFromRecurringForm("weekly", "10:00", "3", "1"), "0 10 * * 3");
assert.equal(cronExpressionFromRecurringForm("monthly", "08:30", "1", "5"), "30 8 5 * *");
""",
        [
            "formatRecurringSchedule",
            "weekdayName",
            "cronExpressionFromRecurringForm",
        ],
    )

    assert result["ok"] is True


def test_live_workflow_template_matching_uses_exact_unique_template_identity():
    result = _run_app_js_functions(
        """
const liveTemplates = [
  { id: "tmpl-newsletter", name: "Newsletter", type: "newsletter" },
  { id: "tmpl-social", name: "Social Media Weekly", type: "social-media" },
];

assert.equal(findLiveWorkflowTemplate(liveTemplates, { slug: "newsletter", title: "Newsletter" }).id, "tmpl-newsletter");
assert.equal(findLiveWorkflowTemplate(liveTemplates, { slug: "social-media", title: "Social Media Weekly" }).id, "tmpl-social");
assert.equal(findLiveWorkflowTemplate(liveTemplates, { templateId: "tmpl-social" }).id, "tmpl-social");
assert.equal(findLiveWorkflowTemplate(liveTemplates, { title: "Newsletter" }), null);
assert.equal(normalizeTemplateMatchValue("Newsletter Task Template"), "newsletter");
""",
        [
            "findLiveWorkflowTemplate",
            "normalizeTemplateMatchValue",
        ],
    )

    assert result["ok"] is True


def test_live_workflow_template_matching_rejects_ambiguous_matches():
    result = _run_app_js_functions(
        """
const duplicateTypeTemplates = [
  { id: "tmpl-newsletter-a", name: "Newsletter A", type: "newsletter" },
  { id: "tmpl-newsletter-b", name: "Newsletter B", type: "newsletter" },
];
const duplicateIdTemplates = [
  { id: "tmpl-newsletter", name: "Newsletter A", type: "newsletter" },
  { id: "tmpl-newsletter", name: "Newsletter B", type: "newsletter-alt" },
];

assert.equal(findLiveWorkflowTemplate(duplicateTypeTemplates, { slug: "newsletter" }), null);
assert.equal(findLiveWorkflowTemplate(duplicateIdTemplates, { templateId: "tmpl-newsletter" }), null);
""",
        ["findLiveWorkflowTemplate", "normalizeTemplateMatchValue"],
    )

    assert result["ok"] is True


def test_quick_workflow_form_preselects_template_and_posts_bundle():
    result = _run_app_js_functions(
        """
mockRequestHandler = async (url, options = {}) => {
  if (String(url) === "/work/api/templates") {
    return {
      templates: [
        { id: "tmpl-newsletter", name: "Newsletter", type: "newsletter" },
        { id: "tmpl-social", name: "Social Media Weekly", type: "social-media" },
      ],
    };
  }
  if (String(url) === "/work/api/bundles") {
    return { bundle: { id: "bundle-newsletter" } };
  }
  throw new Error(`Unexpected request ${url}`);
};

await openQuickWorkflowForm({
  template: {
    title: "Newsletter",
    slug: "newsletter",
    path: "content/tasks/templates/newsletter.md",
  },
});

assert.equal(requestCalls[0].url, "/work/api/templates");
const overlay = document.body.children.at(-1);
const body = overlay.querySelector(".quick-form-body");
const workflowForm = body.children[0];
const templateSelect = workflowForm.children[0].children[0];
const titleInput = workflowForm.children[1].children[0];
const anchorInput = workflowForm.children[2].children[0];
const createButton = workflowForm.children[3];

assert.equal(templateSelect.value, "tmpl-newsletter");
assert.equal(titleInput.value, "Newsletter");
assert.equal(anchorInput.value, "2026-06-27");

await createButton.click();
assert.equal(requestCalls[1].url, "/work/api/bundles");
assert.deepEqual(JSON.parse(requestCalls[1].options.body), {
  templateId: "tmpl-newsletter",
  anchorDate: "2026-06-27",
  title: "Newsletter",
});
assert.deepEqual(actionCalls.at(-1), { type: "bundle", bundleId: "bundle-newsletter" });
assert.deepEqual(refreshCalls.at(-1), { rerender: true });
assert.equal(document.body.children.includes(overlay), false);
""",
        [
            "openQuickWorkflowForm",
            "createQuickFormOverlay",
            "createQuickInput",
            "findLiveWorkflowTemplate",
            "normalizeTemplateMatchValue",
        ],
    )

    assert result["ok"] is True


def test_workflow_template_card_starts_workflow_and_keeps_doc_action():
    result = _run_app_js_functions(
        """
const card = renderWorkflowTemplateCard({
  title: "Newsletter",
  summary: "Weekly newsletter workflow.",
  slug: "newsletter",
  path: "content/tasks/templates/newsletter.md",
  recurring: true,
  atRisk: true,
  tags: ["newsletter"],
});

assert.equal(card.tagName, "ARTICLE");
assert.equal(card.children[0].textContent, "Newsletter");
const actions = card.children[3];
assert.equal(actions.className, "ops-template-actions");
actions.children[0].click();
assert.equal(actionCalls.at(-1).type, "startWorkflow");
assert.equal(actionCalls.at(-1).options.template.slug, "newsletter");

assert.equal(actions.children[1].textContent, "View process doc");
actions.children[1].click();
assert.deepEqual(actionCalls.at(-1), { type: "doc", path: "content/tasks/templates/newsletter.md" });
""",
        ["renderWorkflowTemplateCard"],
    )

    assert result["ok"] is True


def test_task_instruction_doc_panel_resolves_doc_ids_and_handles_missing_docs():
    result = _run_app_js_functions(
        """
documentIdMap = new Map([
  ["sop.media.podcast.create-podcast-document", {
    id: "sop.media.podcast.create-podcast-document",
    title: "Create a podcast document",
    doc_type: "sop",
    path: "content/media/podcast/sops/create-a-podcast-document.md",
    summary: "Prepare the podcast planning document.",
  }],
]);

const panel = renderTaskInstructionDoc({
  instructionDocId: "sop.media.podcast.create-podcast-document",
  instructionStepId: "4",
  phase: "preparation",
  systems: ["google-drive", "github"],
  validation: { requiredEvidence: "Podcast document link" },
});

assert.equal(panel.className, "task-instruction-doc");
assert.equal(panel.children[0].textContent, "Process doc");
assert.equal(panel.children[1].textContent, "Create a podcast document");
panel.children[1].click();
assert.deepEqual(actionCalls.at(-1), {
  type: "doc",
  path: "content/media/podcast/sops/create-a-podcast-document.md",
});
assert.equal(panel.querySelector(".ops-card-chips").children.length, 2);
assert.equal(panel.children[4].children[1].textContent, "Required evidence: Podcast document link");

const missing = renderTaskInstructionDoc({ instructionDocId: "missing.doc" });
assert.equal(missing.children[1].textContent, "Document unavailable: missing.doc");
""",
        [
            "resolveDocReference",
            "formatMetaText",
            "formatValidationInstruction",
            "renderTaskInstructionDoc",
            "workTaskTitle",
        ],
    )

    assert result["ok"] is True


def test_task_instruction_doc_panel_resolves_newsletter_doc_ids():
    result = _run_app_js_functions(
        """
documentIdMap = new Map([
  ["sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter", {
    id: "sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter",
    title: "Fill in the sponsored block in the newsletter",
    doc_type: "sop",
    path: "content/newsletter/sponsorship/sops/fill-in-the-sponsored-block-in-the-newsletter.md",
    summary: "Fill the newsletter sponsored block in Mailchimp.",
  }],
  ["template.newsletter.create-newsletter-draft-from-template-in-mailchimp", {
    id: "template.newsletter.create-newsletter-draft-from-template-in-mailchimp",
    title: "Create a newsletter draft from a template in Mailchimp",
    doc_type: "template",
    path: "content/internal-admin/templates/create-a-newsletter-draft-from-a-template-in-mailchimp-10-01-2024-update.md",
    summary: "Create a Mailchimp newsletter draft from an existing template.",
  }],
]);

const sponsorPanel = renderTaskInstructionDoc({
  instructionDocId: "sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter",
  phase: "draft-assembly",
  systems: ["mailchimp", "google-docs"],
  validation: { requiredEvidence: "Sponsored block filled or not sponsored this week" },
});

assert.equal(sponsorPanel.className, "task-instruction-doc");
assert.equal(sponsorPanel.children[1].textContent, "Fill in the sponsored block in the newsletter");
sponsorPanel.children[1].click();
assert.deepEqual(actionCalls.at(-1), {
  type: "doc",
  path: "content/newsletter/sponsorship/sops/fill-in-the-sponsored-block-in-the-newsletter.md",
});
assert.equal(sponsorPanel.querySelector(".ops-card-chips").children.length, 2);

const draftPanel = renderTaskInstructionDoc({
  instructionDocId: "template.newsletter.create-newsletter-draft-from-template-in-mailchimp",
  phase: "draft-assembly",
  systems: ["mailchimp"],
});
assert.equal(draftPanel.children[1].textContent, "Create a newsletter draft from a template in Mailchimp");
draftPanel.children[1].click();
assert.deepEqual(actionCalls.at(-1), {
  type: "doc",
  path: "content/internal-admin/templates/create-a-newsletter-draft-from-a-template-in-mailchimp-10-01-2024-update.md",
});
""",
        [
            "resolveDocReference",
            "formatMetaText",
            "formatValidationInstruction",
            "renderTaskInstructionDoc",
            "workTaskTitle",
        ],
    )

    assert result["ok"] is True


def test_operations_lane_items_open_task_and_bundle_panels():
    result = _run_app_js_functions(
        """
const taskButton = renderOperationsLaneItem({
  title: "Send follow-up",
  summary: "Waiting for guest",
  meta: "waiting",
  taskId: "task-1",
  risk: "medium",
});
taskButton.click();
assert.deepEqual(actionCalls.at(-1), { type: "task", taskId: "task-1" });
assert.equal(taskButton.children[0].textContent, "Send follow-up");
assert.equal(taskButton.children[1].textContent, "Waiting for guest");

const bundleButton = renderOperationsLaneItem({
  title: "Podcast episode",
  summary: "Post-production",
  meta: "2/5 tasks",
  bundleId: "bundle-1",
  risk: "high",
  progress: { label: "2/5 tasks", percent: 40 },
});
bundleButton.click();
assert.deepEqual(actionCalls.at(-1), { type: "bundle", bundleId: "bundle-1" });
assert.equal(bundleButton.children[2].className, "ops-progress");
""",
        ["renderOperationsLaneItem"],
    )

    assert result["ok"] is True


def test_request_rejects_non_json_api_responses():
    result = _run_app_js_functions(
        """
global.fetch = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () => "<!doctype html><title>Login</title>",
});

await assert.rejects(
  () => request("https://ops.example.test/work/api/tasks"),
  /Unexpected non-JSON API response/,
);

global.fetch = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () => JSON.stringify({ status: "ok" }),
});

assert.deepEqual(await request("https://ops.example.test/work/api/health"), { status: "ok" });
""",
        ["request"],
    )

    assert result["ok"] is True


def test_notification_panel_reports_work_api_failures_honestly():
    result = _run_app_js_functions(
        """
workBellBody = makeElement("div");
workBellNotifications = [];
workBellError = "Unexpected non-JSON API response";

renderWorkBellPanel();
assert.equal(workBellBody.children.length, 1);
assert.equal(workBellBody.children[0].className, "work-bell-empty is-error");
assert.match(workBellBody.children[0].textContent, /Notifications unavailable/);
assert.match(workBellBody.children[0].textContent, /Unexpected non-JSON API response/);

workBellError = "";
renderWorkBellPanel();
assert.equal(workBellBody.children[0].textContent, "No active notifications.");
""",
        ["renderWorkBellPanel"],
    )

    assert result["ok"] is True


def test_mobile_shell_exposes_notification_panel_entrypoint():
    index = (REPO_ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    source = APP_JS.read_text(encoding="utf-8")

    assert 'id="mobile-work-bell-button"' in index
    assert 'aria-label="Notifications"' in index
    assert 'const mobileWorkBellButton = document.querySelector("#mobile-work-bell-button");' in source
    assert 'mobileWorkBellButton?.addEventListener("click", toggleWorkBellPanel);' in source


def test_editor_title_is_wrappable_for_mobile_viewports():
    index = (REPO_ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    styles = (REPO_ROOT / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")
    source = APP_JS.read_text(encoding="utf-8")

    assert '<textarea id="document-title" class="document-title" rows="1"' in index
    assert "field-sizing: content;" in styles
    assert "overflow: hidden;" in styles
    assert "white-space: pre-wrap;" in styles
    assert "function normalizedDocumentTitle()" in source
    assert "function resizeDocumentTitle()" in source


def test_markdown_and_wiki_links_render_internal_docs_as_app_routes():
    result = _run_app_js_functions(
        """
allDocuments = [
  {
    path: "content/systems/airtable/sops/update-record.md",
    id: "airtable-update-record",
    aliases: ["airtable-update"],
    title: "Update an Airtable Record",
  },
  {
    path: "content/finance/reference/invoices.md",
    id: "invoice-reference",
    aliases: [],
    title: "Invoices",
  },
];
currentDoc = { path: "content/systems/airtable/sops/current.md" };
rebuildDocumentIdMap();

const html = markdownToHtml([
  "See [[airtable-update-record|Airtable SOP]].",
  "Use [Invoices](../../../finance/reference/invoices.md#receipts).",
  "Open [alias](doc:airtable-update).",
  "Missing [[does-not-exist]]."
].join("\\n\\n"));

assert.match(html, /href="\\/systems\\/airtable\\/sops\\/update-record\\.md"/);
assert.match(html, /data-doc-path="content\\/systems\\/airtable\\/sops\\/update-record\\.md"/);
assert.match(html, /href="\\/finance\\/reference\\/invoices\\.md"/);
assert.match(html, /data-doc-path="content\\/finance\\/reference\\/invoices\\.md"/);
assert.match(html, /class="broken-doc-link"/);
assert.equal(resolveMarkdownDocLink("/finance/reference/invoices.md").path, "content/finance/reference/invoices.md");
assert.equal(resolveMarkdownDocLink("doc:airtable-update").path, "content/systems/airtable/sops/update-record.md");
""",
        [
            "markdownToHtml",
            "splitTableRow",
            "inlineMd",
            "visibleDocUrl",
            "resolveMarkdownDocLink",
            "rebuildDocumentIdMap",
            "resolveDocReference",
            "cleanPath",
            "escapeHtmlAttr",
            "escapeHtml",
        ],
    )

    assert result["ok"] is True


def test_markdown_renderer_sanitizes_external_links_and_preserves_tables():
    result = _run_app_js_functions(
        """
const html = markdownToHtml([
  "| Name | Link |",
  "| --- | --- |",
  "| Safe | [site](https://example.com) |",
  "| Unsafe | [bad](javascript:alert(1)) |",
  "",
  "> quoted **text**",
  "",
  "```",
  "<script>alert(1)</script>",
  "```"
].join("\\n"));

assert.match(html, /<table>/);
assert.match(html, /href="https:\\/\\/example\\.com" target="_blank" rel="noopener"/);
assert.match(html, /href="#"/);
assert.doesNotMatch(html, /javascript:alert/);
assert.match(html, /&lt;script&gt;alert\\(1\\)&lt;\\/script&gt;/);
assert.match(html, /<blockquote>quoted <strong>text<\\/strong><\\/blockquote>/);
""",
        [
            "markdownToHtml",
            "splitTableRow",
            "inlineMd",
            "resolveMarkdownDocLink",
            "resolveDocReference",
            "visibleDocUrl",
            "escapeHtmlAttr",
            "escapeHtml",
        ],
    )

    assert result["ok"] is True


def test_loom_helpers_accept_only_share_urls_and_make_short_labels():
    result = _run_app_js_functions(
        """
assert.equal(
  toLoomEmbedUrl("https://www.loom.com/share/1234567890abcdef?sid=abc"),
  "https://www.loom.com/embed/1234567890abcdef"
);
assert.equal(toLoomEmbedUrl("https://www.loom.com/embed/1234567890abcdef"), null);
assert.equal(toLoomEmbedUrl("https://example.com/share/1234567890abcdef"), null);
assert.equal(shortLoomLabel("https://www.loom.com/share/1234567890abcdef"), "loom.com · 12345678…");
""",
        ["toLoomEmbedUrl", "shortLoomLabel"],
    )

    assert result["ok"] is True
