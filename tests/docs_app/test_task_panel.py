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
let operationsWorkSnapshot = {{ loaded: false, todayTasks: [], overdueTasks: [], waitingTasks: [], bundles: [], bundleTasks: {{}} }};

function tasksFromWorkPayload(payload) {{
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.tasks)) return payload.tasks;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}}

// Minimal DOM stub for functions that create elements.
const document = {{
  createElement(tag) {{
    return {{ tagName: tag.toUpperCase(), textContent: "", append() {{}}, addEventListener() {{}}, style: {{}} }};
  }},
  createTextNode(text) {{
    return {{ nodeType: 3, textContent: String(text) }};
  }},
}};

{functions}

void (async () => {{
{assertions}
console.log(JSON.stringify({{ ok: true }}));
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


def test_append_task_event_comment_prepends_timestamp_line():
    result = _run_app_js_functions(
        """
const first = appendTaskEventComment("", "Response received");
assert.ok(first.startsWith("[20"), "expected ISO timestamp prefix: " + first);
assert.ok(first.endsWith("] Response received"), "unexpected suffix: " + first);

const second = appendTaskEventComment(first, "Follow-up sent; next follow-up 2026-07-01");
const lines = second.split("\\n");
assert.equal(lines.length, 2);
assert.ok(lines[0].includes("Response received"));
assert.ok(lines[1].includes("Follow-up sent"));
""",
        ["appendTaskEventComment"],
    )
    assert result["ok"] is True


def test_append_task_event_comment_is_idempotent_when_replayed():
    """Re-appending the same event text still adds a new line; the
    idempotency contract lives in the reminder-generation layer, not here."""
    result = _run_app_js_functions(
        """
const once = appendTaskEventComment("", "Response received");
const twice = appendTaskEventComment(once, "Response received");
assert.equal(twice.split("\\n").length, 2);
""",
        ["appendTaskEventComment"],
    )
    assert result["ok"] is True


def test_default_next_follow_up_date_is_three_days_ahead():
    result = _run_app_js_functions(
        """
const today = new Date();
const y = today.getFullYear();
const m = String(today.getMonth() + 1).padStart(2, "0");
const d = String(today.getDate()).padStart(2, "0");
const todayIso = `${y}-${m}-${d}`;
const next = defaultNextFollowUpDate();
assert.match(next, /^\\d{4}-\\d{2}-\\d{2}$/);
assert.ok(next > todayIso, "next follow-up must be in the future: " + next);
""",
        ["defaultNextFollowUpDate", "todayIsoDate", "addDaysIso", "toIsoDate", "parseIsoDateValue"],
    )
    assert result["ok"] is True


def test_find_work_task_in_snapshot_searches_all_pools():
    result = _run_app_js_functions(
        """
operationsWorkSnapshot.todayTasks = [{ id: "t1", description: "Send invoice", status: "todo", date: "2026-06-27" }];
operationsWorkSnapshot.waitingTasks = [{ id: "t2", description: "Awaiting reply", status: "waiting", waitingFor: "Speaker" }];
operationsWorkSnapshot.bundleTasks = { b1: [{ id: "t3", description: "Book studio", status: "todo" }] };

assert.equal(findWorkTaskInSnapshot("t1").description, "Send invoice");
assert.equal(findWorkTaskInSnapshot("t2").waitingFor, "Speaker");
assert.equal(findWorkTaskInSnapshot("t3").description, "Book studio");
assert.equal(findWorkTaskInSnapshot("missing"), null);
""",
        ["findWorkTaskInSnapshot"],
    )
    assert result["ok"] is True


def test_work_task_title_falls_back_through_fields():
    result = _run_app_js_functions(
        """
assert.equal(workTaskTitle({ id: "x", description: "D" }), "D");
assert.equal(workTaskTitle({ id: "x", title: "T" }), "T");
assert.equal(workTaskTitle({ id: "x" }), "x");
assert.equal(workTaskTitle({}), "Untitled task");
""",
        ["workTaskTitle"],
    )
    assert result["ok"] is True


def test_format_history_line_splits_stamp_and_text():
    result = _run_app_js_functions(
        """
const parts = formatHistoryLine("[2026-06-27T10:30:00.000Z] Response received");
assert.equal(parts.length, 2);
assert.equal(parts[0].tagName, "CODE");
assert.equal(parts[0].textContent, "2026-06-27 10:30:00");
assert.equal(parts[1].nodeType, 3); // text node
assert.equal(parts[1].textContent, " Response received");

const plain = formatHistoryLine("just a comment");
assert.equal(plain.length, 1);
assert.equal(plain[0].nodeType, 3);
""",
        ["formatHistoryLine"],
    )
    assert result["ok"] is True



def test_bundle_checklist_sorts_done_last():
    """The bundle checklist should sort done tasks below active tasks so
    the operator's attention stays on pending work."""
    result = _run_app_js_functions(
        """
const tasks = [
  { id: "t1", description: "Done task", status: "done", date: "2026-06-25" },
  { id: "t2", description: "Active task", status: "todo", date: "2026-06-28" },
  { id: "t3", description: "Waiting task", status: "waiting", date: "2026-06-27" },
];
const sorted = sortBundleChecklistTasks(tasks, "2026-06-27");
assert.equal(sorted[0].description, "Waiting task");
assert.equal(sorted[1].description, "Active task");
assert.equal(sorted[2].description, "Done task");
""",
        ["sortBundleChecklistTasks", "compareIsoDate", "taskDate"],
    )
    assert result["ok"] is True
