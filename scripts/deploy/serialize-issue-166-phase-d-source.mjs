#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';

function fail(message) {
  throw new Error(`Issue #166 Phase D source serialization refused: ${message}`);
}

function intrinsic(tag, key, kind, construct = (value) => value) {
  return new yaml.Type(`!${tag}`, {
    kind,
    construct: (value) => ({ [key]: construct(value) }),
  });
}

const scalarAndSequence = (tag, key, scalar = (value) => value) => [
  intrinsic(tag, key, 'scalar', scalar),
  intrinsic(tag, key, 'sequence'),
];
const cloudFormationSchema = yaml.Schema.create([
  intrinsic('Ref', 'Ref', 'scalar'),
  intrinsic('Condition', 'Condition', 'scalar'),
  ...scalarAndSequence('Sub', 'Fn::Sub'),
  ...scalarAndSequence('GetAtt', 'Fn::GetAtt', (value) => value.split('.')),
  intrinsic('If', 'Fn::If', 'sequence'),
  intrinsic('Equals', 'Fn::Equals', 'sequence'),
  intrinsic('Not', 'Fn::Not', 'sequence'),
  intrinsic('And', 'Fn::And', 'sequence'),
  intrinsic('Or', 'Fn::Or', 'sequence'),
]);

const sourcePath = resolve(process.argv[2] ?? 'infra/template.full.yaml');
const outputPath = resolve(process.argv[3] ?? '.tmp/issue-166-phase-d-readiness/source-template.json');
const commitSha = process.argv[4] ?? '';
if (!/^[0-9a-f]{40}$/.test(commitSha)) fail('commit must be an exact 40-character SHA');

const template = yaml.safeLoad(readFileSync(sourcePath, 'utf8'), { schema: cloudFormationSchema });
if (!template || typeof template !== 'object' || Array.isArray(template)) {
  fail('source SAM template must be a mapping');
}
const encodedTemplate = JSON.stringify(template);
const envelope = {
  schemaVersion: 1,
  commitSha,
  templateSha256: createHash('sha256').update(encodedTemplate).digest('hex'),
  template,
};

mkdirSync(dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, 'utf8');
renameSync(temporaryPath, outputPath);
console.log('Serialized SHA-bound issue #166 Phase D source-template readiness input.');
