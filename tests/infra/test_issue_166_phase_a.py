from __future__ import annotations

import copy
import subprocess
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
PREPARER = REPO_ROOT / "scripts" / "deploy" / "prepare-issue-166-phase-a.mjs"


def _synthetic_built_template() -> dict:
    return {
        "AWSTemplateFormatVersion": "2010-09-09",
        "Resources": {
            "DataOpsTasksTable": {
                "Type": "AWS::DynamoDB::Table",
                "DeletionPolicy": "Retain",
                "UpdateReplacePolicy": "Retain",
                "Properties": {
                    "TableName": {"Fn::Sub": "${AWS::StackName}-tasks"},
                    "AttributeDefinitions": [
                        {"AttributeName": "PK", "AttributeType": "S"},
                        {"AttributeName": "SK", "AttributeType": "S"},
                        {"AttributeName": "date", "AttributeType": "S"},
                        {"AttributeName": "status", "AttributeType": "S"},
                        {"AttributeName": "cardId", "AttributeType": "S"},
                        {"AttributeName": "bundleId", "AttributeType": "S"},
                    ],
                    "GlobalSecondaryIndexes": [
                        {"IndexName": name}
                        for name in ("GSI-Date", "GSI-Card", "GSI-Bundle", "GSI-Status")
                    ],
                },
            },
            "BackendFunction": {
                "Type": "AWS::Serverless::Function",
                "Properties": {
                    "Handler": "dist/handler.handler",
                    "Events": {"DailyBackendCron": {"Type": "Schedule"}},
                },
            },
            "ConversationalExecutionWorkerFunction": {
                "Type": "AWS::Serverless::Function",
                "Properties": {
                    "Handler": "dist/execution-worker-handler.handler",
                    "Events": {
                        "QueuedAttemptStream": {"Type": "DynamoDB"},
                        "ExecutionRecovery": {"Type": "Schedule"},
                    },
                },
            },
        },
        "Outputs": {"DataOpsTasksTableName": {"Value": {"Ref": "DataOpsTasksTable"}}},
    }


def _run_preparer(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(PREPARER), str(path)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def test_phase_a_artifact_quiesces_writers_and_only_arms_existing_table(tmp_path: Path):
    template_path = tmp_path / "template.yaml"
    source = _synthetic_built_template()
    original_tasks_properties = copy.deepcopy(
        source["Resources"]["DataOpsTasksTable"]["Properties"]
    )
    template_path.write_text(yaml.safe_dump(source), encoding="utf-8")

    completed = _run_preparer(template_path)

    assert completed.returncode == 0, completed.stderr
    prepared = yaml.safe_load(template_path.read_text(encoding="utf-8"))
    assert prepared["Metadata"]["DataOpsIssue166Cutover"] == {"Issue": 166, "Phase": "A"}
    tasks = prepared["Resources"]["DataOpsTasksTable"]
    assert tasks["DeletionPolicy"] == "Delete"
    assert tasks["UpdateReplacePolicy"] == "Delete"
    assert tasks["Properties"] == original_tasks_properties
    assert prepared["Outputs"]["DataOpsTasksTableName"] == {
        "Value": {"Ref": "DataOpsTasksTable"}
    }
    for logical_id in (
        "BackendFunction",
        "ConversationalExecutionWorkerFunction",
    ):
        properties = prepared["Resources"][logical_id]["Properties"]
        assert properties["ReservedConcurrentExecutions"] == 0
        assert "Events" not in properties


def test_phase_a_preparer_refuses_to_advance_or_repeat_a_cutover(tmp_path: Path):
    template_path = tmp_path / "template.yaml"
    source = _synthetic_built_template()
    source["Resources"].pop("DataOpsTasksTable")
    template_path.write_text(yaml.safe_dump(source), encoding="utf-8")
    removed = _run_preparer(template_path)
    assert removed.returncode != 0
    assert "DataOpsTasksTable must remain" in removed.stderr

    source = _synthetic_built_template()
    source["Resources"]["DataOpsTasksTable"]["DeletionPolicy"] = "Delete"
    template_path.write_text(yaml.safe_dump(source), encoding="utf-8")
    armed = _run_preparer(template_path)
    assert armed.returncode != 0
    assert "must start with Retain/Retain" in armed.stderr


def test_phase_a_preparer_contains_no_aws_or_data_movement_commands():
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
    ):
        assert forbidden not in lowered

    # Keep the preparer intentionally one-shot rather than a reusable migration framework.
    assert "Phase: 'A'" in script
    assert "phase-b" not in lowered
    assert "phase-c" not in lowered
    assert "phase-d" not in lowered
