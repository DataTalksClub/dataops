from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-dataops-v1.yml"
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


def test_phase_c_workflow_is_exact_single_build_and_fail_closed():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    for required in (
        "create-empty-final-dataops-v1-tasks",
        "items=281,cardId=0,bundleId=153",
        "requires the exact deployed Phase B marker, absence, and quiescence",
        "prepare-issue-166-phase-c.mjs .aws-sam/build/template.yaml",
        'Phase: \'C\'',
        'TableId != "b4e83537-7cf6-41cb-a281-8a52f678b1a3"',
        "PAY_PER_REQUEST",
        "describe-continuous-backups",
        "list-tags-of-resource",
        "--consistent-read --select COUNT",
        "Environment.Variables.DATAOPS_TASKS_TABLE",
        "resources.BackendFunctionRole",
        "resources.ConversationalExecutionWorkerFunctionRole",
        "JSON.stringify({ 'Fn::Sub': '${AWS::StackName}-tasks' })",
    ):
        assert required in workflow
    assert workflow.count("- issue-166-phase-c") == 1
    assert workflow.count("if: env.DEPLOYMENT_MODE == 'issue-166-phase-c'") == 3
    assert workflow.count("run: make sam-build") == 1
    assert workflow.count("--query TemplateBody --output text") == 0
    assert workflow.count("typeof encodedTemplate === 'string' ? yaml.safeLoad(encodedTemplate) : encodedTemplate") == 5
    assert workflow.count(
        "JSON.stringify(tasks?.Properties?.TableName)"
    ) == 2
    assert workflow.count(
        "JSON.stringify({ 'Fn::Sub': '${AWS::StackName}-tasks' })"
    ) == 2
    assert "tasks?.Properties?.TableName === 'dataops-v1-tasks'" not in workflow
    assert "issue-166-phase-d" not in workflow
    assert workflow.index("run: make sam-build") < workflow.index("prepare-issue-166-phase-c.mjs") < workflow.index("- name: Deploy DataOps v1 stack")
    phase_c = workflow.split(
        '- name: "Verify issue #166 Phase C exact recovery point and Phase B absence"', 1
    )[1].split("- name: Seed runtime users and recurring configs", 1)[0]
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
        assert forbidden not in phase_c.lower()


def test_cloudformation_template_loader_accepts_object_and_string_forms(tmp_path: Path):
    loader = """
      import { readFileSync } from 'node:fs';
      import yaml from 'js-yaml';
      const encodedTemplate = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      const template = typeof encodedTemplate === 'string' ? yaml.safeLoad(encodedTemplate) : encodedTemplate;
      if (template?.Metadata?.Proof !== 'ok') process.exit(1);
    """
    forms = [
        {"Metadata": {"Proof": "ok"}},
        "Metadata:\n  Proof: ok\n",
    ]
    for index, form in enumerate(forms):
        path = tmp_path / f"template-{index}.json"
        path.write_text(json.dumps(form), encoding="utf-8")
        completed = subprocess.run(
            ["node", "--input-type=module", "-", str(path)],
            cwd=REPO_ROOT,
            input=loader,
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, completed.stderr


def test_phase_c_preparer_has_no_aws_data_movement_or_later_phase():
    lowered = PREPARER.read_text(encoding="utf-8").lower()
    for forbidden in (
        "aws ", "sam deploy", "delete-table", "create-table", "import-", "backfill",
        "restore", "phase-d",
    ):
        assert forbidden not in lowered
