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
let activeTaskPanelId = null;
let activeTaskPanelTask = null;
let requestPayload = {{}};
let promptValue = "";
let renderTaskPanelCalls = 0;
const callLog = [];

function tasksFromWorkPayload(payload) {{
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.tasks)) return payload.tasks;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}}

function workApiUrl(path, params = {{}}) {{
  return {{ path, params }};
}}

async function request(url, options = {{}}) {{
  callLog.push({{ type: "request", url, options }});
  return requestPayload;
}}

async function refreshOperationsWorkSnapshot(options = {{}}) {{
  callLog.push({{ type: "refreshSnapshot", options }});
}}

async function refreshTaskPanel(taskId) {{
  callLog.push({{ type: "refreshTaskPanel", taskId }});
}}

function reportError(message) {{
  callLog.push({{ type: "error", message }});
}}

function showUndoToast(message) {{
  callLog.push({{ type: "toast", message }});
}}

function renderTaskPanel() {{
  renderTaskPanelCalls += 1;
}}

const window = {{
  prompt() {{
    return promptValue;
  }},
}};

// Minimal DOM stub for functions that create elements.
function makeElement(tag) {{
  const element = {{
    tagName: tag.toUpperCase(),
    textContent: "",
    className: "",
    children: [],
    listeners: {{}},
    style: {{}},
    disabled: false,
    title: "",
    value: "",
    files: null,
    classList: {{
      values: [],
      add(...names) {{
        this.values.push(...names);
      }},
    }},
    append(...items) {{
      this.children.push(...items);
    }},
    replaceChildren(...items) {{
      this.children = [...items];
    }},
    addEventListener(type, handler) {{
      this.listeners[type] = handler;
    }},
    setAttribute(name, value) {{
      this[name] = String(value);
    }},
  }};
  return element;
}}

const document = {{
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
        ["workTaskTitle", "stripTitleSuffix"],
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


def test_task_action_helpers_call_work_api_and_refresh_panel():
    result = _run_app_js_functions(
        """
activeTaskPanelTask = { id: "task-1", comment: "existing note" };

await updateTaskStatus("task-1", "done");
assert.equal(callLog[0].type, "request");
assert.deepEqual(callLog[0].url, { path: "/api/tasks/task-1", params: {} });
assert.equal(callLog[0].options.method, "PUT");
assert.deepEqual(JSON.parse(callLog[0].options.body), { status: "done" });
assert.equal(callLog[1].type, "toast");
assert.equal(callLog[2].type, "refreshSnapshot");
assert.deepEqual(callLog[2].options, { rerender: true });
assert.deepEqual(callLog[3], { type: "refreshTaskPanel", taskId: "task-1" });

callLog.length = 0;
await saveTaskLink("task-1", "https://example.com/proof");
assert.deepEqual(callLog[0].url, { path: "/api/tasks/task-1", params: {} });
assert.deepEqual(JSON.parse(callLog[0].options.body), { link: "https://example.com/proof" });
assert.equal(activeTaskPanelTask.link, "https://example.com/proof");
assert.equal(callLog.at(-1).type, "refreshSnapshot");
""",
        ["updateTaskStatus", "saveTaskLink"],
    )
    assert result["ok"] is True


def test_waiting_and_follow_up_helpers_call_work_api_with_history():
    result = _run_app_js_functions(
        """
activeTaskPanelTask = { id: "task-1", comment: "existing note" };
promptValue = "guest bio";

await markTaskWaiting("task-1");
assert.deepEqual(callLog[0].url, { path: "/api/tasks/task-1", params: {} });
const waitingPayload = JSON.parse(callLog[0].options.body);
assert.equal(waitingPayload.status, "waiting");
assert.equal(waitingPayload.waitingFor, "guest bio");
assert.match(waitingPayload.followUpAt, /^\\d{4}-\\d{2}-\\d{2}$/);
assert.match(waitingPayload.comment, /Marked waiting for guest bio; follow up/);
assert.equal(callLog[1].type, "refreshSnapshot");
assert.equal(callLog[2].type, "refreshTaskPanel");

callLog.length = 0;
activeTaskPanelTask.comment = "existing note";
await recordTaskResponseReceived("task-1");
const responsePayload = JSON.parse(callLog[0].options.body);
assert.equal(responsePayload.status, "todo");
assert.match(responsePayload.comment, /Response received/);

callLog.length = 0;
await recordTaskFollowUpSent("task-1", "2026-07-01");
const followUpPayload = JSON.parse(callLog[0].options.body);
assert.equal(followUpPayload.status, "waiting");
assert.equal(followUpPayload.followUpAt, "2026-07-01");
assert.match(followUpPayload.comment, /Follow-up sent; next follow-up 2026-07-01/);
""",
        [
            "markTaskWaiting",
            "recordTaskResponseReceived",
            "recordTaskFollowUpSent",
            "appendTaskEventComment",
            "defaultNextFollowUpDate",
            "todayIsoDate",
            "addDaysIso",
            "toIsoDate",
            "parseIsoDateValue",
        ],
    )
    assert result["ok"] is True


def test_waiting_helpers_reject_missing_required_input_without_request():
    result = _run_app_js_functions(
        """
activeTaskPanelTask = { id: "task-1", comment: "" };
promptValue = " ";

await markTaskWaiting("task-1");
assert.equal(callLog.length, 1);
assert.equal(callLog[0].type, "error");
assert.match(callLog[0].message, /Waiting tasks need/);

callLog.length = 0;
await recordTaskFollowUpSent("task-1", "");
assert.equal(callLog.length, 1);
assert.equal(callLog[0].type, "error");
assert.match(callLog[0].message, /Choose the next follow-up date/);
""",
        [
            "markTaskWaiting",
            "recordTaskFollowUpSent",
            "appendTaskEventComment",
            "defaultNextFollowUpDate",
            "todayIsoDate",
            "addDaysIso",
            "toIsoDate",
            "parseIsoDateValue",
        ],
    )
    assert result["ok"] is True


def test_required_file_state_rerenders_task_panel_when_evidence_changes():
    result = _run_app_js_functions(
        """
activeTaskPanelId = "task-1";
activeTaskPanelTask = { id: "task-1", requiresFile: true, _hasFiles: false };
requestPayload = { files: [{ id: "file-1", filename: "proof.pdf" }] };
const container = makeElement("div");

await loadTaskFiles("task-1", container);
assert.equal(activeTaskPanelTask._hasFiles, true);
assert.equal(renderTaskPanelCalls, 1);
assert.equal(container.children.length, 0);

requestPayload = { files: [] };
await loadTaskFiles("task-1", makeElement("div"));
assert.equal(activeTaskPanelTask._hasFiles, false);
assert.equal(renderTaskPanelCalls, 2);
""",
        ["loadTaskFiles"],
    )
    assert result["ok"] is True


def test_artifact_proof_is_distinct_from_file_proof():
    result = _run_app_js_functions(
        """
const fileTask = { id: "file-task", requiresFile: true, artifactRefs: [{ artifactId: "artifact-1", status: "approved" }] };
assert.equal(hasTaskFileEvidence(fileTask), false);
assert.deepEqual(taskProofState(fileTask).missing, ["required file"]);

const draftArtifactTask = {
  id: "artifact-task",
  proofRequirement: { type: "artifact", label: "Reviewed output" },
  artifactRefs: [{ artifactId: "artifact-2", status: "needs-review" }],
};
assert.equal(taskRequiresApprovedArtifact(draftArtifactTask), true);
assert.equal(hasApprovedArtifactEvidence(draftArtifactTask, []), false);
assert.deepEqual(taskProofState(draftArtifactTask).missing, ["approved artifact"]);

const approvedArtifactTask = {
  id: "artifact-task-approved",
  proofRequirement: { type: "artifact", label: "Reviewed output" },
};
assert.equal(hasApprovedArtifactEvidence(approvedArtifactTask, [{ id: "artifact-3", status: "approved" }]), true);
""",
        [
            "hasTaskFileEvidence",
            "taskProofState",
            "taskRequiresApprovedArtifact",
            "hasApprovedArtifactEvidence",
        ],
    )
    assert result["ok"] is True


def test_resolve_assignee_label_returns_user_name_from_cached_lookup():
    """Task list cards and detail panel both render the assignee name (not the
    raw UUID) via the cached usersById lookup on operationsWorkSnapshot."""
    result = _run_app_js_functions(
        """
operationsWorkSnapshot.usersById = new Map([
  ["00000000-0000-0000-0000-000000000001", { id: "00000000-0000-0000-0000-000000000001", name: "Grace" }],
]);

assert.equal(resolveAssigneeLabel("00000000-0000-0000-0000-000000000001"), "Grace");
assert.equal(resolveAssigneeLabel(""), "—");
assert.equal(resolveAssigneeLabel("not-a-known-user"), "—");
""",
        ["resolveAssigneeLabel"],
    )
    assert result["ok"] is True
