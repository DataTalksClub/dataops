from __future__ import annotations

import copy
import json
import subprocess
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
PREPARER = REPO_ROOT / "scripts" / "deploy" / "prepare-issue-166-phase-c.mjs"


def _indexes() -> list[dict]:
    keys = {
        "GSI-Date": ("date", "status"),
        "GSI-Card": ("cardId", "date"),
        "GSI-Bundle": ("bundleId", "date"),
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


def _source() -> dict:
    task_arn = {"Fn::GetAtt": ["DataOpsTasksTable", "Arn"]}

    def writer(events: dict) -> dict:
        return {
            "Type": "AWS::Serverless::Function",
            "Properties": {
                "Events": events,
                "Policies": [{"Statement": {"Resource": task_arn}}],
            },
        }

    worker = writer({"Queue": {"Type": "SQS"}})
    worker["Properties"]["Environment"] = {
        "Variables": {"DATAOPS_TASKS_TABLE": {"Ref": "DataOpsTasksTable"}}
    }
    return {
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
                        for name in ("PK", "SK", "date", "status", "cardId", "bundleId")
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
            "BackendFunction": writer({"Api": {"Type": "Api"}}),
            "ConversationalExecutionWorkerFunction": worker,
            "UnrelatedResource": {"Type": "AWS::SQS::Queue"},
        },
        "Outputs": {
            "DataOpsTasksTableName": {"Value": {"Ref": "DataOpsTasksTable"}},
            "Unrelated": {"Value": "unchanged"},
        },
    }


def _run(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(PREPARER), str(path)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def test_phase_c_artifact_declares_only_final_empty_schema_and_keeps_dependencies(tmp_path: Path):
    path = tmp_path / "template.yaml"
    source = _source()
    unrelated = copy.deepcopy(source["Resources"]["UnrelatedResource"])
    path.write_text(yaml.safe_dump(source), encoding="utf-8")

    completed = _run(path)
    assert completed.returncode == 0, completed.stderr
    prepared = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert prepared["Metadata"]["DataOpsIssue166Cutover"] == {"Issue": 166, "Phase": "C"}
    tasks = prepared["Resources"]["DataOpsTasksTable"]
    assert tasks["DeletionPolicy"] == tasks["UpdateReplacePolicy"] == "Retain"
    assert [item["AttributeName"] for item in tasks["Properties"]["AttributeDefinitions"]] == [
        "PK", "SK", "date", "status", "cardId"
    ]
    assert [item["IndexName"] for item in tasks["Properties"]["GlobalSecondaryIndexes"]] == [
        "GSI-Date", "GSI-Card", "GSI-Status"
    ]
    assert "bundleId" not in json.dumps(prepared)
    assert "GSI-Bundle" not in json.dumps(prepared)
    assert prepared["Outputs"]["DataOpsTasksTableName"]["Value"] == {"Ref": "DataOpsTasksTable"}
    assert prepared["Resources"]["UnrelatedResource"] == unrelated
    for name in ("BackendFunction", "ConversationalExecutionWorkerFunction"):
        props = prepared["Resources"][name]["Properties"]
        assert props["ReservedConcurrentExecutions"] == 0
        assert "Events" not in props
        assert "DataOpsTasksTable" in json.dumps(props["Policies"])
    assert prepared["Resources"]["ConversationalExecutionWorkerFunction"]["Properties"]["Environment"]["Variables"]["DATAOPS_TASKS_TABLE"] == {"Ref": "DataOpsTasksTable"}


def test_phase_c_preparer_refuses_noncanonical_or_already_marked_source(tmp_path: Path):
    path = tmp_path / "template.yaml"
    source = _source()
    source["Metadata"] = {"DataOpsIssue166Cutover": {"Issue": 166, "Phase": "B"}}
    path.write_text(yaml.safe_dump(source), encoding="utf-8")
    assert _run(path).returncode != 0

    source = _source()
    source["Resources"]["DataOpsTasksTable"]["Properties"]["Tags"].pop()
    path.write_text(yaml.safe_dump(source), encoding="utf-8")
    completed = _run(path)
    assert completed.returncode != 0
    assert "exact runtime ownership tags" in completed.stderr

    source = _source()
    source["Resources"]["AlternateTasksTable"] = {
        "Type": "AWS::DynamoDB::Table",
        "Properties": {"TableName": "dataops-v1-tasks"},
    }
    path.write_text(yaml.safe_dump(source), encoding="utf-8")
    completed = _run(path)
    assert completed.returncode != 0
    assert "exactly one canonical Tasks table and no alternate" in completed.stderr


def test_phase_c_preparer_has_no_aws_data_movement_or_later_phase():
    lowered = PREPARER.read_text(encoding="utf-8").lower()
    for forbidden in (
        "aws ", "sam deploy", "delete-table", "create-table", "import-", "backfill",
        "restore", "phase-d",
    ):
        assert forbidden not in lowered
