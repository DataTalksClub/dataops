from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = REPO_ROOT / "lambda-functions" / "template.full.yaml"
DEPLOY_ROLE_TEMPLATE = REPO_ROOT / "lambda-functions" / "template.github-actions-dataops.yaml"
LEGACY_DEPLOY_ROLE_TEMPLATE = REPO_ROOT / "lambda-functions" / "template.github-actions.yaml"
DEPLOY_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-dataops-v1.yml"


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
        "DataOpsArtifactsTable",
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


def test_dataops_sessions_table_is_retained_session_state_not_durable_execution_state():
    template = TEMPLATE.read_text(encoding="utf-8")
    sessions = _resource_block(template, "DataOpsSessionsTable")

    assert "Type: AWS::DynamoDB::Table" in sessions
    assert "DeletionPolicy: Retain" in sessions
    assert "UpdateReplacePolicy: Retain" in sessions
    assert "BillingMode: PAY_PER_REQUEST" in sessions
    assert "SSEEnabled: true" in sessions
    assert "PointInTimeRecoveryEnabled: true" not in sessions
    assert "Value: SessionState" in sessions
    assert "Value: ExecutionState" not in sessions


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
        "DataOpsArtifactsTableName",
        "DataOpsNotificationsTableName",
        "DataOpsSessionsTableName",
        "DataOpsExportArchiveBucketName",
        "DataOpsExportArchivePrefix",
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
    assert "CodeUri: .." in work_engine
    assert "Runtime: nodejs24.x" in work_engine
    assert "Handler: dist/handler.handler" in work_engine
    assert "FunctionUrlConfig" not in work_engine
    assert "WORK_ENGINE_AUTH_MODE: portal" in work_engine
    assert "DATAOPS_TASKS_TABLE: !Ref DataOpsTasksTable" in work_engine
    assert "DATAOPS_BUNDLES_TABLE: !Ref DataOpsBundlesTable" in work_engine
    assert "DATAOPS_TEMPLATES_TABLE: !Ref DataOpsTemplatesTable" in work_engine
    assert "DATAOPS_USERS_TABLE: !Ref DataOpsUsersTable" in work_engine
    assert "DATAOPS_FILES_TABLE: !Ref DataOpsFilesTable" in work_engine
    assert "DATAOPS_ARTIFACTS_TABLE: !Ref DataOpsArtifactsTable" in work_engine
    assert "DATAOPS_NOTIFICATIONS_TABLE: !Ref DataOpsNotificationsTable" in work_engine
    assert "DATAOPS_SESSIONS_TABLE: !Ref DataOpsSessionsTable" in work_engine
    assert "DATAOPS_EXPORT_ARCHIVE_BUCKET: !Ref DataOpsExportArchiveBucket" in work_engine
    assert "DATAOPS_EXPORT_ARCHIVE_PREFIX: !Ref ExportArchivePrefix" in work_engine
    assert "dynamodb:GetItem" in work_engine
    assert "dynamodb:PutItem" in work_engine
    assert "dynamodb:Query" in work_engine
    assert "dynamodb:Scan" in work_engine
    assert "dynamodb:UpdateItem" in work_engine
    assert "dynamodb:DeleteItem" in work_engine
    assert "dynamodb:BatchGetItem" not in work_engine
    assert "dynamodb:BatchWriteItem" not in work_engine
    assert "dynamodb:DescribeTable" not in work_engine
    assert "${DataOpsTasksTable.Arn}/index/*" in work_engine
    assert "${DataOpsFilesTable.Arn}/index/*" in work_engine
    assert "secretsmanager:GetSecretValue" in work_engine
    assert "s3:PutObject" in work_engine
    assert "${DataOpsExportArchiveBucket.Arn}/${ExportArchivePrefix}/*" in work_engine
    assert "DailyWorkEngineExport" in work_engine
    assert '"dataopsAction":"export"' in work_engine
    assert "WORK_ENGINE_PORTAL_SECRET_NAME: !Ref WorkEnginePortalSecret" in work_engine

    assert "WORK_ENGINE_FUNCTION_NAME: !Ref WorkEngineFunction" in docs_app
    assert "WORK_ENGINE_PORTAL_SECRET_NAME: !Ref WorkEnginePortalSecret" in docs_app
    assert "lambda:InvokeFunction" in docs_app
    assert "!GetAtt WorkEngineFunction.Arn" in docs_app
    assert "  WorkEngineFunctionName:" in template
    assert "  WorkEnginePortalSecretName:" in template


def test_dataops_export_archive_bucket_is_private_retained_and_versioned():
    template = TEMPLATE.read_text(encoding="utf-8")
    bucket = _resource_block(template, "DataOpsExportArchiveBucket")

    assert "Type: AWS::S3::Bucket" in bucket
    assert "DeletionPolicy: Retain" in bucket
    assert "UpdateReplacePolicy: Retain" in bucket
    assert "BlockPublicAcls: true" in bucket
    assert "BlockPublicPolicy: true" in bucket
    assert "IgnorePublicAcls: true" in bucket
    assert "RestrictPublicBuckets: true" in bucket
    assert "SSEAlgorithm: AES256" in bucket
    assert "Status: Enabled" in bucket
    assert "NoncurrentVersionExpirationInDays: !Ref ExportArchiveRetentionDays" in bucket
    assert "Value: ExecutionExportArchive" in bucket
    assert "Value: DataOpsV1ExecutionExports" in bucket


def test_github_deploy_role_can_manage_dataops_execution_tables():
    template = DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")

    assert "Sid: DynamoDbDataOpsExecutionTables" in template
    assert "dynamodb:CreateTable" in template
    assert "dynamodb:DescribeTable" in template
    assert "dynamodb:UpdateContinuousBackups" in template
    assert "dynamodb:UpdateTable" in template
    assert "table/${FullDocsStackName}-*" in template


def test_github_deploy_role_can_seed_runtime_users_and_templates():
    template = DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")
    runtime_seed = template[
        template.index("Sid: DynamoDbDataOpsRuntimeSeed") : template.index("Sid: DynamoDbDataOpsRecurringSeed")
    ]

    assert "Sid: DynamoDbDataOpsRuntimeSeed" in runtime_seed
    assert "dynamodb:GetItem" in runtime_seed
    assert "dynamodb:PutItem" in runtime_seed
    assert "dynamodb:Scan" in runtime_seed
    assert "dynamodb:UpdateItem" not in runtime_seed
    assert "dynamodb:BatchWriteItem" not in runtime_seed
    assert "table/${FullDocsStackName}-users" in runtime_seed
    assert "table/${FullDocsStackName}-templates" in runtime_seed


def test_github_deploy_role_can_seed_recurring_configs_in_tasks_table():
    template = DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")
    recurring_seed = template[
        template.index("Sid: DynamoDbDataOpsRecurringSeed") : template.index("Sid: IamDataOpsFunctionRole")
    ]

    assert "Sid: DynamoDbDataOpsRecurringSeed" in recurring_seed
    assert "dynamodb:PutItem" in recurring_seed
    assert "dynamodb:Scan" in recurring_seed
    assert "dynamodb:UpdateItem" in recurring_seed
    assert "dynamodb:BatchWriteItem" not in recurring_seed
    assert "dynamodb:DeleteItem" not in recurring_seed
    assert "table/${FullDocsStackName}-tasks" in recurring_seed
    assert "table/${FullDocsStackName}-users" not in recurring_seed
    assert "table/${FullDocsStackName}-templates" not in recurring_seed


def test_deploy_workflow_seeds_and_verifies_runtime_templates():
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")

    assert "Seed runtime users, workflow templates, and recurring configs" in workflow
    assert "DataOpsTasksTableName" in workflow
    assert "DataOpsUsersTableName" in workflow
    assert "DataOpsTemplatesTableName" in workflow
    assert "scripts/seed-users.ts" in workflow
    assert "scripts/seed-templates.ts" in workflow
    assert "scripts/seed-recurring.ts" in workflow
    assert workflow.index("scripts/seed-users.ts") < workflow.index("scripts/seed-templates.ts")
    assert workflow.index("scripts/seed-templates.ts") < workflow.index("scripts/seed-recurring.ts")
    assert "Smoke test deployed workflow templates" in workflow
    assert "WorkEnginePortalSecretName" in workflow
    assert "/api/templates" in workflow
    assert "x-portal-auth" in workflow
    assert "x-portal-secret" in workflow
    assert "fileb:///tmp/work-engine-templates-payload.json" in workflow
    assert "len(templates) >= 11" in workflow
    assert 'template.get("type") == "podcast"' in workflow


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


def test_github_deploy_role_can_manage_dataops_eventbridge_rules():
    template = DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")

    assert "Sid: EventBridgeDataOpsRules" in template
    assert "events:DescribeRule" in template
    assert "events:PutRule" in template
    assert "events:PutTargets" in template
    assert "events:RemoveTargets" in template
    assert "events:DeleteRule" in template
    assert "events:ListTargetsByRule" in template
    assert "events:TagResource" in template
    assert "events:UntagResource" in template
    assert "events:${FullDocsRegion}:${AWS::AccountId}:rule/${FullDocsStackName}-*" in template


def test_github_deploy_role_can_manage_dataops_export_archive_bucket():
    template = DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")

    assert "Sid: DataOpsExportArchiveBucket" in template
    assert "s3:CreateBucket" in template
    assert "s3:PutEncryptionConfiguration" in template
    assert "s3:PutBucketPublicAccessBlock" in template
    assert "s3:PutBucketVersioning" in template
    assert "s3:PutLifecycleConfiguration" in template
    assert "s3:PutBucketTagging" in template
    assert "arn:${AWS::Partition}:s3:::${FullDocsStackName}-*" in template


def test_active_and_legacy_oidc_templates_default_to_dataops_repo_and_stack():
    active = DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")
    legacy = LEGACY_DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")

    for template in (active, legacy):
        assert "Default: DataTalksClub" in template
        assert "Default: dataops" in template
        assert "Default: dataops-v1" in template
        assert "Default: dtc-operations" not in template
        assert "Default: dtc-operations-full-sandbox" not in template


def test_maintenance_scripts_default_to_dataops_content_and_tmp_outputs():
    audit = (REPO_ROOT / "scripts" / "audit_doc_structure.py").read_text(encoding="utf-8")
    standardize = (REPO_ROOT / "scripts" / "standardize_doc_structure.py").read_text(encoding="utf-8")
    optimize = (REPO_ROOT / "scripts" / "optimize_images.py").read_text(encoding="utf-8")
    convert = (REPO_ROOT / "scripts" / "convert_processes.py").read_text(encoding="utf-8")

    assert 'DOCS_DIR = ROOT / "content"' in audit
    assert "from audit_doc_structure import DOCS_DIR" in standardize
    assert 'DOCS_DIR = ROOT / "content"' in optimize
    assert 'IMAGES_DIR = ROOT / "content" / "images"' in optimize
    assert 'REPORT = ROOT / ".tmp" / "image-optimization-report.csv"' in optimize
    assert 'DOCS_DIR = ROOT / "content"' in convert
    assert 'IMAGES_DIR = ROOT / "content" / "images"' in convert
    assert 'MANIFEST = ROOT / ".tmp" / "conversion-manifest.csv"' in convert
    assert "TemporaryDirectory(prefix=\"processes-\", dir=temp_root)" in convert
