from __future__ import annotations

import copy
import hashlib
import json
import subprocess
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-dataops-v1.yml"
TEMPLATE = REPO_ROOT / "infra" / "template.full.yaml"
SERIALIZER = (
    REPO_ROOT / "scripts" / "deploy" / "serialize-issue-166-phase-d-source.mjs"
)
VERIFIER = REPO_ROOT / "scripts" / "deploy" / "verify-issue-166-phase-d-readiness.mjs"
TEST_COMMIT = "1" * 40


class _CloudFormationLoader(yaml.SafeLoader):
    pass


def _intrinsic(loader, tag_suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {tag_suffix: value}


_CloudFormationLoader.add_multi_constructor("!", _intrinsic)


def _indexes() -> list[dict]:
    keys = {
        "GSI-Date": ("date", "status"),
        "GSI-Card": ("cardId", "date"),
        "GSI-Status": ("status", "date"),
    }
    return [
        {
            "IndexName": name,
            "KeySchema": [
                {"AttributeName": hash_key, "KeyType": "HASH"},
                {"AttributeName": range_key, "KeyType": "RANGE"},
            ],
            "Projection": {"ProjectionType": "ALL"},
        }
        for name, (hash_key, range_key) in keys.items()
    ]


def _writer(events: dict) -> dict:
    return {
        "Type": "AWS::Serverless::Function",
        "Properties": {
            "CodeUri": "sam-build",
            "Events": events,
            "Policies": [
                {
                    "Statement": {
                        "Resource": {"Fn::GetAtt": ["DataOpsTasksTable", "Arn"]}
                    }
                }
            ],
        },
    }


def _write_envelope(path: Path, template: dict, commit: str = TEST_COMMIT) -> None:
    encoded = json.dumps(template, separators=(",", ":"))
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "commitSha": commit,
                "templateSha256": hashlib.sha256(encoded.encode()).hexdigest(),
                "template": template,
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )


def _artifact(tmp_path: Path) -> tuple[Path, dict, dict[str, Path]]:
    backend_root = tmp_path / "backend-artifact"
    worker_root = tmp_path / "worker-artifact"
    for root in (backend_root, worker_root):
        (root / "dist").mkdir(parents=True)
    (backend_root / "dist/frontend/src/core").mkdir(parents=True)
    (backend_root / "dist/frontend/src/surfaces/work-detail").mkdir(parents=True)

    (backend_root / "dist/handler.js").write_text(
        """
        TaskVersionConflictError CardVersionConflictError canonical versioned shape
        canonical lifecycle shape attribute_exists(PK) AND #version = :expectedVersion
        taskHistory TransactWriteCommand card-completed card-reactivated
        task_version_conflict card_version_conflict card_lifecycle_conflict openTaskCount
        """,
        encoding="utf-8",
    )
    (worker_root / "dist/execution-worker-handler.js").write_text(
        "const task = { version: 1, taskHistory: [] };", encoding="utf-8"
    )
    (backend_root / "dist/frontend/src/core/workspace.js").write_text(
        'return card.status === "archived" && card.stage === "done";',
        encoding="utf-8",
    )
    (backend_root / "dist/frontend/src/surfaces/work-detail/task-actions.js").write_text(
        "expectedVersion task_version_conflict card_lifecycle_conflict",
        encoding="utf-8",
    )

    backend = _writer(
        {
            "DailyBackendCron": {"Type": "Schedule"},
            "DailyBackendExport": {"Type": "Schedule"},
            "DailyMailingExport": {"Type": "Schedule"},
        },
    )
    worker = _writer(
        {
            "QueuedAttemptStream": {"Type": "DynamoDB"},
            "ExecutionRecovery": {"Type": "Schedule"},
            "ExecutionHealthPulse": {"Type": "Schedule"},
        },
    )
    worker["Properties"]["Environment"] = {
        "Variables": {"DATAOPS_TASKS_TABLE": {"Ref": "DataOpsTasksTable"}}
    }
    template = {
        "Resources": {
            "DataOpsTasksTable": {
                "Type": "AWS::DynamoDB::Table",
                "DeletionPolicy": "Retain",
                "UpdateReplacePolicy": "Retain",
                "Properties": {
                    "TableName": {"Fn::Sub": "${AWS::StackName}-tasks"},
                    "BillingMode": "PAY_PER_REQUEST",
                    "SSESpecification": {"SSEEnabled": True},
                    "PointInTimeRecoverySpecification": {
                        "PointInTimeRecoveryEnabled": True
                    },
                    "AttributeDefinitions": [
                        {"AttributeName": name, "AttributeType": "S"}
                        for name in ("PK", "SK", "date", "status", "cardId")
                    ],
                    "KeySchema": [
                        {"AttributeName": "PK", "KeyType": "HASH"},
                        {"AttributeName": "SK", "KeyType": "RANGE"},
                    ],
                    "GlobalSecondaryIndexes": _indexes(),
                    "Tags": [
                        {"Key": "Project", "Value": "DataOps"},
                        {"Key": "App", "Value": "DataOpsV1"},
                        {"Key": "DataClass", "Value": "ExecutionState"},
                    ],
                },
            },
            "BackendFunction": backend,
            "ConversationalExecutionWorkerFunction": worker,
        },
        "Outputs": {
            "DataOpsTasksTableName": {"Value": {"Ref": "DataOpsTasksTable"}}
        },
    }
    path = tmp_path / "source-template.json"
    _write_envelope(path, template)
    return path, template, {
        "backend_root": backend_root,
        "worker_root": worker_root,
        "backend": backend_root / "dist/handler.js",
        "worker": worker_root / "dist/execution-worker-handler.js",
        "workspace": backend_root / "dist/frontend/src/core/workspace.js",
        "task_actions": (
            backend_root / "dist/frontend/src/surfaces/work-detail/task-actions.js"
        ),
    }


def _verify(path: Path, artifacts: dict[str, Path]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "node",
            str(VERIFIER),
            str(path),
            str(artifacts["backend_root"]),
            str(artifacts["worker_root"]),
            TEST_COMMIT,
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def test_final_source_is_the_one_marker_free_canonical_tasks_table():
    template = yaml.load(
        TEMPLATE.read_text(encoding="utf-8"), Loader=_CloudFormationLoader
    )
    assert "DataOpsIssue166Cutover" not in template.get("Metadata", {})
    tasks = template["Resources"]["DataOpsTasksTable"]
    assert tasks["DeletionPolicy"] == tasks["UpdateReplacePolicy"] == "Retain"
    assert tasks["Properties"]["TableName"] == {
        "Sub": "${AWS::StackName}-tasks"
    }
    assert sorted(
        item["AttributeName"]
        for item in tasks["Properties"]["AttributeDefinitions"]
    ) == ["PK", "SK", "cardId", "date", "status"]
    assert sorted(
        item["IndexName"] for item in tasks["Properties"]["GlobalSecondaryIndexes"]
    ) == ["GSI-Card", "GSI-Date", "GSI-Status"]
    assert "bundleId" not in json.dumps(tasks)
    assert "GSI-Bundle" not in json.dumps(tasks)

    backend = template["Resources"]["BackendFunction"]["Properties"]
    worker = template["Resources"]["ConversationalExecutionWorkerFunction"][
        "Properties"
    ]
    assert "ReservedConcurrentExecutions" not in backend
    assert "ReservedConcurrentExecutions" not in worker
    assert set(backend["Events"]) == {
        "DailyBackendCron",
        "DailyBackendExport",
        "DailyMailingExport",
    }
    assert set(worker["Events"]) == {
        "QueuedAttemptStream",
        "ExecutionRecovery",
        "ExecutionHealthPulse",
    }
    assert worker["Environment"]["Variables"]["DATAOPS_TASKS_TABLE"] == {
        "Ref": "DataOpsTasksTable"
    }
    assert template["Outputs"]["DataOpsTasksTableName"]["Value"] == {
        "Ref": "DataOpsTasksTable"
    }


def test_phase_d_workflow_is_manual_exact_and_fail_closed_until_evidence_exists():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    assert workflow.count("- issue-166-phase-d") == 1
    for retired_option in (
        "- normal",
        "- issue-166-phase-a",
        "- issue-166-phase-b",
        "- issue-166-phase-c",
    ):
        assert retired_option not in workflow
    assert "if: github.event_name == 'workflow_dispatch'" in workflow
    checks_checkout, deploy_checkout = workflow.split(
        "- name: Check out repository", 2
    )[1:]
    assert "fetch-depth: 0" not in checks_checkout
    assert "uses: actions/checkout@v6\n        with:\n          fetch-depth: 0" in deploy_checkout
    assert deploy_checkout.index("fetch-depth: 0") < deploy_checkout.index(
        "git merge-base --is-ancestor"
    )
    artifact_name = (
        "issue-166-phase-d-readiness-${{ github.run_id }}-"
        "${{ github.run_attempt }}-${{ github.sha }}"
    )
    assert workflow.count(artifact_name) == 2
    assert workflow.count("actions/upload-artifact@v4") == 1
    assert workflow.count("actions/download-artifact@v4") == 1
    assert "if-no-files-found: error" in workflow
    assert "retention-days: 1" in workflow
    assert workflow.index("serialize-issue-166-phase-d-source.mjs") < workflow.index(
        "actions/upload-artifact@v4"
    ) < workflow.index("\n  deploy:") < workflow.index(
        "actions/download-artifact@v4"
    ) < workflow.index("git merge-base --is-ancestor")
    assert 'reviewed_phase_c_table_id="6464cf95-cdab-4260-8424-25176e8a0d1b"' in workflow
    assert "PENDING_ACCEPTED_ISSUE_168_COMMIT" not in workflow
    assert "41dca9e3748fe627c195f48a7f97ae203b343f60" in workflow
    assert "02ee455efad09865ecdbd578e940c59e0bf7dc36" in workflow
    assert 'git merge-base --is-ancestor "$accepted_issue_168_commit"' in workflow
    assert "reopen-canonical-writers-on-empty-final-dataops-v1-tasks" in workflow

    repaired_phase_commits = (
        "55b2d00f22df45d5d55d9a834e4068da28a1d1da",
        "f32af76898f3f13501798d7b9b12605da2d70974",
        "b6b1ce9031412682b9cf660a92876c312b9a584a",
    )
    for ordered_commit in repaired_phase_commits:
        assert ordered_commit in workflow
    assert workflow.index(repaired_phase_commits[0]) < workflow.index(
        repaired_phase_commits[1]
    ) < workflow.index(repaired_phase_commits[2])
    for revoked_commit in ("a583595", "d5204ae", "5e82051"):
        assert revoked_commit not in workflow
    assert (
        'git merge-base --is-ancestor b6b1ce9031412682b9cf660a92876c312b9a584a '
        '"$GITHUB_SHA"'
    ) in workflow
    assert "This job never runs on push, so #179 cannot write transitional rows." in workflow

    assert workflow.count("run: make sam-build") == 1
    build = workflow.index("run: make sam-build")
    frontend_gate = workflow.index("run: make verify-sam-frontend")
    runtime_gate = workflow.index("run: make verify-sam-runtime-boundary")
    isolation_gate = workflow.index("run: make test-sam-frontend-isolation")
    readiness = workflow.index("verify-issue-166-phase-d-readiness.mjs")
    preflight = workflow.index("- name: Verify exact deployed Phase C state")
    deploy = workflow.index("- name: Deploy DataOps v1 stack")
    assert (
        preflight
        < build
        < frontend_gate
        < runtime_gate
        < isolation_gate
        < readiness
        < deploy
    )
    assert (
        '"$RUNNER_TEMP/issue-166-phase-d-readiness/source-template.json"'
        in workflow
    )
    assert ".aws-sam/build/BackendFunction" in workflow
    assert ".aws-sam/build/ConversationalExecutionWorkerFunction" in workflow
    assert workflow.index("verify-issue-166-phase-d-readiness.mjs") < workflow.index(
        "sam validate --template-file .aws-sam/build/template.yaml"
    )


def test_phase_d_requires_exact_empty_phase_c_state_and_reopens_only_after_proof():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    preflight = workflow.split(
        "- name: Verify exact deployed Phase C state before reopen", 1
    )[1].split("- name: Build SAM artifact", 1)[0]
    for required in (
        "JSON.stringify({ Issue: 166, Phase: 'C' })",
        'TableId != "b4e83537-7cf6-41cb-a281-8a52f678b1a3"',
        "PAY_PER_REQUEST",
        "describe-continuous-backups",
        "list-tags-of-resource",
        "--consistent-read --select COUNT",
        "ReservedConcurrentExecutions --output text",
        "list-rule-names-by-target",
        "list-event-source-mappings",
        "Environment?.Variables?.DATAOPS_TASKS_TABLE",
        "resources.BackendFunctionRole",
        "resources.ConversationalExecutionWorkerFunctionRole",
        "JSON.stringify({ 'Fn::Sub': '${AWS::StackName}-tasks' })",
    ):
        assert required in preflight
    for forbidden in (
        "dynamodb delete-table",
        "dynamodb create-table",
        "dynamodb restore-table",
        "batch-write-item",
        "put-item",
        "update-item",
        "import-trello",
        "backfill",
    ):
        assert forbidden not in preflight.lower()

    postcheck = workflow.split(
        "- name: Prove final steady state before seeds and read-only smoke", 1
    )[1].split(
        "- name: Seed runtime users, workflow templates, and recurring configs", 1
    )[0]
    for required in (
        "DataOpsIssue166Cutover === undefined",
        "GSI-Card",
        "GSI-Date",
        "GSI-Status",
        "IndexStatus",
        "SSEDescription.Status",
        "describe-continuous-backups",
        "list-tags-of-resource",
        "DataOpsTasksTableName",
        "ReservedConcurrentExecutions",
        "DATAOPS_DEPLOYMENT_ID",
        "DATAOPS_TASKS_TABLE",
        "did not restore the exact writer trigger set",
        "--consistent-read",
        "--no-paginate",
        "--exclusive-start-key",
        "LastEvaluatedKey",
        "canonical_task_count",
        'test("^[1-9][0-9]*$")',
        '(.taskHistory | keys) == ["L"]',
        'has("cardId") | not',
        'has("bundleId") | not',
    ):
        assert required in postcheck
    assert workflow.index("- name: Prove final steady state") < workflow.index(
        "- name: Seed runtime users, workflow templates, and recurring configs"
    ) < workflow.index("- name: Authenticated read-only Task smoke")
    assert '"$backend_url/api/tasks?status=todo"' in workflow
    assert '"$backend_url/api/tasks/issue-166-phase-d-empty-proof"' in workflow
    assert "unset portal_secret" in workflow
    assert '(.tasks | type == "array")' in workflow
    assert '(.version | type == "number" and floor == . and . >= 1)' in workflow
    assert '(.taskHistory | type == "array")' in workflow
    assert 'has("cardId") | not' in workflow
    assert '.cardId == null' not in workflow
    assert 'has("bundleId") | not' in workflow
    assert '.error == "Task not found"' in workflow


def test_phase_d_uses_one_packaged_runtime_seed_action_without_local_node_tools():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    deploy = workflow.split("\n  deploy:\n", 1)[1]
    seed = deploy.split(
        "- name: Seed runtime users, workflow templates, and recurring configs", 1
    )[1].split("- name: Smoke test deployed single-origin backend", 1)[0]

    assert deploy.count("aws lambda invoke") == 1
    assert '"source":"dataops.deploy","detail-type":"Runtime Seed"' in seed
    assert '"dataopsAction":"sync-runtime-seeds"' in seed
    assert '"dataopsAction":"sync-templates"' not in deploy
    assert 'seed_response="$RUNNER_TEMP/issue-166-phase-d-runtime-seeds.json"' in seed
    assert "FunctionError" in seed
    assert 'if [ "$seed_error" != "None" ]' in seed
    assert ".statusCode == 200" in seed
    for exact_total in (
        "$body.users.processed == 3",
        "$body.users.created + $body.users.updated + $body.users.unchanged == 3",
        "$body.templates.total == 11",
        "$body.templates.created + $body.templates.updated + $body.templates.unchanged == 11",
        "$body.recurring.total == 7",
        "$body.recurring.created + $body.recurring.updated + $body.recurring.skipped == 7",
        "$body.recurring.repairedTasks",
    ):
        assert exact_total in seed
    for forbidden in (
        "npm exec",
        "npx",
        "npm ci",
        "scripts/seed-users.ts",
        "scripts/seed-recurring.ts",
        "working-directory:",
        "/tmp/",
    ):
        assert forbidden not in deploy
    assert "cat \"$seed_response\"" not in seed


def test_phase_d_runtime_seed_response_gate_accepts_only_exact_sanitized_counts(
    tmp_path: Path,
):
    workflow = WORKFLOW.read_text(encoding="utf-8")
    seed = workflow.split(
        "- name: Seed runtime users, workflow templates, and recurring configs", 1
    )[1].split("- name: Smoke test deployed single-origin backend", 1)[0]
    jq_program = seed.split("if ! jq -e '", 1)[1].split(
        "' \"$seed_response\" >/dev/null", 1
    )[0]
    report = {
        "users": {"processed": 3, "created": 1, "updated": 1, "unchanged": 1},
        "templates": {"total": 11, "created": 4, "updated": 3, "unchanged": 4},
        "recurring": {
            "total": 7,
            "created": 2,
            "updated": 1,
            "skipped": 4,
            "repairedTasks": 3,
        },
    }

    def verify(body: object, status_code: int = 200) -> subprocess.CompletedProcess[str]:
        response = tmp_path / "runtime-seed-response.json"
        response.write_text(
            json.dumps({"statusCode": status_code, "body": json.dumps(body)}),
            encoding="utf-8",
        )
        return subprocess.run(
            ["jq", "-e", jq_program, str(response)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    assert verify(report).returncode == 0
    mutations = []
    wrong_users = copy.deepcopy(report)
    wrong_users["users"]["unchanged"] = 2
    mutations.append(("user total", wrong_users, 200))
    fractional_template = copy.deepcopy(report)
    fractional_template["templates"]["updated"] = 2.5
    mutations.append(("noninteger Template count", fractional_template, 200))
    wrong_recurring = copy.deepcopy(report)
    wrong_recurring["recurring"]["skipped"] = 5
    mutations.append(("recurring total", wrong_recurring, 200))
    negative_repair = copy.deepcopy(report)
    negative_repair["recurring"]["repairedTasks"] = -1
    mutations.append(("negative repaired Task count", negative_repair, 200))
    extra_field = copy.deepcopy(report)
    extra_field["users"]["details"] = "must-not-be-accepted"
    mutations.append(("unexpected response field", extra_field, 200))
    mutations.append(("non-200 response", report, 500))
    for label, mutation, status_code in mutations:
        assert verify(mutation, status_code).returncode != 0, label


def test_processed_template_loader_accepts_object_and_string_forms(tmp_path: Path):
    loader = """
      import { readFileSync } from 'node:fs';
      const encoded = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      const template = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
      if (!template || typeof template !== 'object' || Array.isArray(template)) process.exit(2);
      if (template?.Metadata?.Proof !== 'ok') process.exit(1);
    """
    workflow = WORKFLOW.read_text(encoding="utf-8")
    assert workflow.count(
        "const template = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;"
    ) == 2
    assert "js-yaml" not in workflow
    assert "--query TemplateBody --output text" not in workflow
    for index, form in enumerate(
        (
            {"Metadata": {"Proof": "ok"}},
            json.dumps({"Metadata": {"Proof": "ok"}}),
        )
    ):
        path = tmp_path / f"template-{index}.json"
        path.write_text(json.dumps(form), encoding="utf-8")
        completed = subprocess.run(
            ["node", "--input-type=module", "-", str(path)],
            cwd=REPO_ROOT,
            input=loader,
            capture_output=True,
            text=True,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr

    invalid = tmp_path / "template-invalid.json"
    invalid.write_text(json.dumps("Metadata:\n  Proof: ok\n"), encoding="utf-8")
    completed = subprocess.run(
        ["node", "--input-type=module", "-", str(invalid)],
        cwd=REPO_ROOT,
        input=loader,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode != 0


def test_phase_d_source_serializer_is_sha_bound_and_preserves_intrinsics(
    tmp_path: Path,
):
    output = tmp_path / "source-template.json"
    completed = subprocess.run(
        ["node", str(SERIALIZER), str(TEMPLATE), str(output), TEST_COMMIT],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    envelope = json.loads(output.read_text(encoding="utf-8"))
    assert envelope["schemaVersion"] == 1
    assert envelope["commitSha"] == TEST_COMMIT
    encoded = json.dumps(envelope["template"], separators=(",", ":"))
    assert envelope["templateSha256"] == hashlib.sha256(encoded.encode()).hexdigest()
    assert envelope["template"]["Resources"]["DataOpsTasksTable"]["Properties"][
        "TableName"
    ] == {"Fn::Sub": "${AWS::StackName}-tasks"}
    assert envelope["template"]["Resources"][
        "ConversationalExecutionWorkerFunction"
    ]["Properties"]["Environment"]["Variables"]["DATAOPS_TASKS_TABLE"] == {
        "Ref": "DataOpsTasksTable"
    }

    wrong_sha = subprocess.run(
        ["node", str(SERIALIZER), str(TEMPLATE), str(output), "not-a-sha"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert wrong_sha.returncode != 0


def test_phase_d_verifier_accepts_only_final_semantic_writer_artifact(tmp_path: Path):
    path, source, artifacts = _artifact(tmp_path)
    completed = _verify(path, artifacts)
    assert completed.returncode == 0, completed.stderr

    mutations: list[tuple[str, dict]] = []
    marked = copy.deepcopy(source)
    marked["Metadata"] = {"DataOpsIssue166Cutover": {"Issue": 166, "Phase": "C"}}
    mutations.append(("cutover-marker", marked))
    bundle = copy.deepcopy(source)
    bundle["Metadata"] = {"Unrelated": {"bundleId": "retired-token"}}
    mutations.append(("bundle-token-outside-schema", bundle))
    bundle_index = copy.deepcopy(source)
    bundle_index["Metadata"] = {"Unrelated": "GSI-Bundle"}
    mutations.append(("bundle-index-token-outside-schema", bundle_index))
    closed = copy.deepcopy(source)
    closed["Resources"]["BackendFunction"]["Properties"][
        "ReservedConcurrentExecutions"
    ] = 0
    mutations.append(("writer-concurrency-closed", closed))
    no_event = copy.deepcopy(source)
    del no_event["Resources"]["ConversationalExecutionWorkerFunction"]["Properties"][
        "Events"
    ]["ExecutionHealthPulse"]
    mutations.append(("writer-event-missing", no_event))
    wrong_code_uri = copy.deepcopy(source)
    wrong_code_uri["Resources"]["BackendFunction"]["Properties"][
        "CodeUri"
    ] = "alternate-build"
    mutations.append(("writer-source-boundary", wrong_code_uri))

    for label, mutation in mutations:
        mutation_path = tmp_path / f"mutation-{label}.json"
        _write_envelope(mutation_path, mutation)
        completed = _verify(mutation_path, artifacts)
        assert completed.returncode != 0, f"{label} unexpectedly passed"

    wrong_commit = _verify(path, {**artifacts})
    assert wrong_commit.returncode == 0
    encoded = json.loads(path.read_text(encoding="utf-8"))
    encoded["commitSha"] = "2" * 40
    path.write_text(json.dumps(encoded), encoding="utf-8")
    completed = _verify(path, artifacts)
    assert completed.returncode != 0

    _write_envelope(path, source)
    encoded = json.loads(path.read_text(encoding="utf-8"))
    encoded["template"]["Metadata"] = {"TamperedAfterDigest": True}
    path.write_text(json.dumps(encoded), encoding="utf-8")
    completed = _verify(path, artifacts)
    assert completed.returncode != 0


def test_phase_d_verifier_rejects_each_missing_canonical_writer_behavior(
    tmp_path: Path,
):
    path, _, artifacts = _artifact(tmp_path)
    mutations = (
        ("expected-version", artifacts["backend"], "#version = :expectedVersion"),
        ("task-history", artifacts["backend"], "taskHistory"),
        ("transaction", artifacts["backend"], "TransactWriteCommand"),
        ("lifecycle-conflict", artifacts["backend"], "card_lifecycle_conflict"),
        ("card-completed", artifacts["backend"], "card-completed"),
        ("card-reactivated", artifacts["backend"], "card-reactivated"),
        (
            "workspace-classification",
            artifacts["workspace"],
            'card.status === "archived" && card.stage === "done"',
        ),
        ("task-action-version", artifacts["task_actions"], "expectedVersion"),
    )

    originals = {artifact: artifact.read_text(encoding="utf-8") for _, artifact, _ in mutations}
    for label, artifact, token in mutations:
        original = originals[artifact]
        assert token in original, f"invalid fixture for {label}"
        artifact.write_text(original.replace(token, "removed", 1), encoding="utf-8")
        completed = _verify(path, artifacts)
        assert completed.returncode != 0, f"{label} unexpectedly passed"
        artifact.write_text(original, encoding="utf-8")


def test_phase_d_verifier_is_read_only_and_contains_no_data_movement():
    lowered = VERIFIER.read_text(encoding="utf-8").lower()
    for forbidden in (
        "@aws-sdk",
        "child_process",
        "sam deploy",
        "delete-table",
        "create-table",
        "batchwrite",
        "putcommand",
        "updatecommand",
        "import-trello",
        "backfill",
        "restore-table",
        "js-yaml",
        "safeload",
    ):
        assert forbidden not in lowered
