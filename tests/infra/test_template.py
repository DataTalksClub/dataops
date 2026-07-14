from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = REPO_ROOT / "infra" / "template.full.yaml"
DEPLOY_ROLE_TEMPLATE = REPO_ROOT / "infra" / "template.github-actions-dataops.yaml"
LEGACY_DEPLOY_ROLE_TEMPLATE = REPO_ROOT / "infra" / "template.github-actions.yaml"
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
    assert "IndexName: GSI-Bundle" in tasks
    assert "IndexName: GSI-Status" in tasks
    assert "AttributeName: date" in tasks
    assert "AttributeName: status" in tasks
    assert "AttributeName: bundleId" in tasks

    assert "IndexName: GSI-Task" in files
    assert "AttributeName: taskId" in files


def test_dataops_table_outputs_are_available_for_backend_env_wiring():
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
        "BackendFunctionRoleArn",
    ]

    for output in expected_outputs:
        assert f"  {output}:" in template


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
    assert "CodeUri: .." in backend
    assert "Runtime: nodejs24.x" in backend
    assert "Handler: dist/handler.handler" in backend
    assert "FunctionUrlConfig" in backend
    assert "WORK_ENGINE_AUTH_MODE: portal" in backend
    assert "DATAOPS_DOCS_DOMAIN: " in backend
    assert "GITHUB_OWNER: !Ref GitHubOwner" in backend
    assert "AUTH_BASE_URL: !Ref AuthBaseUrl" in backend
    assert "AUTH_USER_POOL_ID: !Ref AuthUserPoolId" in backend
    assert "AUTH_ISSUER: !Ref AuthIssuer" in backend
    assert "AUTH_JWKS_URL: !Ref AuthJwksUrl" in backend
    assert "AUTH_CLIENT_ID: !Ref AuthClientId" in backend
    assert "AUTH_CALLBACK_URL: !Ref AuthCallbackUrl" in backend
    assert "AUTH_LOGOUT_URL: !Ref AuthLogoutUrl" in backend
    assert "AUTH_SESSION_LIFETIME_SECONDS: !Ref AuthSessionLifetimeSeconds" in backend
    assert "BASIC_AUTH_USERNAME" not in backend
    assert "BASIC_AUTH_PASSWORD_SECRET_NAME" not in backend
    assert "DATAOPS_TASKS_TABLE: !Ref DataOpsTasksTable" in backend
    assert "DATAOPS_BUNDLES_TABLE: !Ref DataOpsBundlesTable" in backend
    assert "DATAOPS_TEMPLATES_TABLE: !Ref DataOpsTemplatesTable" in backend
    assert "DATAOPS_USERS_TABLE: !Ref DataOpsUsersTable" in backend
    assert "DATAOPS_FILES_TABLE: !Ref DataOpsFilesTable" in backend
    assert "DATAOPS_ARTIFACTS_TABLE: !Ref DataOpsArtifactsTable" in backend
    assert "DATAOPS_NOTIFICATIONS_TABLE: !Ref DataOpsNotificationsTable" in backend
    assert "DATAOPS_SESSIONS_TABLE: !Ref DataOpsSessionsTable" in backend
    assert "DATAOPS_EXPORT_ARCHIVE_BUCKET: !Ref DataOpsExportArchiveBucket" in backend
    assert "DATAOPS_EXPORT_ARCHIVE_PREFIX: !Ref ExportArchivePrefix" in backend
    assert "dynamodb:GetItem" in backend
    assert "dynamodb:PutItem" in backend
    assert "dynamodb:Query" in backend
    assert "dynamodb:Scan" in backend
    assert "dynamodb:UpdateItem" in backend
    assert "dynamodb:DeleteItem" in backend
    assert "dynamodb:BatchGetItem" not in backend
    assert "dynamodb:BatchWriteItem" not in backend
    assert "dynamodb:DescribeTable" not in backend
    assert "${DataOpsTasksTable.Arn}/index/*" in backend
    assert "${DataOpsFilesTable.Arn}/index/*" in backend
    assert "secretsmanager:GetSecretValue" in backend
    assert "s3:PutObject" in backend
    assert "${DataOpsExportArchiveBucket.Arn}/${ExportArchivePrefix}/*" in backend
    assert "DailyBackendExport" in backend
    assert '"dataopsAction":"export"' in backend
    assert "WORK_ENGINE_PORTAL_SECRET_NAME: !Ref WorkEnginePortalSecret" in backend
    assert "EMAIL_DOCUMENT_INTAKE_SECRET_NAME: !Ref EmailDocumentIntakeSecretArn" in backend
    assert "!Ref EmailDocumentIntakeSecretArn" in backend
    # No cross-function invocation — the old two-Lambda proxy is gone.
    assert "lambda:InvokeFunction" not in template


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
    assert "EMAIL_DOCUMENTS_KMS_KEY: !GetAtt EmailDocumentsKey.Arn" in backend
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


def test_mailing_export_storage_schedule_and_secret_are_private_and_least_privilege():
    template = TEMPLATE.read_text(encoding="utf-8")
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    bucket = _resource_block(template, "MailingExportsBucket")
    policy = _resource_block(template, "MailingExportsBucketPolicy")
    backend = _resource_block(template, "BackendFunction")

    assert "DeletionPolicy: Retain" in bucket
    assert "UpdateReplacePolicy: Retain" in bucket
    assert "SSEAlgorithm: AES256" in bucket
    assert "BlockPublicAcls: true" in bucket
    assert "IgnorePublicAcls: true" in bucket
    assert "BlockPublicPolicy: true" in bucket
    assert "RestrictPublicBuckets: true" in bucket
    assert "VersioningConfiguration: { Status: Enabled }" in bucket
    assert "AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }" in bucket
    assert "NoncurrentVersionExpiration: { NoncurrentDays: 365 }" in bucket
    assert '"aws:SecureTransport": false' in policy
    assert "DATAOPS_MAILING_EXPORTS_CONFIG: !Ref MailingExportsConfig" in backend
    assert "DATAOPS_MAILING_EXPORTS_BUCKET: !Ref MailingExportsBucket" in backend
    assert "Resource: !Sub ${MailingExportsBucket.Arn}/*" in backend
    assert "Action: [s3:GetObject, s3:PutObject]" in backend
    assert "!If [HasMailchimpSecret, !Ref MailchimpSecretArn, !Ref AWS::NoValue]" in backend
    assert "DailyMailingExport" in backend
    assert '"dataopsAction":"mailing-export"' in backend
    assert "MAILCHIMP_SECRET_ARN: ${{ secrets.MAILCHIMP_SECRET_ARN }}" in workflow
    assert "MAILING_EXPORTS_CONFIG: ${{ vars.MAILING_EXPORTS_CONFIG }}" in workflow
    assert "ParameterKey=MailchimpSecretArn,ParameterValue=$MAILCHIMP_SECRET_ARN" in workflow
    assert "ParameterKey=MailingExportsConfig,ParameterValue=$MAILING_EXPORTS_CONFIG" in workflow


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
    assert "Smoke test deployed single-origin backend" in workflow
    assert "backend_url" in workflow


def test_deploy_workflow_passes_shared_auth_contract_through_github_oidc_only():
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
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
    assert "--config-env full-sandbox" in workflow
    for parameter, variable in expected.items():
        assert f"ParameterKey={parameter},ParameterValue=${variable}" in workflow
    assert "dtcdev-shared-auth" not in workflow
    assert "GoogleClientSecret" not in workflow
    assert "CognitoClientSecret" not in workflow


def test_github_deploy_role_can_manage_backend_lambda():
    template = DEPLOY_ROLE_TEMPLATE.read_text(encoding="utf-8")

    assert "lambda:ListTags" in template
    assert "iam:ListRoleTags" in template
    assert "function:${FullDocsStackName}-BackendFunction-*" in template
    assert "role/${FullDocsStackName}-BackendFunctionRole-*" in template
    assert "/aws/lambda/${FullDocsStackName}-BackendFunction-*" in template
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
