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
const window = {{ location: {{ pathname: "/" }} }};
const history = {{
  pushState(state, _title, url) {{
    pushed.push({{ state, url }});
    window.location.pathname = url;
  }}
}};
function resolveImageSrc(src) {{ return src; }}
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
    summary: "Git-backed DataTasks template for the Newsletter operational workflow.",
    doc_type: "task-template",
    tags: ["Newsletter", "task-template", "newsletter"],
  },
  {
    path: "content/tasks/templates/podcast.md",
    title: "Podcast Task Template",
    summary: "Git-backed DataTasks template for the Podcast operational workflow.",
    doc_type: "task-template",
    tags: ["Podcast", "task-template", "podcast"],
  },
  {
    path: "content/tasks/templates/social-media.md",
    title: "Social Media Weekly Task Template",
    summary: "Git-backed DataTasks template for the Social Media Weekly operational workflow.",
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
        id: "task-overdue",
        description: "Upload podcast recording",
        date: "2026-06-25",
        status: "todo",
        bundleId: "bundle-podcast",
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
      },
      {
        id: "bundle-archived",
        title: "Archived bundle",
        status: "archived",
      },
    ],
    bundleTasks: {
      "bundle-podcast": [
        { id: "task-overdue", description: "Upload podcast recording", date: "2026-06-25", status: "todo", bundleId: "bundle-podcast" },
        { id: "task-waiting", description: "Confirm guest bio", date: "2026-06-28", status: "waiting", waitingFor: "guest", followUpAt: "2026-06-27", bundleId: "bundle-podcast" },
        { id: "task-complete", description: "Prepare notes", date: "2026-06-24", status: "done", bundleId: "bundle-podcast" },
      ],
    },
  },
});

assert.equal(model.stats.totalDocs, 5);
assert.equal(model.stats.workflowTemplates, 3);
assert.equal(model.stats.recurringTemplates, 2);
assert.equal(model.stats.liveLoaded, true);
assert.equal(model.stats.todayTasks, 1);
assert.equal(model.stats.overdueTasks, 1);
assert.equal(model.stats.waitingTasks, 1);
assert.equal(model.stats.activeBundles, 1);
assert.deepEqual(model.templates.map((template) => template.slug), ["newsletter", "podcast", "social-media"]);
assert.equal(model.templates[0].title, "Newsletter");
assert.equal(model.templates[0].recurring, true);
assert.equal(model.templates[1].atRisk, true);

const lanes = Object.fromEntries(model.lanes.map((lane) => [lane.id, lane]));
assert.deepEqual(model.lanes.map((lane) => lane.id), ["today", "overdue", "waiting", "bundles"]);
assert.deepEqual(lanes.today.items.map((item) => item.title), ["Publish newsletter"]);
assert.deepEqual(lanes.overdue.items.map((item) => item.title), ["Upload podcast recording"]);
assert.equal(lanes.waiting.items[0].summary, "Waiting for guest; follow up Today");
assert.equal(lanes.bundles.items[0].title, "Podcast episode: streaming systems");
assert.equal(lanes.bundles.items[0].progress.done, 1);
assert.equal(lanes.bundles.items[0].progress.total, 3);
assert.equal(lanes.bundles.items[0].progress.overdue, 1);
assert.equal(lanes.bundles.items[0].progress.waiting, 1);
assert.equal(lanes.bundles.items[0].risk, "high");
assert.equal(model.references.some((ref) => ref.title === "DataOps V1 Goal" && ref.href.includes(".goal-v1.md")), true);
assert.equal(model.references.some((ref) => ref.path === "content/finance/reference/invoices-receipts-and-statements.md"), true);
""",
        [
            "buildOperationsHomeModel",
            "normalizeOperationsWorkSnapshot",
            "normalizeBundleTaskMap",
            "tasksFromWorkPayload",
            "bundlesFromWorkPayload",
            "dedupeWorkTasks",
            "sortWorkTasks",
            "taskSortDate",
            "isOpenWorkTask",
            "isTaskDueToday",
            "isTaskOverdue",
            "isWaitingOrFollowUpTask",
            "taskDate",
            "isActiveWorkBundle",
            "sortActiveWorkBundles",
            "summarizeBundleProgress",
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
            "formatTaskDateMeta",
            "labelizeWorkValue",
            "todayIsoDate",
            "addDaysIso",
            "toIsoDate",
            "parseIsoDateValue",
            "compareIsoDate",
            "isBeforeIsoDate",
            "dedupeOperationItems",
            "buildOperationsReferenceLinks",
            "basename",
            "cleanPath",
        ],
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
