import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import yaml from "js-yaml";

/**
 * Structural checks on the deploy workflow.
 *
 * This replaces a set of whole-file SHA-256 pins that broke on any edit,
 * including comments, and were therefore stale for weeks -- long enough to
 * block every deploy without anyone noticing. What is worth asserting is the
 * shape of the job, not its bytes.
 */

const workflow = yaml.load(readFileSync(".github/workflows/deploy-dataops-v1.yml", "utf8"));

test("the deploy job assumes credentials before it touches AWS", () => {
  const steps = workflow.jobs.deploy.steps.map((step) => step.name).filter(Boolean);
  const credentials = steps.findIndex((name) => /Configure AWS credentials/.test(name));
  assert.ok(credentials >= 0, `credentials step missing from: ${steps.join(", ")}`);

  const mutations = steps
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => /deploy|seed|smoke/i.test(name));
  assert.ok(mutations.length > 0, "expected at least one AWS-touching step");
  for (const { name, index } of mutations) {
    assert.ok(index > credentials, `${name} runs before credentials are assumed`);
  }
});

test("the deploy job stages nothing after credentials are assumed", () => {
  // A checkout or artifact download placed later could swap the payload after
  // the point where the job is trusted, so keep source acquisition up front.
  const steps = workflow.jobs.deploy.steps.map((step) => step.name).filter(Boolean);
  const credentials = steps.findIndex((name) => /Configure AWS credentials/.test(name));
  for (const [index, name] of steps.entries()) {
    if (index <= credentials) continue;
    assert.ok(!/checkout|download/i.test(name), `${name} stages content after credentials`);
  }
});

test("the deploy job builds from this repository rather than a fetched artifact", () => {
  const runs = workflow.jobs.deploy.steps.map((step) => step.run || "").join("\n");
  assert.match(runs, /sam deploy/, "the deploy job must run sam deploy");
  assert.ok(!/sam package/.test(runs), "sam deploy must not be split into a package step");
});
