from __future__ import annotations

import copy
from pathlib import Path
import re
import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = REPO_ROOT / "infra" / "template.full.yaml"
DEPLOY_ROLE_TEMPLATE = REPO_ROOT / "infra" / "template.github-actions-dataops.yaml"
LEGACY_DEPLOY_ROLE_TEMPLATE = REPO_ROOT / "infra" / "template.github-actions.yaml"
DEPLOY_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-dataops-v1.yml"
E2E_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "validate-backend-e2e.yml"
SANDBOX_CONSUMER_FUNCTIONS = {
    "BackendFunction",
}

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


def _load_template(path: Path = TEMPLATE) -> dict:
    return _load_template_text(path.read_text(encoding="utf-8"))


def _load_template_text(template: str) -> dict:
    return yaml.load(template, Loader=_CloudFormationLoader)


def _resolve_dataops_environment(value, environment: str):
    if value == {"Ref": "DataOpsEnvironment"}:
        return environment
    if isinstance(value, dict):
        return {key: _resolve_dataops_environment(item, environment) for key, item in value.items()}
    if isinstance(value, list):
        return [_resolve_dataops_environment(item, environment) for item in value]
    return value


def _assert_sandbox_provenance_contract(template: dict, workflow: str) -> None:
    assert template["Parameters"]["DataOpsEnvironment"] == {
        "Type": "String",
        "Default": "sandbox",
        "AllowedValues": ["sandbox"],
    }

    consumers = {
        logical_id: resource["Properties"]["Environment"]["Variables"]["DATAOPS_ENV"]
        for logical_id, resource in template["Resources"].items()
        if "DATAOPS_ENV" in resource.get("Properties", {}).get("Environment", {}).get("Variables", {})
    }
    assert set(consumers) == SANDBOX_CONSUMER_FUNCTIONS
    assert all(value == {"Ref": "DataOpsEnvironment"} for value in consumers.values())
    assert "WorkEngineFunction" not in template["Resources"]

    override = "ParameterKey=DataOpsEnvironment,ParameterValue=sandbox"
    assert workflow.count(override) == 1
    assert workflow.count("DataOpsEnvironment") == 1
    assert "ParameterKey=DataOpsEnvironment,ParameterValue=$" not in workflow
    assert not re.search(
        r"ParameterKey=DataOpsEnvironment,ParameterValue=(?:prod|production)",
        workflow,
        re.IGNORECASE,
    )
    assert "inputs:" not in workflow
    assert workflow.count("--config-env full-sandbox") == 1
    deploy = workflow.split("\n  deploy:\n", 1)[1]
    assert deploy.index("sam deploy") < deploy.index(override)
    assert deploy.index("ParameterKey=SponsorFinanceEnabled") < deploy.index(override)
    assert deploy.index(override) < deploy.index("ParameterKey=BackendTargetFunctionName")


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


def _template_with_parameter_default(template: str, parameter_name: str, value: str) -> str:
    parameter = _resource_block(template, parameter_name)
    default_false = '    Default: "false"'
    assert default_false in parameter
    updated_parameter = parameter.replace(default_false, f'    Default: "{value}"', 1)
    assert updated_parameter != parameter
    return template.replace(parameter, updated_parameter, 1)


def _template_with_defaults(template: str, values: dict[str, str]) -> str:
    updated = template
    for parameter_name, value in values.items():
        parameter = _resource_block(updated, parameter_name)
        lines = parameter.splitlines()
        default_index = next(
            index for index, line in enumerate(lines) if line.strip().startswith("Default:")
        )
        lines[default_index] = f'    Default: "{value}"'
        replacement = "\n".join(lines)
        updated = updated.replace(parameter, replacement, 1)
    return updated


def _assert_deploy_does_not_read_portal_secret(workflow: str) -> None:
    assert "aws secretsmanager get-secret-value" not in workflow
    assert "x-portal-secret" not in workflow


def test_dataops_execution_tables_have_retention_pitr_and_tags():
    template = TEMPLATE.read_text(encoding="utf-8")
    durable_tables = [
        "DataOpsTasksTable",
        "DataOpsCardsTable",
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
    assert "AttributeName: ttl" in sessions
    assert "Enabled: true" in sessions
    assert "PointInTimeRecoveryEnabled: true" not in sessions
    assert "Value: SessionState" in sessions
    assert "Value: ExecutionState" not in sessions


def test_dataops_execution_tables_match_backend_access_patterns():
    template = TEMPLATE.read_text(encoding="utf-8")
    tasks = _resource_block(template, "DataOpsTasksTable")
    files = _resource_block(template, "DataOpsFilesTable")

    assert "IndexName: GSI-Date" in tasks
    assert "IndexName: GSI-Card" in tasks
    assert "IndexName: GSI-Status" in tasks
    assert "AttributeName: date" in tasks
    assert "AttributeName: status" in tasks
    assert "AttributeName: cardId" in tasks

    assert "IndexName: GSI-Task" in files
    assert "AttributeName: taskId" in files


def test_backend_has_no_retired_runtime_template_transaction_permission():
    template = _load_template()
    policies = template["Resources"]["BackendFunction"]["Properties"]["Policies"]
    transaction_resources = [
        resource
        for policy in policies
        if "dynamodb:TransactWriteItems" in policy.get("Statement", {}).get("Action", [])
        for resource in policy["Statement"].get("Resource", [])
    ]

    assert {"GetAtt": "DataOpsTemplatesTable.Arn"} not in transaction_resources


def test_podcast_episodes_table_is_retained_private_state_with_one_date_index():
    template = TEMPLATE.read_text(encoding="utf-8")
    table = _resource_block(template, "DataOpsPodcastEpisodesTable")
    backend = _resource_block(template, "BackendFunction")

    assert "TableName: !Sub ${AWS::StackName}-podcast-episodes" in table
    assert "DeletionPolicy: Retain" in table
    assert "UpdateReplacePolicy: Retain" in table
    assert "SSEEnabled: true" in table
    assert "PointInTimeRecoveryEnabled: true" in table
    assert "Value: PrivateExecutionState" in table
    assert table.count("IndexName:") == 1
    assert "IndexName: GSI-Date" in table
    assert "AttributeName: dateKey" in table
    assert "DATAOPS_PODCAST_EPISODES_TABLE: !Ref DataOpsPodcastEpisodesTable" in backend
    assert "!GetAtt DataOpsPodcastEpisodesTable.Arn" in backend
    assert "!Sub ${DataOpsPodcastEpisodesTable.Arn}/index/*" in backend


def test_people_and_books_tables_are_retained_private_state_without_indexes():
    template = TEMPLATE.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")
    for table, suffix, env in [
        ("DataOpsPeopleTable", "people", "DATAOPS_PEOPLE_TABLE"),
        ("DataOpsBooksTable", "books", "DATAOPS_BOOKS_TABLE"),
    ]:
        block = _resource_block(template, table)
        assert f"TableName: !Sub ${{AWS::StackName}}-{suffix}" in block
        assert "DeletionPolicy: Retain" in block
        assert "UpdateReplacePolicy: Retain" in block
        assert "BillingMode: PAY_PER_REQUEST" in block
        assert "SSEEnabled: true" in block
        assert "PointInTimeRecoveryEnabled: true" in block
        assert "Value: PrivateExecutionState" in block
        assert "IndexName:" not in block, "people/books lists scan; no GSI"
        assert f"{env}: !Ref {table}" in backend
        assert f"!GetAtt {table}.Arn" in backend


def test_backend_schedules_are_explicit_identity_stable_resources_with_exact_behavior():
    template = _load_template()
    parameters = template["Parameters"]
    resources = template["Resources"]
    target_parameters = {
        "BackendTargetFunctionName",
    }
    for parameter_name in target_parameters:
        assert parameters[parameter_name] == {
            "Type": "String",
            "AllowedPattern": "^[a-zA-Z0-9-_]{1,64}$",
        }

    schedules = {
        "BackendFunctionDailyBackendCron": {
            "target": "BackendTargetFunctionName",
            "description": "Run DataOps recurring task and automatic template generation once per day.",
            "expression": "cron(0 8 * * ? *)",
            "state": "ENABLED",
            "target_id": "BackendFunctionDailyBackendCronLambdaTarget",
            "input": None,
        },
        "BackendFunctionDailyBackendExport": {
            "target": "BackendTargetFunctionName",
            "description": "Export DataOps execution data to the retained offsite archive bucket once per day.",
            "expression": "cron(30 8 * * ? *)",
            "state": "ENABLED",
            "target_id": "BackendFunctionDailyBackendExportLambdaTarget",
            "input": '{"source":"aws.events","detail-type":"Scheduled Event","detail":{"dataopsAction":"export"}}',
        },
        "BackendFunctionDailyDynamoBackup": {
            "target": "BackendTargetFunctionName",
            "description": "Dump every DataOps DynamoDB table to the retained archive bucket once per day.",
            "expression": "cron(0 9 * * ? *)",
            "state": "ENABLED",
            "target_id": "BackendFunctionDailyDynamoBackupLambdaTarget",
            "input": '{"source":"aws.events","detail-type":"Scheduled Event","detail":{"dataopsAction":"dynamo-backup"}}',
        },
    }
    for rule_id, expected in schedules.items():
        target = {
            "Arn": {"Sub": f"arn:${{AWS::Partition}}:lambda:${{AWS::Region}}:${{AWS::AccountId}}:function:${{{expected['target']}}}"},
            "Id": expected["target_id"],
        }
        if expected["input"] is not None:
            target["Input"] = expected["input"]
        assert resources[rule_id] == {
            "Type": "AWS::Events::Rule",
            "Properties": {
                "Description": expected["description"],
                "ScheduleExpression": expected["expression"],
                "State": expected["state"],
                "Targets": [target],
            },
        }
        assert resources[f"{rule_id}Permission"] == {
            "Type": "AWS::Lambda::Permission",
            "Properties": {
                "Action": "lambda:InvokeFunction",
                "FunctionName": {"Ref": expected["target"]},
                "Principal": "events.amazonaws.com",
                "SourceArn": {"GetAtt": f"{rule_id}.Arn"},
            },
        }

    assert set(schedules) == {
        name for name, resource in resources.items()
        if resource["Type"] == "AWS::Events::Rule"
        and name in schedules
    }
    for function_name in ("BackendFunction",):
        events = resources[function_name]["Properties"].get("Events", {})
        assert not any(event.get("Type") == "Schedule" for event in events.values())


def test_deploy_workflow_pins_toolchain_and_resolves_only_existing_schedule_targets():
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    assert (REPO_ROOT / ".node-version").read_text(encoding="utf-8") == "20.20.2\n"
    assert workflow.count('node-version-file: ".node-version"') == 2
    assert 'node-version: "20"' not in workflow
    resolver = workflow.split("      - name: Resolve stable scheduled Lambda targets", 1)[1].split(
        "      - name: Build SAM artifact", 1
    )[0]
    assert "Configure AWS credentials" in workflow.split("      - name: Resolve stable scheduled Lambda targets", 1)[0]
    assert "aws cloudformation describe-stacks" in resolver
    assert "aws lambda" not in resolver
    assert "StackId:StackId,Outputs:Outputs" in resolver
    for output, parameter, environment in (
        ("BackendFunctionName", "BackendTargetFunctionName", "BACKEND_TARGET_FUNCTION_NAME"),
    ):
        assert resolver.count(f"stack_output {output}") == 1
        assert workflow.count(f"ParameterKey={parameter},ParameterValue=${environment}") == 1
    assert "^[A-Za-z0-9-_]{1,64}$" in resolver
    assert workflow.count("sam deploy \\") == 1


def test_dataops_table_outputs_are_available_for_backend_env_wiring():
    template = TEMPLATE.read_text(encoding="utf-8")
    expected_outputs = [
        "DataOpsTasksTableName",
        "DataOpsCardsTableName",
        "DataOpsTemplatesTableName",
        "DataOpsUsersTableName",
        "DataOpsFilesTableName",
        "DataOpsArtifactsTableName",
        "DataOpsNotificationsTableName",
        "DataOpsSessionsTableName",
        "DataOpsExportArchiveBucketName",
        "DataOpsExportArchivePrefix",
        "DataOpsDynamoBackupPrefix",
        "BackendFunctionRoleArn",
    ]

    for output in expected_outputs:
        assert f"  {output}:" in template


def test_sponsor_finance_is_default_off_and_uses_exact_transaction_resources():
    template = TEMPLATE.read_text(encoding="utf-8")
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")

    assert '  SponsorFinanceEnabled:\n    Type: String\n    Default: "false"' in template
    assert "SPONSOR_FINANCE_ENABLED: !Ref SponsorFinanceEnabled" in backend
    assert "SPONSOR_FINANCE_ENABLED: ${{ vars.SPONSOR_FINANCE_ENABLED }}" in workflow
    assert ': "${SPONSOR_FINANCE_ENABLED:=false}"' in workflow
    assert "ParameterKey=SponsorFinanceEnabled,ParameterValue=$SPONSOR_FINANCE_ENABLED" in workflow

    transact_get = """Action:
              - dynamodb:TransactGetItems
            Resource:
              - !GetAtt DataOpsBookkeepingTable.Arn
              - !GetAtt DataOpsSponsorCrmTable.Arn"""
    finance_write = """Action:
              - dynamodb:TransactWriteItems
              - dynamodb:ConditionCheckItem
            Resource:
              - !GetAtt DataOpsSponsorCrmTable.Arn
              - !GetAtt DataOpsBookkeepingTable.Arn
              - !GetAtt DataOpsUsersTable.Arn"""
    assert transact_get in backend
    assert finance_write in backend

    for logical_id in ["DataOpsSponsorCrmTable", "DataOpsBookkeepingTable"]:
        block = _resource_block(template, logical_id)
        assert "DeletionPolicy: Retain" in block
        assert "UpdateReplacePolicy: Retain" in block
        assert "SSESpecification: { SSEEnabled: true }" in block
        assert "PointInTimeRecoveryEnabled: true" in block


def test_single_backend_lambda_is_wired_to_dataops_tables_and_has_public_url():
    template = TEMPLATE.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")
    portal_secret = _resource_block(template, "WorkEnginePortalSecret")

    assert "Type: AWS::SecretsManager::Secret" in portal_secret
    assert "GenerateSecretString" in portal_secret
    assert "DeletionPolicy: Retain" in portal_secret
    assert "UpdateReplacePolicy: Retain" in portal_secret
    assert "Type: AWS::Serverless::Function" in backend
    assert "BuildMethod: makefile" in backend
    assert "CodeUri: sam-build" in backend
    assert "Runtime: nodejs24.x" in backend
    assert "Handler: dist/handler.handler" in backend
    assert "FunctionUrlConfig" in backend
    assert "WORK_ENGINE_AUTH_MODE: portal" in backend
    assert "DATAOPS_DOCS_DOMAIN: " in backend
    # GitHub access to the knowledge repo lives in the knowledge worker only.
    assert "GITHUB_OWNER" not in backend
    assert "GITHUB_OWNER: !Ref GitHubOwner" in _resource_block(template, "KnowledgeWorkerFunction")
    assert "AUTH_BASE_URL: !Ref AuthBaseUrl" in backend
    assert "AUTH_USER_POOL_ID:" not in backend
    assert "AUTH_ISSUER: !Ref AuthIssuer" in backend
    assert "AUTH_JWKS_URL: !Ref AuthJwksUrl" in backend
    assert "AUTH_CLIENT_ID: !Ref AuthClientId" in backend
    assert "AUTH_CALLBACK_URL: !Ref AuthCallbackUrl" in backend
    assert "AUTH_LOGOUT_URL: !Ref AuthLogoutUrl" in backend
    assert "AUTH_SESSION_LIFETIME_SECONDS: !Ref AuthSessionLifetimeSeconds" in backend
    assert "BASIC_AUTH_USERNAME" not in backend
    assert "BASIC_AUTH_PASSWORD_SECRET_NAME" not in backend
    assert "DATAOPS_TABLE_PREFIX: !Ref AWS::StackName" in backend
    assert "DATAOPS_TASKS_TABLE:" not in backend
    assert "DATAOPS_CARDS_TABLE:" not in backend
    assert "DATAOPS_TEMPLATES_TABLE:" not in backend
    assert "DATAOPS_USERS_TABLE:" not in backend
    assert "DATAOPS_FILES_TABLE:" not in backend
    assert "DATAOPS_ARTIFACTS_TABLE:" not in backend
    assert "DATAOPS_NOTIFICATIONS_TABLE:" not in backend
    assert "DATAOPS_SESSIONS_TABLE:" not in backend
    assert "DATAOPS_EXPORT_ARCHIVE_BUCKET: !Ref DataOpsExportArchiveBucket" in backend
    assert "DATAOPS_EXPORT_ARCHIVE_PREFIX: !Ref ExportArchivePrefix" in backend
    assert "DATAOPS_DYNAMO_BACKUP_PREFIX: !Ref DynamoBackupPrefix" in backend
    assert "dynamodb:GetItem" in backend
    assert "dynamodb:PutItem" in backend
    assert "dynamodb:Query" in backend
    assert "dynamodb:Scan" in backend
    assert "dynamodb:UpdateItem" in backend
    assert "dynamodb:DeleteItem" in backend
    assert backend.count("dynamodb:BatchGetItem") == 1
    assert """Action:
              - dynamodb:BatchGetItem
            Resource:
              - !GetAtt DataOpsBookkeepingTable.Arn
        - Statement:""" in backend
    assert "dynamodb:BatchWriteItem" not in backend
    assert "dynamodb:DescribeTable" not in backend
    assert "${DataOpsTasksTable.Arn}/index/*" in backend
    assert "${DataOpsFilesTable.Arn}/index/*" in backend
    assert "secretsmanager:GetSecretValue" in backend
    assert "s3:PutObject" in backend
    assert "${DataOpsExportArchiveBucket.Arn}/${ExportArchivePrefix}/*" in backend
    assert "${DataOpsExportArchiveBucket.Arn}/${DynamoBackupPrefix}/*" in backend
    backend_export = _resource_block(template, "BackendFunctionDailyBackendExport")
    assert '"dataopsAction":"export"' in backend_export
    backend_dump = _resource_block(template, "BackendFunctionDailyDynamoBackup")
    assert '"dataopsAction":"dynamo-backup"' in backend_dump
    assert "WORK_ENGINE_PORTAL_SECRET_NAME: !Sub ${AWS::StackName}/work-engine/portal-secret" in backend
    assert "EMAIL_DOCUMENT_INTAKE_SECRET_NAME: !Ref EmailDocumentIntakeSecretArn" in backend
    assert "!Ref EmailDocumentIntakeSecretArn" in backend
    # No cross-function invocation — the old two-Lambda proxy is gone.
    assert "lambda:InvokeFunction" not in backend


def test_email_document_intake_uses_a_precreated_rotatable_secret():
    template = TEMPLATE.read_text(encoding="utf-8")
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")
    assert "EmailDocumentIntakeSecretArn:" in template
    assert "ARN of the pre-created email document intake secret" in template
    assert "EmailDocumentIntakeSecretName:" in template
    assert "EMAIL_DOCUMENT_INTAKE_SECRET_NAME: !Ref EmailDocumentIntakeSecretArn" in backend
    assert "EMAIL_DOCUMENT_RATE_LIMIT: !Ref EmailDocumentRateLimit" in backend
    assert "EMAIL_DOCUMENT_INTAKE_SECRET_ARN: ${{ secrets.EMAIL_DOCUMENT_INTAKE_SECRET_ARN }}" in workflow
    assert "ParameterKey=EmailDocumentIntakeSecretArn,ParameterValue=$EMAIL_DOCUMENT_INTAKE_SECRET_ARN" in workflow
    assert 'if [ -z "$EMAIL_DOCUMENT_INTAKE_SECRET_ARN" ]' in workflow
    intake_secret_parameter = template.split("  EmailDocumentIntakeSecretArn:", 1)[1].split("\n  EmailDocumentSourcePrefix:", 1)[0]
    assert "Default:" not in intake_secret_parameter
    assert "Default: arn:" not in template


def test_backend_reads_only_the_exact_calendar_broker_secret():
    backend = _load_template()["Resources"]["BackendFunction"]["Properties"]["Policies"]
    grants = [
        statement["Statement"]
        for statement in backend
        if isinstance(statement, dict)
        and isinstance(statement.get("Statement"), dict)
        and "personal-scheduler" in str(statement["Statement"].get("Resource"))
    ]
    assert grants == [{
        "Effect": "Allow",
        "Action": "secretsmanager:GetSecretValue",
        "Resource": {"Sub": "arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:personal-scheduler/dapier-api-token-??????"},
    }]


def test_email_document_storage_is_private_retained_and_prefix_scoped():
    template = TEMPLATE.read_text(encoding="utf-8")
    bucket = _resource_block(template, "EmailDocumentsBucket")
    policy = _resource_block(template, "EmailDocumentsBucketPolicy")
    key = _resource_block(template, "EmailDocumentsKey")
    backend = _resource_block(template, "BackendFunction")
    audit_table = _resource_block(template, "DataOpsAuditEventsTable")
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")

    assert "DeletionPolicy: Retain" in bucket
    assert "UpdateReplacePolicy: Retain" in bucket
    assert "SSEAlgorithm: aws:kms" in bucket
    assert "KMSMasterKeyID: !GetAtt EmailDocumentsKey.Arn" in bucket
    assert "BlockPublicAcls: true" in bucket
    assert "IgnorePublicAcls: true" in bucket
    assert "BlockPublicPolicy: true" in bucket
    assert "RestrictPublicBuckets: true" in bucket
    assert "VersioningConfiguration: { Status: Enabled }" in bucket
    assert "OwnershipControls" in bucket
    assert "DeletionPolicy: Retain" in key
    assert "UpdateReplacePolicy: Retain" in key
    assert "EnableKeyRotation: true" in key
    assert '"aws:SecureTransport": false' in policy
    assert "${EmailDocumentsBucket.Arn}/${EmailDocumentSourcePrefix}*" in backend
    assert "${EmailDocumentsBucket.Arn}/${EmailDocumentDestinationPrefix}*" in backend
    assert "EMAIL_DOCUMENTS_BUCKET: !Ref EmailDocumentsBucket" in backend
    assert "EMAIL_DOCUMENTS_KMS_KEY: !Ref EmailDocumentsKey" in backend
    assert "EMAIL_DOCUMENT_SOURCE_PREFIX: !Ref EmailDocumentSourcePrefix" in backend
    assert "EMAIL_DOCUMENT_DESTINATION_PREFIX: !Ref EmailDocumentDestinationPrefix" in backend
    assert "EMAIL_DOCUMENT_RECIPIENT_ROUTES: !Ref EmailDocumentRecipientRoutes" in backend
    assert "TimeToLiveSpecification:" in audit_table
    assert "AttributeName: expiresAt" in audit_table
    assert "EMAIL_DOCUMENT_EXTERNAL_SOURCE_BUCKET: !Ref EmailDocumentExternalSourceBucketName" in backend
    assert "EMAIL_DOCUMENT_EXTERNAL_SOURCE_PREFIX: !Ref EmailDocumentExternalSourcePrefix" in backend
    assert "${EmailDocumentExternalSourceBucketName}/${EmailDocumentExternalSourcePrefix}*" in backend
    assert "Resource: !Ref EmailDocumentExternalSourceKmsKeyArn" in backend
    assert "HasEmailDocumentExternalSource" in template
    assert "HasEmailDocumentExternalSourceKms" in template
    assert "ParameterKey=EmailDocumentExternalSourceBucketName,ParameterValue=$EMAIL_DOCUMENT_EXTERNAL_SOURCE_BUCKET" in workflow
    assert "ParameterKey=EmailDocumentExternalSourcePrefix,ParameterValue=$EMAIL_DOCUMENT_EXTERNAL_SOURCE_PREFIX" in workflow
    assert "ParameterKey=EmailDocumentExternalSourceKmsKeyArn,ParameterValue=$EMAIL_DOCUMENT_EXTERNAL_SOURCE_KMS_KEY_ARN" in workflow
    assert "s3:*" not in backend


def test_mailing_export_capability_is_removed_from_template_and_deploy():
    template = TEMPLATE.read_text(encoding="utf-8")
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")

    for name in (
        "MailingExportsBucket",
        "MailingExportsBucketPolicy",
        "MailingExportsConfig",
        "DapierCredentialsTableName",
        "DapierCredentialsTableArn",
        "BackendFunctionDailyMailingExport",
        "BackendFunctionDailyMailingExportPermission",
    ):
        assert f"{name}:" not in template
    assert "DATAOPS_MAILING_EXPORTS_CONFIG" not in backend
    assert "DATAOPS_MAILING_EXPORTS_BUCKET" not in backend
    assert "DATAOPS_DAPIER_CREDENTIALS_TABLE" not in backend
    assert "dynamodb:LeadingKeys: [mailchimp]" not in backend
    assert '"dataopsAction":"mailing-export"' not in template
    assert "MailchimpSecretArn" not in template
    assert "HasMailchimpSecret" not in template
    assert "DAPIER_CREDENTIALS_TABLE_NAME" not in workflow
    assert "DAPIER_CREDENTIALS_TABLE_ARN" not in workflow
    assert "MAILING_EXPORTS_CONFIG" not in workflow
    assert "ParameterKey=DapierCredentialsTableName" not in workflow
    assert "ParameterKey=DapierCredentialsTableArn" not in workflow
    assert "ParameterKey=MailingExportsConfig" not in workflow


def test_no_old_two_function_resources_remain():
    template = TEMPLATE.read_text(encoding="utf-8")
    assert "DocsFullAppFunction:" not in template
    assert "WorkEngineFunction:" not in template


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
    assert "Prefix: !Sub ${DynamoBackupPrefix}/" in bucket
    assert "ExpirationInDays: !Ref DynamoBackupRetentionDays" in bucket
    assert "Value: ExecutionExportArchive" in bucket
    assert "Value: DataOpsV1ExecutionExports" in bucket


def test_raw_dynamo_backup_dumps_every_table_to_the_archive_bucket():
    template = TEMPLATE.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")
    backup = _resource_block(template, "BackendFunctionDailyDynamoBackup")
    bucket = _resource_block(template, "DataOpsExportArchiveBucket")

    assert "DATAOPS_DYNAMO_BACKUP_PREFIX: !Ref DynamoBackupPrefix" in backend
    assert "${DataOpsExportArchiveBucket.Arn}/${DynamoBackupPrefix}/*" in backend
    assert '"dataopsAction":"dynamo-backup"' in backup
    assert "ScheduleExpression: cron(0 9 * * ? *)" in backup
    assert "Prefix: !Sub ${DynamoBackupPrefix}/" in bucket
    assert "ExpirationInDays: !Ref DynamoBackupRetentionDays" in bucket
    assert "  DataOpsDynamoBackupPrefix:" in template
    assert '  DynamoBackupPrefix:\n    Type: String\n    Default: dynamo-backups' in template


def test_deployed_environment_is_exactly_sandbox_and_has_exactly_one_consumer():
    template = _load_template()
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")

    _assert_sandbox_provenance_contract(template, workflow)


def test_sandbox_environment_contract_rejects_escape_hatches():
    template = _load_template()
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    override_text = "ParameterKey=DataOpsEnvironment,ParameterValue=sandbox"
    override_line = next(
        line for line in workflow.splitlines(keepends=True) if override_text in line
    )

    for alternate in ("prod", "production", "staging"):
        candidate = copy.deepcopy(template)
        candidate["Parameters"]["DataOpsEnvironment"]["Default"] = alternate
        with pytest.raises(AssertionError):
            _assert_sandbox_provenance_contract(candidate, workflow)

    workflow_mutations = (
        workflow.replace(override_line, "", 1),
        workflow.replace(override_text, "ParameterKey=DataOpsEnvironment,ParameterValue=prod", 1),
        workflow.replace(override_line, override_line + override_line, 1),
        workflow.replace(
            "  workflow_dispatch:\n",
            "  workflow_dispatch:\n    inputs:\n      environment: {}\n",
            1,
        ),
    )
    for candidate in workflow_mutations:
        with pytest.raises(AssertionError):
            _assert_sandbox_provenance_contract(template, candidate)


def test_deploy_workflow_projects_private_templates_through_the_deployed_lambda():
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    deploy = workflow.split("\n  deploy:\n", 1)[1]

    seed = "Project authored workflow templates"
    assert seed in workflow
    assert "--logical-resource-id BackendFunction" in workflow
    assert deploy.count("aws lambda invoke") == 1
    assert '"source":"dataops.deploy","detail-type":"Runtime Seed"' in deploy
    assert '"dataopsAction":"sync-runtime-seeds"' in deploy
    assert '"dataopsAction":"sync-templates"' not in deploy
    assert "scripts/seed-users.ts" not in deploy
    assert "scripts/seed-recurring.ts" not in deploy
    assert "scripts/seed-templates.ts" not in workflow
    assert 'seed_response="$RUNNER_TEMP/dataops-runtime-seeds.json"' in deploy
    assert "FunctionError" in deploy
    assert 'if [ "$seed_error" != "None" ]' in deploy
    # The deploy seed creates no people and no schedules; authored templates come from the
    # private knowledge branch, so only their count arithmetic is pinned.
    assert "$body.users" not in deploy
    for exact_total in (
        '($body | keys == ["templates"])',
        "($body.templates.total | nonnegative_integer and . > 0)",
        "$body.templates.created + $body.templates.updated + $body.templates.unchanged == $body.templates.total",
    ):
        assert exact_total in deploy
    # Recurring schedules are user data managed on /recurring; a deploy never
    # seeds, re-enables or rewrites them.
    assert "recurring" not in deploy.split(seed, 1)[1].split("- name:", 1)[0]
    assert workflow.index("Deploy DataOps v1 stack") < workflow.index(seed)
    assert workflow.index(seed) < workflow.index("Smoke test deployed single-origin backend")
    assert "npm exec" not in deploy
    assert "npx" not in deploy
    assert "npm ci" not in deploy
    _assert_deploy_does_not_read_portal_secret(workflow)
    assert "actions/checkout" in workflow
    assert "repository: DataTalksClub/dataops-knowledge" not in workflow
    assert "Smoke test deployed single-origin backend" in workflow
    assert "backend_url" in workflow


def test_browser_e2e_is_visible_but_cannot_block_or_queue_deployment():
    deploy_workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    e2e_workflow = E2E_WORKFLOW.read_text(encoding="utf-8")
    checks = deploy_workflow.split("\n  checks:\n", 1)[1].split("\n  deploy:\n", 1)[0]

    assert "Playwright" not in checks
    assert "test:e2e" not in checks
    assert "playwright-report" not in checks
    assert "needs: checks" in deploy_workflow
    for required_step in (
        "Run frontend unit coverage",
        "Run backend tests",
        "Typecheck backend",
        "Build backend",
        "Validate SAM template",
    ):
        assert required_step in checks

    assert "backend/**" in e2e_workflow
    assert "frontend/**" in e2e_workflow
    assert "workflow_dispatch:" in e2e_workflow
    assert "group: dataops-backend-e2e-${{ github.ref }}" in e2e_workflow
    # main must never cancel an in-progress run; only pull requests do.
    assert "cancel-in-progress: ${{ github.event_name == 'pull_request' }}" in e2e_workflow
    assert "cancel-in-progress: true" not in e2e_workflow
    assert "Tested commit:" in e2e_workflow
    assert "timeout-minutes: 45" in e2e_workflow
    assert "playwright install --with-deps chromium" in e2e_workflow
    assert "npm --prefix backend run test:e2e" in e2e_workflow
    assert "if: failure()" in e2e_workflow
    assert "backend/playwright-report/" in e2e_workflow
    assert "backend/test-results/" in e2e_workflow
    assert "retention-days: 7" in e2e_workflow
    assert "id-token: write" not in e2e_workflow
    assert "configure-aws-credentials" not in e2e_workflow


def test_deploy_workflow_passes_shared_auth_contract_through_github_oidc_only():
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    deploy_job = workflow.split("\n  deploy:\n", 1)[1]
    expected = {
        "AuthBaseUrl": "AUTH_BASE_URL",
        "AuthUserPoolId": "AUTH_USER_POOL_ID",
        "AuthIssuer": "AUTH_ISSUER",
        "AuthJwksUrl": "AUTH_JWKS_URL",
        "AuthClientId": "AUTH_CLIENT_ID",
        "AuthCallbackUrl": "AUTH_CALLBACK_URL",
        "AuthLogoutUrl": "AUTH_LOGOUT_URL",
        "AuthSessionLifetimeSeconds": "AUTH_SESSION_LIFETIME_SECONDS",
    }

    assert "id-token: write" in workflow
    assert "aws-actions/configure-aws-credentials@" in workflow
    assert "role-to-assume: ${{ env.AWS_ROLE_ARN }}" in workflow
    assert "sam deploy" in workflow
    oidc = deploy_job.index("aws-actions/configure-aws-credentials@")
    for operation in (
        'echo "AUTH_CLIENT_ID=$(auth_output DataOpsClientId)"',
        "make sam-build",
        "sam deploy",
        "sam package",
        "aws s3api put-object",
        "aws cloudformation create-change-set",
        "aws cloudformation execute-change-set",
        "Project authored workflow templates",
    ):
        if operation in deploy_job:
            assert oidc < deploy_job.index(operation)
    for parameter, variable in expected.items():
        assert f"ParameterKey={parameter},ParameterValue=${variable}" in workflow
    assert "Resolve shared auth client" in deploy_job
    assert "--stack-name dtcdev-shared-auth" in deploy_job
    for auth_output_name in ("DataOpsClientId", "IssuerUrl", "JwksUrl"):
        assert f"auth_output {auth_output_name}" in deploy_job
    assert "GoogleClientSecret" not in workflow
    assert "CognitoClientSecret" not in workflow


def test_deploy_workflow_keeps_production_auth_out_of_checks_and_scoped_to_deploy():
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    before_jobs, jobs = workflow.split("\njobs:\n", 1)
    checks, deploy = jobs.split("\n  deploy:\n", 1)
    static_auth = {
        "AUTH_BASE_URL": "https://auth.dtcdev.click",
        "AUTH_USER_POOL_ID": "us-east-1_H7nJu52Bs",
        "AUTH_CALLBACK_URL": "https://ops.dtcdev.click/auth/callback",
        "AUTH_LOGOUT_URL": "https://ops.dtcdev.click/",
        "AUTH_SESSION_LIFETIME_SECONDS": "2592000",
    }
    resolved_auth = ("AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_CLIENT_ID")

    for variable, value in static_auth.items():
        # Workflow-level env reaches every check and every Playwright child
        # process. Production relying-party config belongs only to deployment.
        assert f"{variable}:" not in before_jobs
        assert f"{variable}:" not in checks
        assert f"      {variable}: {value}" in deploy
        assert f"ParameterValue=${variable}" in deploy

    # Cognito rotates these identifiers when the app client is recreated.
    # They must be read from the shared-auth stack after OIDC and never be
    # pinned as literals that can silently expire.
    for variable in resolved_auth:
        assert f"{variable}:" not in before_jobs
        assert f"{variable}:" not in checks
        assert f'echo "{variable}=$(auth_output ' in deploy
        assert f"ParameterValue=${variable}" in deploy
    assert "1kjv61esdjs3003s8u42sgr3hf" not in workflow


def test_sponsor_communication_table_indexes_ttl_and_default_off_contract():
    template = TEMPLATE.read_text(encoding="utf-8")
    table = _resource_block(template, "DataOpsSponsorCrmTable")
    parameter = template.split("  SponsorCommunicationSendEnabled:", 1)[1].split(
        "\n  SponsorCommunicationTemplateSecretArn:", 1
    )[0]
    assert "DeletionPolicy: Retain" in table
    assert "UpdateReplacePolicy: Retain" in table
    assert "SSESpecification: { SSEEnabled: true }" in table
    assert "PointInTimeRecoveryEnabled: true" in table
    assert "TimeToLiveSpecification:\n        Enabled: true\n        AttributeName: expiresAt" in table
    # Nothing consumes the sponsor CRM stream since the send worker is gone.
    assert "StreamSpecification" not in table
    for index in (
        "GSI-Communication",
        "GSI-SponsorSendDue",
        "GSI-SponsorSendLookup",
        "GSI-SponsorBookingCommunication",
    ):
        assert f"IndexName: {index}" in table
    assert 'Default: "false"' in parameter
    assert "SponsorSendRequiresPrivateConfiguration" in template


def test_sponsor_communication_backend_has_no_send_capability():
    template = TEMPLATE.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")
    archive = _resource_block(template, "SponsorPrivateArchiveFunction")

    assert "SPONSOR_COMMUNICATION_TEMPLATE_SECRET_ARN: !Ref SponsorCommunicationTemplateSecretArn" in backend
    assert "SPONSOR_COMMUNICATION_HMAC_SECRET_ARN: !Ref SponsorCommunicationHmacSecretArn" in backend
    assert "ses:" not in backend

    assert "Handler: dist/sponsor-private-archive-handler.handler" in archive
    assert "dynamodb:Scan" in archive
    assert "dynamodb:PutItem" not in archive
    assert "secretsmanager:" not in archive
    assert "ses:" not in archive
    assert "SponsorCommunicationPrivateArchiveBucket" in archive
    assert "DataOpsExportArchiveBucket" not in archive


def test_sponsor_send_infrastructure_is_gone():
    template = TEMPLATE.read_text(encoding="utf-8")
    for gone in (
        "SponsorSendWorkerFunction",
        "SponsorSesEventFunction",
        "SponsorSesEventRule",
        "SponsorSesEventInvokePermission",
        "SponsorSesConfigurationSet",
        "SponsorSesEventDestination",
        "SponsorCommunicationFailureQueue",
        "SponsorSesIdentityArn",
        "SponsorSesFromAddress",
        "SponsorSesConfigurationSetName",
        "SponsorSendWorkerFunctionName",
        "SponsorSesEventFunctionName",
        "SponsorCommunicationFailureQueueArn",
        "sponsor-send-worker-handler",
        "sponsor-ses-event-handler",
        "ses:SendEmail",
        "ses:FromAddress",
        "ses:ConfigurationSet",
        "sponsor-send-recovery",
        "QueuedSponsorSend",
    ):
        assert gone not in template, gone
    assert "SponsorCommunicationSendingEnabled" not in template


def test_sponsor_private_archive_is_isolated_retained_and_kms_encrypted():
    template = TEMPLATE.read_text(encoding="utf-8")
    bucket = _resource_block(template, "SponsorCommunicationPrivateArchiveBucket")
    key = _resource_block(template, "SponsorCommunicationPrivateArchiveKey")
    assert "DeletionPolicy: Retain" in bucket
    assert "UpdateReplacePolicy: Retain" in bucket
    assert "SSEAlgorithm: aws:kms" in bucket
    assert "SponsorCommunicationPrivateArchiveKey.Arn" in bucket
    assert "BlockPublicAcls: true" in bucket
    assert "RestrictPublicBuckets: true" in bucket
    assert "VersioningConfiguration: { Status: Enabled }" in bucket
    assert "DeletionPolicy: Retain" in key
    assert "EnableKeyRotation: true" in key
