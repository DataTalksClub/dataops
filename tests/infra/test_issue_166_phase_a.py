from __future__ import annotations

import copy
from pathlib import Path
import subprocess

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-dataops-v1.yml"
SOURCE_TEMPLATE = REPO_ROOT / "infra" / "template.full.yaml"
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


def test_normal_source_and_push_deploy_cannot_enter_the_destructive_sequence():
    source = SOURCE_TEMPLATE.read_text(encoding="utf-8")
    workflow = WORKFLOW.read_text(encoding="utf-8")
    tasks = source.split("  DataOpsTasksTable:\n", 1)[1].split("\n  DataOpsCardsTable:", 1)[0]

    assert "DeletionPolicy: Retain" in tasks
    assert "UpdateReplacePolicy: Retain" in tasks
    assert "DataOpsIssue166Cutover" not in source
    assert "deployment_mode:" in workflow
    assert "${{ github.event_name == 'workflow_dispatch' && inputs.deployment_mode || 'normal' }}" in workflow
    assert 'if [ -n "$ISSUE_166_COMMIT$ISSUE_166_BACKUP_NAME$ISSUE_166_EXPECTED_LEDGER$ISSUE_166_CONFIRMATION" ]' in workflow
    assert "Normal deploy refuses issue #166 cutover inputs" in workflow
    assert "refuses active issue #166 cutover state; use the next reviewed phase" in workflow
    assert "refuses Tasks policies other than deployed Retain/Retain" in workflow
    build_at = workflow.index("run: make sam-build")
    protection_at = workflow.index('name: "Protect bounded issue #166 cutover state"')
    deploy_at = workflow.index("- name: Deploy DataOps v1 stack")
    assert protection_at < build_at < deploy_at
    assert workflow.count("- issue-166-phase-a") == 1
    assert workflow.count("- issue-166-phase-b") == 1
    assert "issue-166-phase-c" not in workflow
    assert "issue-166-phase-d" not in workflow


def test_phase_a_requires_exact_identity_and_replaces_task_dependent_post_deploy_work():
    workflow = WORKFLOW.read_text(encoding="utf-8")

    required_guards = (
        '[ "$GITHUB_EVENT_NAME" != "workflow_dispatch" ]',
        '[ "$GITHUB_REF" != "refs/heads/main" ]',
        '[ "$ISSUE_166_COMMIT" != "$GITHUB_SHA" ]',
        'dataops-v1-tasks-pre-card-schema-2026-08-13',
        'b4e83537-7cf6-41cb-a281-8a52f678b1a3',
        'items=281,cardId=0,bundleId=153',
        'quiesce-dataops-v1-tasks-and-arm-delete-policy',
        '.BackupDescription.BackupDetails.BackupStatus == "AVAILABLE"',
        '.BackupDescription.SourceTableDetails.TableArn == $tableArn',
        '.BackupDescription.SourceTableDetails.TableId == $tableId',
        '.BackupDescription.SourceTableFeatureDetails.SSEDescription.Status == "ENABLED"',
    )
    for guard in required_guards:
        assert guard in workflow
    phase_a_preflight = workflow.split(
        '- name: "Verify issue #166 Phase A preflight and exact backup"', 1
    )[1].split('- name: "Verify issue #166 Phase B exact recovery point and quiescence"', 1)[0]
    phase_a_result = workflow.split(
        '- name: "Assert bounded issue #166 Phase A result"', 1
    )[1].split('- name: "Assert bounded issue #166 Phase B result"', 1)[0]
    assert phase_a_preflight.count("b4e83537-7cf6-41cb-a281-8a52f678b1a3") == 1
    assert phase_a_result.count("b4e83537-7cf6-41cb-a281-8a52f678b1a3") == 1

    assert "node scripts/deploy/prepare-issue-166-phase-a.mjs .aws-sam/build/template.yaml" in workflow
    assert workflow.count("if: env.DEPLOYMENT_MODE == 'issue-166-phase-a'") == 3
    assert workflow.count("if: env.DEPLOYMENT_MODE == 'normal'") == 2
    assert "marker?.Issue === 166" in workflow
    assert "marker?.Phase === 'A'" in workflow
    assert "tasks?.Type === 'AWS::DynamoDB::Table'" in workflow
    assert "tasks?.DeletionPolicy === 'Delete'" in workflow
    assert "ReservedConcurrentExecutions === 0" in workflow
    assert "GSI-Bundle" in workflow
    assert "Issue #166 Phase A advanced the table schema" in workflow


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
