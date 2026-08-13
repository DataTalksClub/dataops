from __future__ import annotations

import copy
import json
import subprocess
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
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
        check=False,
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
