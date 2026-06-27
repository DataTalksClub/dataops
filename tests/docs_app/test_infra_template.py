from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = REPO_ROOT / "lambda-functions" / "template.full.yaml"
DEPLOY_ROLE_TEMPLATE = REPO_ROOT / "lambda-functions" / "template.github-actions-dataops.yaml"


def _resource_block(template: str, resource_name: str) -> str:
    marker = f"  {resource_name}:\n"
    lines = template.splitlines()
    start_index = next(index for index, line in enumerate(lines) if line + "\n" == marker)
    block_lines = [lines[start_index]]

    for line in lines[start_index + 1 :]:
        if line.startswith("  ") and not line.startswith("    "):
            break
        block_lines.append(line)

    return "\n".join(block_lines)


def test_dataops_execution_tables_have_retention_pitr_and_tags():
    template = TEMPLATE.read_text(encoding="utf-8")
    durable_tables = [
        "DataOpsTasksTable",
        "DataOpsBundlesTable",
        "DataOpsTemplatesTable",
        "DataOpsUsersTable",
        "DataOpsFilesTable",
        "DataOpsNotificationsTable",
    ]

    for table in durable_tables:
        block = _resource_block(template, table)
        assert "Type: AWS::DynamoDB::Table" in block
        assert "DeletionPolicy: Retain" in block
        assert "UpdateReplacePolicy: Retain" in block
        assert "BillingMode: PAY_PER_REQUEST" in block
        assert "SSEEnabled: true" in block
        assert "PointInTimeRecoveryEnabled: true" in block
        assert "Value: DataOpsV1" in block
        assert "Value: ExecutionState" in block


def test_dataops_execution_tables_match_work_engine_access_patterns():
    template = TEMPLATE.read_text(encoding="utf-8")
    tasks = _resource_block(template, "DataOpsTasksTable")
    files = _resource_block(template, "DataOpsFilesTable")

    assert "IndexName: GSI-Date" in tasks
    assert "IndexName: GSI-Bundle" in tasks
    assert "IndexName: GSI-Status" in tasks
    assert "AttributeName: date" in tasks
    assert "AttributeName: status" in tasks
    assert "AttributeName: bundleId" in tasks

    assert "IndexName: GSI-Task" in files
    assert "AttributeName: taskId" in files


def test_dataops_table_outputs_are_available_for_work_engine_env_wiring():
    template = TEMPLATE.read_text(encoding="utf-8")
    expected_outputs = [
        "DataOpsTasksTableName",
        "DataOpsBundlesTableName",
        "DataOpsTemplatesTableName",
        "DataOpsUsersTableName",
        "DataOpsFilesTableName",
        "DataOpsNotificationsTableName",
        "DataOpsSessionsTableName",
    ]

    for output in expected_outputs:
        assert f"  {output}:" in template


def test_private_work_engine_lambda_is_wired_to_dataops_tables():
    template = TEMPLATE.read_text(encoding="utf-8")
    work_engine = _resource_block(template, "WorkEngineFunction")
    docs_app = _resource_block(template, "DocsFullAppFunction")
    portal_secret = _resource_block(template, "WorkEnginePortalSecret")

    assert "Type: AWS::SecretsManager::Secret" in portal_secret
    assert "GenerateSecretString" in portal_secret
    assert "DeletionPolicy: Retain" in portal_secret
    assert "UpdateReplacePolicy: Retain" in portal_secret
    assert "Type: AWS::Serverless::Function" in work_engine
    assert "BuildMethod: makefile" in work_engine
    assert "CodeUri: ../work-engine" in work_engine
    assert "Runtime: nodejs20.x" in work_engine
    assert "Handler: dist/handler.handler" in work_engine
    assert "FunctionUrlConfig" not in work_engine
    assert "WORK_ENGINE_AUTH_MODE: portal" in work_engine
    assert "DATAOPS_TASKS_TABLE: !Ref DataOpsTasksTable" in work_engine
    assert "DATAOPS_SESSIONS_TABLE: !Ref DataOpsSessionsTable" in work_engine
    assert "dynamodb:Query" in work_engine
    assert "${DataOpsTasksTable.Arn}/index/*" in work_engine
    assert "secretsmanager:GetSecretValue" in work_engine
    assert "WORK_ENGINE_PORTAL_SECRET_NAME: !Ref WorkEnginePortalSecret" in work_engine

    assert "WORK_ENGINE_FUNCTION_NAME: !Ref WorkEngineFunction" in docs_app
    assert "WORK_ENGINE_PORTAL_SECRET_NAME: !Ref WorkEnginePortalSecret" in docs_app
    assert "lambda:InvokeFunction" in docs_app
    assert "!GetAtt WorkEngineFunction.Arn" in docs_app
    assert "  WorkEngineFunctionName:" in template
    assert "  WorkEnginePortalSecretName:" in template


def test_github_deploy_role_can_manage_dataops_execution_tables():
    template = DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")

    assert "Sid: DynamoDbDataOpsExecutionTables" in template
    assert "dynamodb:CreateTable" in template
    assert "dynamodb:DescribeTable" in template
    assert "dynamodb:UpdateContinuousBackups" in template
    assert "dynamodb:UpdateTable" in template
    assert "table/${FullDocsStackName}-*" in template


def test_github_deploy_role_can_manage_work_engine_lambda():
    template = DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")

    assert "lambda:ListTags" in template
    assert "iam:ListRoleTags" in template
    assert "function:${FullDocsStackName}-WorkEngineFunction-*" in template
    assert "role/${FullDocsStackName}-WorkEngineFunctionRole-*" in template
    assert "/aws/lambda/${FullDocsStackName}-WorkEngineFunction-*" in template
    assert "Sid: SecretsManagerDataOpsPortalSecret" in template
    assert "secretsmanager:CreateSecret" in template
    assert "secretsmanager:GetRandomPassword" in template
