from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = REPO_ROOT / "infra" / "template.full.yaml"
DEPLOY_ROLE_TEMPLATE = REPO_ROOT / "infra" / "template.github-actions-dataops.yaml"
LEGACY_DEPLOY_ROLE_TEMPLATE = REPO_ROOT / "infra" / "template.github-actions.yaml"
DEPLOY_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-dataops-v1.yml"
SPONSOR_GSI_MIGRATOR = REPO_ROOT / "scripts" / "deploy" / "sponsor-crm-gsi-migrator.mjs"

ALARM_CONTRACT = {
    "ConversationalExecutionOutcomeUnknownAlarm": ("execution-outcome-unknown", "ExecutionOutcomeUnknown", 1, 300, 1, "Sum"),
    "ConversationalExecutionFailureQueueVisibleAlarm": ("execution-failure-queue-visible", "ApproximateNumberOfMessagesVisible", 1, 300, 1, "Maximum"),
    "ConversationalRecoveryOldestDueAgeAlarm": ("recovery-oldest-due-age", "RecoveryOldestDueAgeSeconds", 300, 300, 2, "Maximum"),
    "ConversationalExecutionWorkerHeartbeatStaleAlarm": ("execution-worker-heartbeat-stale", "ExecutionWorkerHeartbeatAgeSeconds", 300, 300, 2, "Maximum"),
    "ConversationalRecoveryHeartbeatStaleAlarm": ("recovery-heartbeat-stale", "RecoveryHeartbeatAgeSeconds", 300, 300, 2, "Maximum"),
    "ConversationalResultDeliveryOutcomeUnknownAlarm": ("result-delivery-outcome-unknown", "ResultDeliveryOutcomeUnknown", 1, 300, 1, "Sum"),
    "ConversationalResultDeliveryOldestPendingAlarm": ("result-delivery-oldest-pending", "ResultDeliveryOldestPendingAgeSeconds", 300, 300, 1, "Maximum"),
    "ConversationalResultDispatcherHeartbeatStaleAlarm": ("result-dispatcher-heartbeat-stale", "ResultDispatcherHeartbeatAgeSeconds", 300, 300, 2, "Maximum"),
    "ConversationalResultDeliveryFailedAlarm": ("result-delivery-failed", "ResultDeliveryFailed", 1, 300, 1, "Sum"),
    "ConversationalTelegramWebhookFailuresAlarm": ("telegram-webhook-failures", "TelegramWebhookFailures", 3, 300, 1, "Sum"),
    "ConversationalModelFailuresAlarm": ("model-failures", "ModelFailures", 3, 900, 1, "Sum"),
    "ConversationalVoiceFailuresAlarm": ("voice-failures", "VoiceFailures", 3, 900, 1, "Sum"),
    "ConversationalPhotoFailuresAlarm": ("photo-failures", "PhotoFailures", 3, 900, 1, "Sum"),
    "ConversationalTypefullyDraftFailedAlarm": ("typefully-draft-failed", "TypefullyDraftFailed", 1, 900, 1, "Sum"),
    "ConversationalMediaCleanupFailedAlarm": ("media-cleanup-failed", "MediaCleanupFailed", 1, 300, 1, "Sum"),
    "ConversationalRetentionCleanupFailedAlarm": ("retention-cleanup-failed", "RetentionCleanupFailed", 1, 900, 1, "Sum"),
    "ConversationalExecutionFailedSafeAlarm": ("execution-failed-safe", "ExecutionFailedSafe", 3, 900, 1, "Sum"),
}
HEARTBEAT_ALARMS = {
    "ConversationalExecutionWorkerHeartbeatStaleAlarm",
    "ConversationalRecoveryHeartbeatStaleAlarm",
    "ConversationalResultDispatcherHeartbeatStaleAlarm",
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
    return yaml.load(path.read_text(encoding="utf-8"), Loader=_CloudFormationLoader)


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


def _executable_command(executable: str | Path) -> list[str]:
    executable_path = Path(executable)
    with executable_path.open("rb") as executable_file:
        first_line = executable_file.readline(4096)

    if not first_line.startswith(b"#!"):
        return [str(executable_path)]

    try:
        shebang = first_line[2:].decode("utf-8").strip()
    except UnicodeDecodeError as error:
        raise AssertionError(f"{executable_path} has an invalid UTF-8 shebang") from error

    shebang_parts = shebang.split(maxsplit=1)
    interpreter = shebang_parts[0] if shebang_parts else ""
    assert interpreter, f"{executable_path} has an empty shebang"
    command = [interpreter]
    if len(shebang_parts) == 2:
        command.append(shebang_parts[1])
    command.append(str(executable_path))
    return command


def _translated_template_from_sam(sam_binary: str, template: Path, scratch_dir: Path) -> str:
    environment = os.environ.copy()
    environment.update(
        {
            "AWS_CONFIG_FILE": str(scratch_dir / "aws-config"),
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_SHARED_CREDENTIALS_FILE": str(scratch_dir / "aws-credentials"),
            "SAM_CLI_TELEMETRY": "0",
        }
    )
    completed = subprocess.run(
        [
            *_executable_command(sam_binary),
            "validate",
            "--debug",
            "--template-file",
            str(template),
            "--region",
            "eu-west-1",
        ],
        check=True,
        capture_output=True,
        env=environment,
        text=True,
    )
    output = f"{completed.stderr}\n{completed.stdout}"
    marker = " | Translated template is:\n"
    assert marker in output, "SAM CLI debug output did not include the translated template"
    return output.partition(marker)[2]


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


def test_backend_template_transactions_are_scoped_to_templates_and_audit_events():
    template = _load_template()
    policies = template["Resources"]["BackendFunction"]["Properties"]["Policies"]
    transaction_statements = [
        policy["Statement"]
        for policy in policies
        if "dynamodb:TransactWriteItems" in policy.get("Statement", {}).get("Action", [])
    ]
    expected_resources = {
        json.dumps({"GetAtt": "DataOpsTemplatesTable.Arn"}, sort_keys=True),
        json.dumps({"GetAtt": "DataOpsAuditEventsTable.Arn"}, sort_keys=True),
    }
    matching = [
        statement
        for statement in transaction_statements
        if {
            json.dumps(resource, sort_keys=True)
            for resource in statement.get("Resource", [])
        } == expected_resources
    ]

    assert len(matching) == 1
    assert matching[0]["Effect"] == "Allow"
    assert matching[0]["Action"] == ["dynamodb:TransactWriteItems"]


def test_conversational_state_table_is_retained_private_stream_ready_state():
    template = TEMPLATE.read_text(encoding="utf-8")
    table = _resource_block(template, "DataOpsConversationalStateTable")
    backend = _resource_block(template, "BackendFunction")

    assert "Type: AWS::DynamoDB::Table" in table
    assert "DeletionPolicy: Retain" in table
    assert "UpdateReplacePolicy: Retain" in table
    assert "BillingMode: PAY_PER_REQUEST" in table
    assert "SSEEnabled: true" in table
    assert "PointInTimeRecoveryEnabled: true" in table
    assert "AttributeName: ttl" in table
    assert "Enabled: true" in table
    assert "StreamViewType: NEW_AND_OLD_IMAGES" in table
    assert "IndexName: GSI1" in table
    assert "IndexName: GSI2" in table
    assert "Value: PrivateExecutionState" in table
    assert "DATAOPS_STACK_NAME: !Ref AWS::StackName" in backend
    assert "DATAOPS_CONVERSATIONAL_STATE_TABLE:" not in backend
    assert "!GetAtt DataOpsConversationalStateTable.Arn" in backend
    assert "${DataOpsConversationalStateTable.Arn}/index/*" in backend
    assert "DataOpsConversationalStateTableName:" in template
    assert "DynamoDBEvent" not in table


def test_conversational_execution_worker_has_filtered_stream_recovery_pulse_and_failure_delivery():
    template = TEMPLATE.read_text(encoding="utf-8")
    worker = _resource_block(template, "ConversationalExecutionWorkerFunction")
    queue = _resource_block(template, "ConversationalExecutionFailureQueue")
    backend = _resource_block(template, "BackendFunction")

    assert "Type: AWS::Serverless::Function" in worker
    assert "Handler: dist/execution-worker-handler.handler" in worker
    assert "Type: DynamoDB" in worker
    assert "!GetAtt DataOpsConversationalStateTable.StreamArn" in worker
    assert "ReportBatchItemFailures" in worker
    assert "MaximumRetryAttempts: 3" in worker
    assert "BisectBatchOnFunctionError: true" in worker
    assert '"recordType":{"S":["execution_attempt"]}' in worker
    assert '"status":{"S":["queued"]}' in worker
    assert "Type: SQS" in worker
    assert "!GetAtt ConversationalExecutionFailureQueue.Arn" in worker
    assert worker.count("Type: Schedule") == 2
    assert "conversational-execution-recovery" in worker
    assert "conversational-execution-health-pulse" in worker
    assert worker.count("Schedule: rate(2 minutes)") == 2
    assert worker.count(
        "State: !If [ConversationalExecutionIsEnabled, ENABLED, DISABLED]"
    ) == 2
    assert "dynamodb:Query" in worker
    assert "dynamodb:Scan" not in worker
    assert "${DataOpsConversationalStateTable.Arn}/index/GSI2" in worker
    assert "DATAOPS_USERS_TABLE: !Ref DataOpsUsersTable" in worker
    assert "DATAOPS_TASKS_TABLE: !Ref DataOpsTasksTable" in worker
    assert "!GetAtt DataOpsUsersTable.Arn" in worker
    assert worker.count("!GetAtt DataOpsUsersTable.Arn") == 1
    user_permissions = worker[
        worker.index("- !GetAtt DataOpsUsersTable.Arn") - 180:
        worker.index("- !GetAtt DataOpsUsersTable.Arn") + 50
    ]
    assert "dynamodb:GetItem" in user_permissions
    assert "dynamodb:TransactWriteItems" in user_permissions
    assert "dynamodb:PutItem" not in user_permissions
    assert "dynamodb:UpdateItem" not in user_permissions
    task_permissions = worker[
        worker.index("- !GetAtt DataOpsTasksTable.Arn") - 220:
        worker.index("- !GetAtt DataOpsTasksTable.Arn") + 50
    ]
    assert "dynamodb:GetItem" in task_permissions
    assert "dynamodb:PutItem" in task_permissions
    assert "dynamodb:TransactWriteItems" in task_permissions
    assert "dynamodb:UpdateItem" not in task_permissions
    assert "dynamodb:DeleteItem" not in task_permissions
    assert "dynamodb:Query" not in task_permissions
    assert "dynamodb:Scan" not in task_permissions
    assert worker.count("secretsmanager:GetSecretValue") == 1
    assert "Resource: !Ref WorkEngineTypefullyApiTokenSecretArn" in worker
    assert "TelegramIntegrationSecretName" not in worker
    assert "s3:" not in worker
    assert "Type: AWS::SQS::Queue" in queue
    assert "DeletionPolicy: Retain" in queue
    assert "UpdateReplacePolicy: Retain" in queue
    assert "SqsManagedSseEnabled: true" in queue
    assert "MessageRetentionPeriod: 1209600" in queue
    assert "QueuedAttemptStream" not in backend
    assert "CONVERSATIONAL_EXECUTION_LEASE_SECONDS" not in backend
    assert "CONVERSATIONAL_EXECUTION_ENABLED: !Ref ConversationalExecutionEnabled" in worker
    assert "CONVERSATIONAL_ENABLED_PLUGINS: !Ref ConversationalEnabledPlugins" in worker
    assert "State: !If [ConversationalExecutionIsEnabled, ENABLED, DISABLED]" in worker


def test_conversational_result_dispatcher_is_private_scheduled_and_least_privilege():
    template = TEMPLATE.read_text(encoding="utf-8")
    dispatcher = _resource_block(template, "ConversationalResultDispatcherFunction")
    worker = _resource_block(template, "ConversationalExecutionWorkerFunction")
    backend = _resource_block(template, "BackendFunction")

    assert "Type: AWS::Serverless::Function" in dispatcher
    assert "Handler: dist/result-notification-handler.handler" in dispatcher
    assert "DATAOPS_CONVERSATIONAL_STATE_TABLE: !Ref DataOpsConversationalStateTable" in dispatcher
    assert "TELEGRAM_INTEGRATION_SECRET_NAME: !Ref TelegramIntegrationSecretName" in dispatcher
    assert "Type: Schedule" in dispatcher
    assert "rate(1 minute)" in dispatcher
    assert "CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: !Ref ConversationalTelegramIngressEnabled" in dispatcher
    assert "State: !If [ConversationalIngressIsEnabled, ENABLED, DISABLED]" in dispatcher
    assert "dynamodb:GetItem" in dispatcher
    assert "dynamodb:Query" in dispatcher
    assert "dynamodb:UpdateItem" in dispatcher
    assert "dynamodb:PutItem" in dispatcher
    assert "dynamodb:DeleteItem" not in dispatcher
    assert "dynamodb:Scan" not in dispatcher
    assert "${DataOpsConversationalStateTable.Arn}/index/GSI2" in dispatcher
    assert "!GetAtt DataOpsUsersTable.Arn" in dispatcher
    assert "secretsmanager:GetSecretValue" in dispatcher
    assert "secret:${TelegramIntegrationSecretName}-*" in dispatcher
    assert "DATAOPS_TASKS_TABLE" not in dispatcher
    assert "ZAI_" not in dispatcher
    assert "TELEGRAM_INTEGRATION_SECRET_NAME" not in worker
    assert worker.count("secretsmanager:GetSecretValue") == 1
    assert "Resource: !Ref WorkEngineTypefullyApiTokenSecretArn" in worker
    assert "ResultDelivery" not in backend
    assert "ConversationalResultDispatcherFunctionName:" in template


def test_conversational_result_delivery_schedule_transforms_default_off_and_ingress_on():
    sam_binary = shutil.which("sam")
    assert sam_binary, "AWS SAM CLI is required for the transform contract test"
    template = TEMPLATE.read_text(encoding="utf-8")
    explicit_on_template = _template_with_parameter_default(
        template,
        "ConversationalTelegramIngressEnabled",
        "true",
    )
    scratch_root = REPO_ROOT / ".tmp"
    scratch_root.mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="sam-transform-", dir=scratch_root) as scratch_name:
        scratch_dir = Path(scratch_name)
        default_off_path = scratch_dir / "template-default-off.yaml"
        explicit_on_path = scratch_dir / "template-explicit-on.yaml"
        default_off_path.write_text(template, encoding="utf-8")
        explicit_on_path.write_text(explicit_on_template, encoding="utf-8")

        transformed_off = _translated_template_from_sam(sam_binary, default_off_path, scratch_dir)
        transformed_on = _translated_template_from_sam(sam_binary, explicit_on_path, scratch_dir)

    expected_condition = "\n".join(
        [
            "  ConversationalIngressIsEnabled:",
            "    Fn::Equals:",
            "    - Ref: ConversationalTelegramIngressEnabled",
            "    - 'true'",
        ]
    )
    expected_state = "\n".join(
        [
            "      State:",
            "        Fn::If:",
            "        - ConversationalIngressIsEnabled",
            "        - ENABLED",
            "        - DISABLED",
        ]
    )

    for transformed in (transformed_off, transformed_on):
        rule = _resource_block(
            transformed,
            "ConversationalResultDispatcherFunctionResultDelivery",
        )
        permission = _resource_block(
            transformed,
            "ConversationalResultDispatcherFunctionResultDeliveryPermission",
        )
        assert "Type: AWS::Events::Rule" in rule
        assert "ScheduleExpression: rate(1 minute)" in rule
        assert expected_state in rule
        assert "- ConversationalResultDispatcherFunction" in rule
        assert "- Arn" in rule
        assert (
            "Id: ConversationalResultDispatcherFunctionResultDeliveryLambdaTarget"
            in rule
        )
        assert "Type: AWS::Lambda::Permission" in permission
        assert "Action: lambda:InvokeFunction" in permission
        assert "Principal: events.amazonaws.com" in permission
        assert "Ref: ConversationalResultDispatcherFunction" in permission
        assert "- ConversationalResultDispatcherFunctionResultDelivery" in permission
        assert "- Arn" in permission
        assert expected_condition in _resource_block(
            transformed,
            "ConversationalIngressIsEnabled",
        )

    default_off_parameter = _resource_block(
        transformed_off,
        "ConversationalTelegramIngressEnabled",
    )
    explicit_on_parameter = _resource_block(
        transformed_on,
        "ConversationalTelegramIngressEnabled",
    )
    assert "    Default: 'false'" in default_off_parameter
    assert "    Default: 'true'" in explicit_on_parameter


def test_conversational_execution_schedules_transform_with_exact_rules_permissions_and_inputs():
    sam_binary = shutil.which("sam")
    assert sam_binary, "AWS SAM CLI is required for the transform contract test"
    template = TEMPLATE.read_text(encoding="utf-8")
    explicit_on_template = _template_with_parameter_default(
        template,
        "ConversationalExecutionEnabled",
        "true",
    )
    scratch_root = REPO_ROOT / ".tmp"
    scratch_root.mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="sam-execution-pulses-", dir=scratch_root) as scratch_name:
        scratch_dir = Path(scratch_name)
        default_off_path = scratch_dir / "template-default-off.yaml"
        explicit_on_path = scratch_dir / "template-explicit-on.yaml"
        default_off_path.write_text(template, encoding="utf-8")
        explicit_on_path.write_text(explicit_on_template, encoding="utf-8")
        transformed_off = _translated_template_from_sam(
            sam_binary, default_off_path, scratch_dir
        )
        transformed_on = _translated_template_from_sam(
            sam_binary, explicit_on_path, scratch_dir
        )

    expected_state = "\n".join(
        [
            "      State:",
            "        Fn::If:",
            "        - ConversationalExecutionIsEnabled",
            "        - ENABLED",
            "        - DISABLED",
        ]
    )
    events = {
        "ExecutionRecovery": (
            "conversational-execution-recovery",
            "ConversationalExecutionWorkerFunctionExecutionRecoveLambdaTarget",
        ),
        "ExecutionHealthPulse": (
            "conversational-execution-health-pulse",
            "ConversationalExecutionWorkerFunctionExecutionHealthLambdaTarget",
        ),
    }
    for transformed in (transformed_off, transformed_on):
        for event_name, (action, target_id) in events.items():
            rule_id = f"ConversationalExecutionWorkerFunction{event_name}"
            permission_id = f"{rule_id}Permission"
            rule = _resource_block(transformed, rule_id)
            permission = _resource_block(transformed, permission_id)
            assert "Type: AWS::Events::Rule" in rule
            assert "ScheduleExpression: rate(2 minutes)" in rule
            assert expected_state in rule
            assert "- ConversationalExecutionWorkerFunction" in rule
            assert "- Arn" in rule
            assert f"Id: {target_id}" in rule
            assert action in rule
            assert "Type: AWS::Lambda::Permission" in permission
            assert "Action: lambda:InvokeFunction" in permission
            assert "Principal: events.amazonaws.com" in permission
            assert "FunctionName:" in permission
            assert "Ref: ConversationalExecutionWorkerFunction" in permission
            assert f"- {rule_id}" in permission
            assert "- Arn" in permission


def test_conversational_observability_graph_is_exact_retained_and_conditioned():
    template = _load_template()
    resources = template["Resources"]
    topic = resources["ConversationalRolloutAlarmTopic"]
    assert topic == {
        "Type": "AWS::SNS::Topic",
        "Properties": {
            "TopicName": {"Sub": "${AWS::StackName}-conversational-rollout-alarms"},
            "KmsMasterKeyId": "alias/aws/sns",
        },
    }
    assert template["Outputs"]["ConversationalRolloutAlarmTopicArn"] == {
        "Value": {"Ref": "ConversationalRolloutAlarmTopic"}
    }
    assert not any(resource["Type"] in {
        "AWS::SNS::Subscription",
        "AWS::SNS::TopicPolicy",
        "AWS::CloudWatch::CompositeAlarm",
        "AWS::CloudWatch::Dashboard",
        "AWS::Logs::SubscriptionFilter",
        "AWS::Logs::MetricFilter",
    } for resource in resources.values())

    groups = {
        "ConversationalBackendLogGroup": (
            "/dataops/${AWS::StackName}/conversational/backend",
            "BackendFunction",
        ),
        "ConversationalExecutionLogGroup": (
            "/dataops/${AWS::StackName}/conversational/execution",
            "ConversationalExecutionWorkerFunction",
        ),
        "ConversationalResultDispatcherLogGroup": (
            "/dataops/${AWS::StackName}/conversational/result-dispatcher",
            "ConversationalResultDispatcherFunction",
        ),
    }
    assert {
        logical_id
        for logical_id, resource in resources.items()
        if resource["Type"] == "AWS::Logs::LogGroup"
        and logical_id.startswith("Conversational")
    } == set(groups)
    for logical_id, (name, function_id) in groups.items():
        group = resources[logical_id]
        assert group["DeletionPolicy"] == "Retain"
        assert group["UpdateReplacePolicy"] == "Retain"
        assert group["Properties"] == {
            "LogGroupName": {"Sub": name},
            "RetentionInDays": 30,
        }
        assert resources[function_id]["Properties"]["LoggingConfig"] == {
            "LogFormat": "JSON",
            "LogGroup": {"Ref": logical_id},
        }
    assert "/aws/lambda/" not in "\n".join(
        str(resources[logical_id]) for logical_id in groups
    )

    actual_alarm_ids = {
        logical_id
        for logical_id, resource in resources.items()
        if resource["Type"] == "AWS::CloudWatch::Alarm"
    }
    assert actual_alarm_ids == set(ALARM_CONTRACT)
    for logical_id, (suffix, metric, threshold, period, periods, statistic) in ALARM_CONTRACT.items():
        alarm = resources[logical_id]
        properties = alarm["Properties"]
        assert alarm["Condition"].startswith("Conversational")
        assert properties["AlarmName"] == {
            "Sub": f"${{AWS::StackName}}-conversational-{suffix}"
        }
        assert properties["MetricName"] == metric
        assert properties["Threshold"] == threshold
        assert properties["Period"] == period
        assert properties["EvaluationPeriods"] == periods
        assert properties["DatapointsToAlarm"] == periods
        assert properties["Statistic"] == statistic
        expected_missing = (
            "breaching" if logical_id in HEARTBEAT_ALARMS else "notBreaching"
        )
        assert properties["TreatMissingData"] == expected_missing
        assert properties["AlarmActions"] == [{"Ref": "ConversationalRolloutAlarmTopic"}]
        assert "Tags" not in properties
    assert resources["ConversationalExecutionFailureQueueVisibleAlarm"]["Properties"]["Namespace"] == "AWS/SQS"
    for logical_id in actual_alarm_ids - {"ConversationalExecutionFailureQueueVisibleAlarm"}:
        assert resources[logical_id]["Properties"]["Namespace"] == "DataOps/ConversationalAgent"


def test_heartbeat_alarm_states_distinguish_idle_gap_stopped_disabled_and_errors():
    resources = _load_template()["Resources"]

    def alarm_state(logical_id: str, samples: list[int | None]) -> str:
        properties = resources[logical_id]["Properties"]
        periods = properties["EvaluationPeriods"]
        datapoints = properties["DatapointsToAlarm"]
        considered = samples[-periods:]
        breaching = sum(
            value is None or value > properties["Threshold"]
            for value in considered
        )
        return "ALARM" if breaching >= datapoints else "OK"

    for logical_id in HEARTBEAT_ALARMS:
        alarm = resources[logical_id]
        expected_condition = (
            "ConversationalIngressIsEnabled"
            if logical_id == "ConversationalResultDispatcherHeartbeatStaleAlarm"
            else "ConversationalExecutionIsEnabled"
        )
        assert alarm["Condition"] == expected_condition
        assert alarm["Properties"]["TreatMissingData"] == "breaching"
        assert alarm_state(logical_id, [0, 0]) == "OK"  # healthy and idle/no-work
        assert alarm_state(logical_id, [0, None]) == "OK"  # one missing period
        assert alarm_state(logical_id, [None, None]) == "ALARM"  # stopped/error

    non_heartbeat = set(ALARM_CONTRACT) - HEARTBEAT_ALARMS
    assert len(non_heartbeat) == 14
    for logical_id in non_heartbeat:
        assert resources[logical_id]["Properties"]["TreatMissingData"] == "notBreaching"

    worker = resources["ConversationalExecutionWorkerFunction"]["Properties"]["Events"]
    for event_name in ("ExecutionRecovery", "ExecutionHealthPulse"):
        assert worker[event_name]["Properties"]["State"] == {
            "If": [
                "ConversationalExecutionIsEnabled",
                "ENABLED",
                "DISABLED",
            ]
        }
    dispatcher = resources["ConversationalResultDispatcherFunction"]["Properties"]["Events"]
    assert dispatcher["ResultDelivery"]["Properties"]["State"] == {
        "If": ["ConversationalIngressIsEnabled", "ENABLED", "DISABLED"]
    }


def test_rollout_exposes_only_six_behavior_controls_with_all_off_defaults():
    template = _load_template()
    parameters = template["Parameters"]
    controls = {
        "ConversationalTelegramIngressEnabled": "false",
        "ConversationalExecutionEnabled": "false",
        "ConversationalEnabledPlugins": "none",
        "ConversationalTypefullyExternalExecutionEnabled": "false",
        "ConversationalTelegramVoiceEnabled": "false",
        "ConversationalTelegramPhotoEnabled": "false",
    }
    for name, expected in controls.items():
        assert parameters[name]["Default"] == expected
    retired = {
        "ConversationalAgentEnabled",
        "ConversationalTodoPluginEnabled",
        "ConversationalTodoExecutorEnabled",
        "ConversationalTypefullyPluginEnabled",
        "ConversationalTypefullyExecutionEnabled",
        "ConversationalResultDeliveryEnabled",
        "ConversationalTelegramEnabled",
    }
    assert retired.isdisjoint(parameters)
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    for name in retired:
        assert name not in workflow
    for environment_name in [
        "CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED",
        "CONVERSATIONAL_EXECUTION_ENABLED",
        "CONVERSATIONAL_ENABLED_PLUGINS",
        "CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED",
        "CONVERSATIONAL_TELEGRAM_VOICE_ENABLED",
        "CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED",
    ]:
        assert workflow.count(f"ParameterValue=${environment_name}") == 1
    assert "aws lambda update-function-configuration" not in workflow
    assert "aws secretsmanager get-secret-value" not in workflow


def test_fresh_sam_transforms_cover_every_alarm_controlling_switch_state():
    sam_binary = shutil.which("sam")
    assert sam_binary, "AWS SAM CLI is required for the transform contract test"
    source = TEMPLATE.read_text(encoding="utf-8")
    states = {
        "dark": {},
        "execution": {"ConversationalExecutionEnabled": "true"},
        "ingress": {
            "ConversationalTelegramIngressEnabled": "true",
            "ZaiConversationalApiKeySecretArn": "arn:aws:secretsmanager:eu-west-1:000000000000:secret:zai",
        },
        "voice": {
            "ConversationalTelegramIngressEnabled": "true",
            "ConversationalTelegramVoiceEnabled": "true",
            "ZaiConversationalApiKeySecretArn": "arn:aws:secretsmanager:eu-west-1:000000000000:secret:zai",
            "GroqTranscriptionApiKeySecretArn": "arn:aws:secretsmanager:eu-west-1:000000000000:secret:groq",
        },
        "photo": {
            "ConversationalTelegramIngressEnabled": "true",
            "ConversationalTelegramPhotoEnabled": "true",
            "ZaiConversationalApiKeySecretArn": "arn:aws:secretsmanager:eu-west-1:000000000000:secret:zai",
            "ZaiVisionApiKeySecretArn": "arn:aws:secretsmanager:eu-west-1:000000000000:secret:vision",
        },
        "typefully-external": {
            "ConversationalExecutionEnabled": "true",
            "ConversationalEnabledPlugins": "typefully",
            "ConversationalTypefullyExternalExecutionEnabled": "true",
        },
    }
    scratch_root = REPO_ROOT / ".tmp"
    scratch_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sam-rollout-transforms-", dir=scratch_root) as scratch_name:
        scratch_dir = Path(scratch_name)
        transformed_by_state = {}
        for name, defaults in states.items():
            state_template = _template_with_defaults(source, defaults)
            path = scratch_dir / f"template-{name}.yaml"
            path.write_text(state_template, encoding="utf-8")
            transformed_by_state[name] = _translated_template_from_sam(
                sam_binary, path, scratch_dir
            )

    for name, transformed in transformed_by_state.items():
        assert "ConversationalRolloutAlarmTopic:" in transformed, name
        assert transformed.count("Type: AWS::CloudWatch::Alarm") == 17, name
        for logical_id in ALARM_CONTRACT:
            block = _resource_block(transformed, logical_id)
            assert "Condition: Conversational" in block, (name, logical_id)
            expected_missing = (
                "breaching" if logical_id in HEARTBEAT_ALARMS else "notBreaching"
            )
            assert f"TreatMissingData: {expected_missing}" in block, (name, logical_id)
        assert "Type: AWS::SNS::Subscription" not in transformed, name
        assert "Type: AWS::SNS::TopicPolicy" not in transformed, name
        assert "Type: AWS::CloudWatch::CompositeAlarm" not in transformed, name
        assert "Type: AWS::Logs::MetricFilter" not in transformed, name


def test_sam_executable_command_invokes_python_shebang_script():
    scratch_root = REPO_ROOT / ".tmp"
    scratch_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sam-script-", dir=scratch_root) as scratch_name:
        script = Path(scratch_name) / "sam"
        script.write_text(
            f"#!{sys.executable}\n"
            "import sys\n"
            "print(sys.argv[1])\n",
            encoding="utf-8",
        )
        script.chmod(0o755)

        completed = subprocess.run(
            [*_executable_command(script), "script-ok"],
            check=True,
            capture_output=True,
            text=True,
        )

    assert completed.stdout.strip() == "script-ok"


def test_sam_executable_command_invokes_native_binary():
    command = _executable_command(sys.executable)
    assert command == [sys.executable]

    completed = subprocess.run(
        [*command, "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert completed.stdout.startswith("Python ")


def test_conversational_telegram_media_is_disabled_and_uses_exact_optional_secrets():
    template = TEMPLATE.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")

    assert 'ConversationalTelegramIngressEnabled:' in template
    assert 'ConversationalTelegramVoiceEnabled:' in template
    assert 'ConversationalTelegramPhotoEnabled:' in template
    for parameter in [
        "ConversationalTelegramIngressEnabled",
        "ConversationalTelegramVoiceEnabled",
        "ConversationalTelegramPhotoEnabled",
    ]:
        assert f'  {parameter}:\n    Type: String\n    Default: "false"' in template
    assert "TelegramVoiceRequiresConfiguration:" in template
    assert "TelegramPhotoRequiresConfiguration:" in template
    assert "CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: !Ref ConversationalTelegramIngressEnabled" in backend
    assert "CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: !Ref ConversationalTelegramVoiceEnabled" in backend
    assert "CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: !Ref ConversationalTelegramPhotoEnabled" in backend
    assert "GROQ_TRANSCRIPTION_API_KEY_SECRET_ARN: !Ref GroqTranscriptionApiKeySecretArn" in backend
    assert "ZAI_VISION_API_KEY_SECRET_ARN: !Ref ZaiVisionApiKeySecretArn" in backend
    assert "ZAI_VISION_MODEL: !Ref ZaiVisionModel" in backend
    assert "ZAI_VISION_BASE_URL: !Ref ZaiVisionBaseUrl" in backend
    bounded_settings = {
        "TelegramHandlerDeadlineMs": ("28000", "TELEGRAM_HANDLER_DEADLINE_MS"),
        "TelegramApiTimeoutMs": ("5000", "TELEGRAM_API_TIMEOUT_MS"),
        "TelegramApiMaxResponseBytes": ("65536", "TELEGRAM_API_MAX_RESPONSE_BYTES"),
        "TelegramVoiceMaxBytes": ("20971520", "TELEGRAM_VOICE_MAX_BYTES"),
        "TelegramVoiceMaxSeconds": ("300", "TELEGRAM_VOICE_MAX_SECONDS"),
        "TelegramPhotoMaxBytes": ("10485760", "TELEGRAM_PHOTO_MAX_BYTES"),
        "TelegramPhotoMaxPixels": ("20000000", "TELEGRAM_PHOTO_MAX_PIXELS"),
        "TelegramMediaDownloadTimeoutMs": ("8000", "TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS"),
        "TelegramMediaProviderTimeoutMs": ("18000", "TELEGRAM_MEDIA_PROVIDER_TIMEOUT_MS"),
        "TelegramMediaProviderMaxResponseBytes": (
            "65536",
            "TELEGRAM_MEDIA_PROVIDER_MAX_RESPONSE_BYTES",
        ),
        "TelegramMediaMaxTextBytes": ("16384", "TELEGRAM_MEDIA_MAX_TEXT_BYTES"),
    }
    for parameter, (default, environment_name) in bounded_settings.items():
        assert f"  {parameter}:\n    Type: Number\n    Default: {default}" in template
        assert f"{environment_name}: !Ref {parameter}" in backend
        assert f"{environment_name}: ${{{{ vars.{environment_name} }}}}" in workflow
        assert f'ParameterKey={parameter},ParameterValue=${environment_name}' in workflow
    telegram_timeout = _load_template()["Parameters"]["TelegramApiTimeoutMs"]
    assert telegram_timeout["MinValue"] == 100
    assert telegram_timeout["MaxValue"] == 5000
    assert "TELEGRAM_API_TIMEOUT_MS must be an integer from 100 through 5000" in workflow
    assert "HasGroqTranscriptionSecret" in backend
    assert "HasZaiVisionSecret" in backend
    assert "!Ref GroqTranscriptionApiKeySecretArn" in backend
    assert "!Ref ZaiVisionApiKeySecretArn" in backend
    assert "GROQ_TRANSCRIPTION_API_KEY_SECRET_ARN: ${{ vars.GROQ_TRANSCRIPTION_API_KEY_SECRET_ARN }}" in workflow
    assert "ZAI_VISION_API_KEY_SECRET_ARN: ${{ vars.ZAI_VISION_API_KEY_SECRET_ARN }}" in workflow
    assert "ParameterKey=GroqTranscriptionApiKeySecretArn" in workflow
    assert "ParameterKey=ZaiVisionApiKeySecretArn" in workflow
    assert "ParameterKey=ZaiVisionModel,ParameterValue=$ZAI_VISION_MODEL" in workflow
    assert "ParameterKey=ZaiVisionBaseUrl,ParameterValue=$ZAI_VISION_BASE_URL" in workflow
    assert "aws secretsmanager get-secret-value" not in workflow


def test_conversational_zai_secret_is_optional_disabled_and_exactly_scoped():
    template = TEMPLATE.read_text(encoding="utf-8")
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")

    assert "ConversationalTelegramIngressEnabled:" in template
    assert 'Default: "false"' in template
    assert "ZaiConversationalApiKeySecretArn:" in template
    assert "Default: \"\"" in template
    assert "ConversationalIngressRequiresZaiSecret:" in template
    assert "HasZaiConversationalSecret:" in template
    assert "CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: !Ref ConversationalTelegramIngressEnabled" in backend
    for parameter in [
        "ConversationalTelegramIngressEnabled",
        "ConversationalExecutionEnabled",
    ]:
        assert f'  {parameter}:\n    Type: String\n    Default: "false"' in template
    assert "  ConversationalEnabledPlugins:\n    Type: String\n    Default: none" in template
    assert "CONVERSATIONAL_EXECUTION_ENABLED: !Ref ConversationalExecutionEnabled" in backend
    assert "CONVERSATIONAL_ENABLED_PLUGINS: !Ref ConversationalEnabledPlugins" in backend
    assert "CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: ${{ vars.CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED }}" in workflow
    assert "CONVERSATIONAL_EXECUTION_ENABLED: ${{ vars.CONVERSATIONAL_EXECUTION_ENABLED }}" in workflow
    assert "CONVERSATIONAL_ENABLED_PLUGINS: ${{ vars.CONVERSATIONAL_ENABLED_PLUGINS }}" in workflow
    assert "ParameterKey=ConversationalTelegramIngressEnabled,ParameterValue=$CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED" in workflow
    assert "ParameterKey=ConversationalExecutionEnabled,ParameterValue=$CONVERSATIONAL_EXECUTION_ENABLED" in workflow
    assert "ParameterKey=ConversationalEnabledPlugins,ParameterValue=$CONVERSATIONAL_ENABLED_PLUGINS" in workflow
    assert "ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN: !Ref ZaiConversationalApiKeySecretArn" in backend
    assert "- !Ref ZaiConversationalApiKeySecretArn" in backend
    assert "secret:${ZaiConversationalApiKeySecretArn}" not in backend
    assert "apiKey" not in backend
    assert "ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN: ${{ vars.ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN }}" in workflow
    assert "Telegram ingress cannot be enabled without its z.ai secret ARN" in workflow
    assert "ParameterKey=ZaiConversationalApiKeySecretArn,ParameterValue=$ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN" in workflow
    assert "aws secretsmanager get-secret-value" not in workflow


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
    assert "CodeUri: .." in backend
    assert "Runtime: nodejs24.x" in backend
    assert "Handler: dist/handler.handler" in backend
    assert "FunctionUrlConfig" in backend
    assert "WORK_ENGINE_AUTH_MODE: portal" in backend
    assert "DATAOPS_DOCS_DOMAIN: " in backend
    assert "GITHUB_OWNER: !Ref GitHubOwner" in backend
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
    assert "DATAOPS_STACK_NAME: !Ref AWS::StackName" in backend
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


def test_mailing_export_storage_schedule_and_dapier_credential_are_private_and_least_privilege():
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
    assert "DATAOPS_DAPIER_CREDENTIALS_TABLE: !Ref DapierCredentialsTableName" in backend
    assert "Action: [dynamodb:GetItem]" in backend
    assert "Resource: !Ref DapierCredentialsTableArn" in backend
    assert "dynamodb:LeadingKeys: [mailchimp]" in backend
    assert "MailchimpSecretArn" not in template
    assert "HasMailchimpSecret" not in template
    assert "DailyMailingExport" in backend
    assert '"dataopsAction":"mailing-export"' in backend
    assert "DAPIER_CREDENTIALS_TABLE_NAME: ${{ vars.DAPIER_CREDENTIALS_TABLE_NAME }}" in workflow
    assert "DAPIER_CREDENTIALS_TABLE_ARN: ${{ vars.DAPIER_CREDENTIALS_TABLE_ARN }}" in workflow
    assert 'if [ -z "$DAPIER_CREDENTIALS_TABLE_NAME" ] || [ -z "$DAPIER_CREDENTIALS_TABLE_ARN" ]' in workflow
    assert "MAILING_EXPORTS_CONFIG: ${{ vars.MAILING_EXPORTS_CONFIG }}" in workflow
    assert "ParameterKey=DapierCredentialsTableName,ParameterValue=$DAPIER_CREDENTIALS_TABLE_NAME" in workflow
    assert "ParameterKey=DapierCredentialsTableArn,ParameterValue=$DAPIER_CREDENTIALS_TABLE_ARN" in workflow
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
    migrator = SPONSOR_GSI_MIGRATOR.read_text(encoding="utf-8")
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
    assert (
        "node scripts/deploy/sponsor-crm-gsi-guard.mjs infra/template.full.yaml"
        in workflow
    )
    oidc = deploy_job.index("aws-actions/configure-aws-credentials@")
    guard = deploy_job.index("sponsor-crm-gsi-guard.mjs")
    assert oidc < guard
    for operation in (
        "make sam-build",
        "sam deploy",
        "sam package",
        "aws s3api put-object",
        "aws cloudformation create-change-set",
        "aws cloudformation execute-change-set",
        "Seed runtime users, workflow templates, and recurring configs",
    ):
        if operation in deploy_job:
            assert guard < deploy_job.index(operation)
    assert '"create-change-set",' in migrator
    assert '"execute-change-set",' in migrator
    assert '"--no-execute-changeset",' not in migrator
    assert 'parseSamChangeSetOutput' not in migrator
    assert '"deploy",' not in migrator
    assert 'final-create' not in migrator
    assert 'final-execute' not in migrator
    for parameter, variable in expected.items():
        assert f"ParameterKey={parameter},ParameterValue=${variable}" in workflow
    assert "dtcdev-shared-auth" not in workflow
    assert "GoogleClientSecret" not in workflow
    assert "CognitoClientSecret" not in workflow


def test_deploy_workflow_keeps_production_auth_out_of_checks_and_scoped_to_deploy():
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    before_jobs, jobs = workflow.split("\njobs:\n", 1)
    checks, deploy = jobs.split("\n  deploy:\n", 1)
    expected_auth = {
        "AUTH_BASE_URL": "https://auth.dtcdev.click",
        "AUTH_USER_POOL_ID": "us-east-1_H7nJu52Bs",
        "AUTH_ISSUER": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_H7nJu52Bs",
        "AUTH_JWKS_URL": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_H7nJu52Bs/.well-known/jwks.json",
        "AUTH_CLIENT_ID": "1kjv61esdjs3003s8u42sgr3hf",
        "AUTH_CALLBACK_URL": "https://ops.dtcdev.click/auth/callback",
        "AUTH_LOGOUT_URL": "https://ops.dtcdev.click/",
        "AUTH_SESSION_LIFETIME_SECONDS": "28800",
    }

    for variable, value in expected_auth.items():
        # Workflow-level env reaches every check and every Playwright child
        # process. Production relying-party config belongs only to deployment.
        assert f"{variable}:" not in before_jobs
        assert f"{variable}:" not in checks
        assert f"      {variable}: {value}" in deploy
        assert f"ParameterValue=${variable}" in deploy


def test_sponsor_communication_table_indexes_ttl_stream_and_default_off_contract():
    template = TEMPLATE.read_text(encoding="utf-8")
    table = _resource_block(template, "DataOpsSponsorCrmTable")
    parameter = template.split("  SponsorCommunicationSendEnabled:", 1)[1].split(
        "\n  SponsorCommunicationTemplateSecretArn:", 1
    )[0]
    assert "DeletionPolicy: Retain" in table
    assert "UpdateReplacePolicy: Retain" in table
    assert "SSESpecification: { SSEEnabled: true }" in table
    assert "PointInTimeRecoveryEnabled: true" in table
    # TTL is intentionally omitted while DynamoDB's one-hour TTL mutation
    # cooldown is active; it is safe to enable in a later isolated update.
    assert "TimeToLiveSpecification:" not in table
    assert "StreamViewType: NEW_AND_OLD_IMAGES" in table
    for index in (
        "GSI-Communication",
        "GSI-SponsorSendDue",
        "GSI-SponsorSendLookup",
        "GSI-SponsorBookingCommunication",
    ):
        assert f"IndexName: {index}" in table
    assert 'Default: "false"' in parameter
    assert "SponsorSendRequiresPrivateConfiguration" in template


def test_sponsor_communication_backend_and_worker_capabilities_are_separated():
    template = TEMPLATE.read_text(encoding="utf-8")
    backend = _resource_block(template, "BackendFunction")
    worker = _resource_block(template, "SponsorSendWorkerFunction")
    event_handler = _resource_block(template, "SponsorSesEventFunction")
    archive = _resource_block(template, "SponsorPrivateArchiveFunction")

    assert "SPONSOR_COMMUNICATION_TEMPLATE_SECRET_ARN: !Ref SponsorCommunicationTemplateSecretArn" in backend
    assert "SPONSOR_COMMUNICATION_HMAC_SECRET_ARN: !Ref SponsorCommunicationHmacSecretArn" in backend
    assert "ses:" not in backend

    assert "Handler: dist/sponsor-send-worker-handler.handler" in worker
    assert "Action: ses:SendEmail" in worker
    assert "Resource: !Ref SponsorSesIdentityArn" in worker
    assert "ses:FromAddress: !Ref SponsorSesFromAddress" in worker
    assert "ses:ConfigurationSet: !Ref SponsorSesConfigurationSet" in worker
    assert "SendRawEmail" not in worker
    assert "SendBulkEmail" not in worker
    assert "ses:*" not in worker
    assert "SponsorCommunicationTemplateSecretArn" not in worker
    assert "SponsorCommunicationHmacSecretArn" in worker
    assert "DATAOPS_USERS_TABLE: !Ref DataOpsUsersTable" in worker
    assert "GSI-SponsorSendDue" in worker
    assert "dynamodb:Scan" not in worker

    assert "Handler: dist/sponsor-ses-event-handler.handler" in event_handler
    assert "ses:" not in event_handler
    assert "SponsorCommunicationTemplateSecretArn" not in event_handler
    assert "SponsorCommunicationHmacSecretArn" in event_handler
    assert "DataOpsUsersTable" not in event_handler

    assert "Handler: dist/sponsor-private-archive-handler.handler" in archive
    assert "dynamodb:Scan" in archive
    assert "dynamodb:PutItem" not in archive
    assert "secretsmanager:" not in archive
    assert "ses:" not in archive
    assert "SponsorCommunicationPrivateArchiveBucket" in archive
    assert "DataOpsExportArchiveBucket" not in archive


def test_sponsor_ses_events_are_transformed_before_lambda_and_failures_are_encrypted():
    template = TEMPLATE.read_text(encoding="utf-8")
    rule = _resource_block(template, "SponsorSesEventRule")
    queue = _resource_block(template, "SponsorCommunicationFailureQueue")
    destination = _resource_block(template, "SponsorSesEventDestination")

    assert "InputTransformer:" in rule
    assert "InputPathsMap:" in rule
    assert "InputTemplate:" in rule
    # EventBridge InputTransformer JSONPaths only accept dot notation. The
    # SES configuration-set tag contains a colon, so project the stack-owned
    # configuration-set name directly into the strict envelope instead.
    assert "['" not in rule
    assert '${SponsorSesConfigurationSet}' in rule
    assert '$.detail.mail.tags.configuration-set-generation[0]' in rule
    assert '$.detail.mail.tags.config-generation[0]' in rule
    for field in (
        "eventId", "eventTime", "eventType", "messageId", "awsAccount", "awsRegion",
        "configurationSet", "configurationSetGeneration", "attemptCorrelation",
        "communicationId", "configGeneration",
    ):
        assert field in rule
    for private_field in ("recipient", "subject", "body", "headers", "diagnostic"):
        assert private_field not in rule.lower()
    # A rule-level DLQ receives the failed EventBridge source event, which may
    # contain SES recipient/diagnostic fields. Only the Lambda async failure
    # destination may retain the already-transformed strict envelope.
    assert "DeadLetterConfig" not in rule
    event_handler = _resource_block(template, "SponsorSesEventFunction")
    assert "EventInvokeConfig:" in event_handler
    assert "Destination: !GetAtt SponsorCommunicationFailureQueue.Arn" in event_handler
    assert "events.amazonaws.com" not in template[
        template.index("SponsorCommunicationFailureQueue:"):template.index("SponsorCommunicationPrivateArchiveKey:")
    ]
    assert "KmsMasterKeyId: alias/aws/sqs" in queue
    assert "MessageRetentionPeriod: 1209600" in queue
    assert "MatchingEventTypes: [SEND, DELIVERY, DELIVERY_DELAY, REJECT, RENDERING_FAILURE, BOUNCE, COMPLAINT]" in destination


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
