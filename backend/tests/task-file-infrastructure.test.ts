import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

it('deploys durable private task storage and grants only the backend object access', () => {
  const types = ['Ref', 'GetAtt', 'Sub', 'If', 'And', 'Or', 'Not', 'Equals'].flatMap(name =>
    (['scalar', 'sequence', 'mapping'] as const).map(kind => new yaml.Type(`!${name}`, {
      kind, construct: value => ({ [name]: value }),
    })));
  const stack = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../infra/template.full.yaml'), 'utf8'), {
    schema: yaml.DEFAULT_SCHEMA.extend(types),
  }) as { Resources: Record<string, { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: Record<string, any> }> };
  const bucket = stack.Resources.TaskFilesBucket;
  assert.equal(bucket.Type, 'AWS::S3::Bucket');
  assert.equal(bucket.DeletionPolicy, 'Retain');
  assert.equal(bucket.UpdateReplacePolicy, 'Retain');
  assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.deepEqual(Object.values(bucket.Properties.PublicAccessBlockConfiguration), [true, true, true, true]);
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  const tls = stack.Resources.TaskFilesBucketPolicy.Properties.PolicyDocument.Statement[0];
  assert.equal(tls.Effect, 'Deny');
  assert.deepEqual(tls.Condition, { Bool: { 'aws:SecureTransport': false } });
  const backend = stack.Resources.BackendFunction.Properties;
  assert.deepEqual(backend.Environment.Variables.TASK_FILES_BUCKET, { Ref: 'TaskFilesBucket' });
  assert.equal(backend.Environment.Variables.DATAOPS_FILE_STORAGE_PROVIDER, 's3');
  const permission = backend.Policies.find((entry: any) => entry.Statement?.Resource?.Sub === '${TaskFilesBucket.Arn}/tasks/*');
  assert.ok(permission, 'Backend must have object access scoped to the task prefix');
  assert.deepEqual(permission.Statement.Action, ['s3:GetObject', 's3:PutObject', 's3:DeleteObject']);
});
