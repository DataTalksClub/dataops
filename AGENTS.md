# Agent Notes

Read `_docs/PROCESS.md` before working on issues.

When launching subagents for this workflow, use high-capability/high-reasoning
settings by default unless the user explicitly asks for a cheaper or lower
reasoning run.

Treat "continue where we stopped" as a prompt to check `_docs/PROCESS.md`,
inspect the current issue/worktree/process state, and resume the next pipeline
step.

This repo uses GitHub Issues in `DataTalksClub/dataops` as the work tracker.
The orchestrator files raw user requests as issues with `needs grooming`, then
role agents move each issue through the pipeline.

Operational knowledge boundary:

- `DataTalksClub/dataops` stays public and owns product/runtime code, CI/CD,
  tests, schemas, sanitized fixtures, and public-safe planning docs.
- Operational documents and knowledge belong in a separate private repository.
  The planned repo name is `DataTalksClub/dataops-knowledge`.
- Do not add raw SOPs, workflow templates, assistant prompts/process
  instructions, screenshots, private links, credentials-adjacent setup notes,
  contact details, sponsor or finance context, or generated operational
  artifacts to this public repo.
- Existing `content/` material in this repo is transitional migration debt.
  Treat it as public-sensitive until it is audited and moved behind the private
  knowledge boundary.

Current planning docs:

- `_docs/MERGE_PLAN.md`
- `_docs/PROCESS.md`
- `PORTAL_ANALYSIS.md`
- `PROJECT_PLAN.md`

AWS infrastructure source:

- Shared sandbox AWS infrastructure lives one level up in `../aws-infra/`.
- DataOps-specific sandbox infra is in `../aws-infra/sandbox/dataops/`.
- The GitHub Actions OIDC deploy role template is
  `../aws-infra/sandbox/dataops/template.github-actions.yaml`.
- `aws-infra` does not currently deploy itself through CI/CD. If that template
  changes, committing/pushing it is not enough; a credentialed AWS operator must
  apply the `dataops-github-actions` CloudFormation stack.
- The DataOps app itself deploys through this repo's GitHub Actions CI/CD using
  OIDC after `main` is pushed. Do not replace that with a normal manual app
  deploy.

Initial source systems:

- `../dtc-operations`
- `../datatasks`
- `../podcast-assistant`

Do not modify those source repos while working in `dataops` unless the issue
explicitly asks for it.
