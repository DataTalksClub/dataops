from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-dataops-v1.yml"
PREPARER = REPO_ROOT / "scripts" / "deploy" / "prepare-issue-166-phase-b.mjs"


def _task_reference() -> dict:
    return {"Fn::GetAtt": ["DataOpsTasksTable", "Arn"]}


def _synthetic_built_template() -> dict:
    return {
        "AWSTemplateFormatVersion": "2010-09-09",
        "Transform": "AWS::Serverless-2016-10-31",
        "Resources": {
            "DataOpsTasksTable": {
                "Type": "AWS::DynamoDB::Table",
                "DeletionPolicy": "Retain",
                "UpdateReplacePolicy": "Retain",
                "Properties": {
                    "TableName": {"Fn::Sub": "${AWS::StackName}-tasks"},
                    "AttributeDefinitions": [
                        {"AttributeName": name, "AttributeType": "S"}
                        for name in ("PK", "SK", "date", "status", "cardId", "bundleId")
                    ],
                    "GlobalSecondaryIndexes": [
                        {"IndexName": name}
                        for name in ("GSI-Date", "GSI-Card", "GSI-Bundle", "GSI-Status")
                    ],
                },
            },
            "DataOpsCardsTable": {
                "Type": "AWS::DynamoDB::Table",
                "Properties": {"TableName": "dataops-v1-cards"},
            },
            "BackendFunction": {
                "Type": "AWS::Serverless::Function",
                "Properties": {
                    "Handler": "dist/handler.handler",
                    "Events": {"DailyBackendCron": {"Type": "Schedule"}},
                    "Policies": [
                        {
                            "Statement": {
                                "Effect": "Allow",
                                "Action": ["dynamodb:GetItem"],
                                "Resource": [
                                    _task_reference(),
                                    {"Fn::Sub": "${DataOpsTasksTable.Arn}/index/*"},
                                    {"Fn::GetAtt": ["DataOpsCardsTable", "Arn"]},
                                ],
                            }
                        }
                    ],
                },
            },
            "ConversationalExecutionWorkerFunction": {
                "Type": "AWS::Serverless::Function",
                "Properties": {
                    "Handler": "dist/execution-worker-handler.handler",
                    "Environment": {
                        "Variables": {
                            "DATAOPS_TASKS_TABLE": {"Ref": "DataOpsTasksTable"},
                            "DATAOPS_ENV": "prod",
                        }
                    },
                    "Events": {
                        "QueuedAttemptStream": {"Type": "DynamoDB"},
                        "ExecutionRecovery": {"Type": "Schedule"},
                    },
                    "Policies": [
                        {
                            "Statement": {
                                "Effect": "Allow",
                                "Action": ["dynamodb:GetItem", "dynamodb:PutItem"],
                                "Resource": [_task_reference()],
                            }
                        },
                        {
                            "Statement": {
                                "Effect": "Allow",
                                "Action": "sqs:SendMessage",
                                "Resource": "queue-arn",
                            }
                        },
                    ],
                },
            },
        },
        "Outputs": {
            "DataOpsTasksTableName": {
                "Description": "Tasks table",
                "Value": {"Ref": "DataOpsTasksTable"},
            },
            "DataOpsCardsTableName": {"Value": {"Ref": "DataOpsCardsTable"}},
        },
    }


def _run_preparer(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(PREPARER), str(path)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


def test_phase_b_artifact_removes_table_and_dependencies_while_writers_stay_closed(
    tmp_path: Path,
):
    template_path = tmp_path / "template.yaml"
    source = _synthetic_built_template()
    expected_cards = copy.deepcopy(source["Resources"]["DataOpsCardsTable"])
    expected_cards_output = copy.deepcopy(source["Outputs"]["DataOpsCardsTableName"])
    template_path.write_text(yaml.safe_dump(source), encoding="utf-8")

    completed = _run_preparer(template_path)

    assert completed.returncode == 0, completed.stderr
    prepared = yaml.safe_load(template_path.read_text(encoding="utf-8"))
    assert prepared["Metadata"]["DataOpsIssue166Cutover"] == {"Issue": 166, "Phase": "B"}
    assert "DataOpsTasksTable" not in prepared["Resources"]
    assert "DataOpsTasksTableName" not in prepared["Outputs"]
    assert "DataOpsTasksTable" not in json.dumps(prepared)
    assert prepared["Resources"]["DataOpsCardsTable"] == expected_cards
    assert prepared["Outputs"]["DataOpsCardsTableName"] == expected_cards_output

    backend = prepared["Resources"]["BackendFunction"]["Properties"]
    worker = prepared["Resources"]["ConversationalExecutionWorkerFunction"]["Properties"]
    for writer in (backend, worker):
        assert writer["ReservedConcurrentExecutions"] == 0
        assert "Events" not in writer
    assert worker["Environment"]["Variables"]["DATAOPS_TASKS_TABLE"] == "dataops-v1-tasks"
    assert worker["Policies"] == [
        {
            "Statement": {
                "Effect": "Allow",
                "Action": "sqs:SendMessage",
                "Resource": "queue-arn",
            }
        }
    ]
    assert backend["Policies"][0]["Statement"]["Resource"] == [
        {"Fn::GetAtt": ["DataOpsCardsTable", "Arn"]}
    ]


def test_phase_b_preparer_refuses_any_noncanonical_source_state(tmp_path: Path):
    template_path = tmp_path / "template.yaml"

    source = _synthetic_built_template()
    source["Metadata"] = {"DataOpsIssue166Cutover": {"Issue": 166, "Phase": "A"}}
    template_path.write_text(yaml.safe_dump(source), encoding="utf-8")
    marked = _run_preparer(template_path)
    assert marked.returncode != 0
    assert "already contains an issue #166 cutover marker" in marked.stderr

    source = _synthetic_built_template()
    source["Resources"]["DataOpsTasksTable"]["Properties"]["GlobalSecondaryIndexes"].pop()
    template_path.write_text(yaml.safe_dump(source), encoding="utf-8")
    wrong_schema = _run_preparer(template_path)
    assert wrong_schema.returncode != 0
    assert "exact transitional indexes" in wrong_schema.stderr

    source = _synthetic_built_template()
    source["Outputs"].pop("DataOpsTasksTableName")
    template_path.write_text(yaml.safe_dump(source), encoding="utf-8")
    missing_output = _run_preparer(template_path)
    assert missing_output.returncode != 0
    assert "canonical Tasks-table output" in missing_output.stderr


def test_phase_b_workflow_is_manual_exact_and_advances_only_from_proven_phase_a():
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert workflow.count("- issue-166-phase-b") == 1
    for required in (
        '[ "$GITHUB_EVENT_NAME" != "workflow_dispatch" ]',
        '[ "$GITHUB_REF" != "refs/heads/main" ]',
        '[ "$ISSUE_166_COMMIT" != "$GITHUB_SHA" ]',
        "dataops-v1-tasks-pre-card-schema-2026-08-13",
        "items=281,cardId=0,bundleId=153",
        "remove-proven-phase-a-dataops-v1-tasks",
        "JSON.stringify({ Issue: 166, Phase: 'A' })",
        "tasks?.DeletionPolicy === 'Delete'",
        "tasks?.UpdateReplacePolicy === 'Delete'",
        "Issue #166 Phase B requires the exact deployed Phase A marker, Delete policies, schema, and quiescence",
    ):
        assert required in workflow

    assert "issue-166-phase-c" not in workflow
    assert "issue-166-phase-d" not in workflow
    assert workflow.count("run: make sam-build") == 1
    assert workflow.count("if: env.DEPLOYMENT_MODE == 'issue-166-phase-b'") == 3
    build_at = workflow.index("run: make sam-build")
    frontend_at = workflow.index("run: make verify-sam-frontend")
    runtime_at = workflow.index("run: make verify-sam-runtime-boundary")
    isolation_at = workflow.index("run: make test-sam-frontend-isolation")
    prepare_at = workflow.index(
        "node scripts/deploy/prepare-issue-166-phase-b.mjs .aws-sam/build/template.yaml"
    )
    deploy_at = workflow.index("- name: Deploy DataOps v1 stack")
    assert build_at < frontend_at < runtime_at < isolation_at < prepare_at < deploy_at


def test_phase_b_preflight_and_postcheck_fail_closed_on_every_production_boundary():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    preflight = workflow.split(
        '- name: "Verify issue #166 Phase B exact recovery point and quiescence"', 1
    )[1].split('- name: "Protect bounded issue #166 cutover state"', 1)[0]
    postcheck = workflow.split(
        '- name: "Assert bounded issue #166 Phase B result"', 1
    )[1].split("- name: Seed runtime users and recurring configs", 1)[0]

    for required in (
        "UPDATE_COMPLETE",
        "describe-stack-resource",
        "DataOpsTasksTable",
        "dataops-v1-tasks",
        "b4e83537-7cf6-41cb-a281-8a52f678b1a3",
        "GSI-Bundle",
        "GSI-Card",
        "GSI-Date",
        "GSI-Status",
        "describe-continuous-backups",
        "list-backups",
        "describe-backup",
        'BackupStatus == "AVAILABLE"',
        "get-function-concurrency",
        "list-rule-names-by-target",
        "list-event-source-mappings",
        "sleep 35",
        "281:0:153",
    ):
        assert required in preflight

    for required in (
        "UPDATE_COMPLETE",
        "get-template",
        "Phase: 'B'",
        "resources.DataOpsTasksTable === undefined",
        "outputs.DataOpsTasksTableName === undefined",
        "describe-stack-resource",
        "(ValidationError)",
        "does not exist",
        "dynamodb describe-table",
        "(ResourceNotFoundException)",
        "get-function-concurrency",
        "list-rule-names-by-target",
        "list-event-source-mappings",
    ):
        assert required in postcheck

    assert "if: env.DEPLOYMENT_MODE == 'normal'" in workflow.split(
        "- name: Seed runtime users and recurring configs", 1
    )[1]
    assert "if: env.DEPLOYMENT_MODE == 'normal'" in workflow.split(
        "- name: Smoke test deployed single-origin backend", 1
    )[1]


def test_phase_b_preparer_is_one_shot_and_contains_no_aws_or_data_movement_commands():
    script = PREPARER.read_text(encoding="utf-8")
    lowered = script.lower()
    for forbidden in (
        "aws ",
        "sam deploy",
        "delete-table",
        "create-table",
        "import-trello",
        "dry-run-import",
        "backfill",
        "restore",
        "phase-c",
        "phase-d",
    ):
        assert forbidden not in lowered

    assert "Phase: 'B'" in script
    assert "DataOpsTasksTable" in script
    assert "dataops-v1-tasks" in script
