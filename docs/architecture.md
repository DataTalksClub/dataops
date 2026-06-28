---
title: "Architecture"
summary: "Explains the deployed docs app architecture, content lifecycle, CI/CD split, and recommended upgrade path."
doc_type: reference
tags: []
systems:
  - aws
  - github
related_docs: []
---

# Architecture

## Summary

The docs app is a protected Lambda-hosted editor for internal DataTalks.Club
operations docs. The important design choice is that GitHub stays the source of
truth for content. Lambda is a runtime editor and cache, not a permanent
filesystem.

The current recommendation is to keep the sandbox lightweight:

- One full docs Lambda for frontend, editing API, and search.
- GitHub for durable markdown storage and review history.
- AWS Secrets Manager for runtime secrets.
- GitHub Actions OIDC for deploy credentials.
- No SQLite, no EC2, no EFS until we have a concrete need for shared warm-cache
  state or larger mutable runtime storage.

## Runtime Architecture

```mermaid
flowchart TB
  User[User browser] -->|HTTPS Lambda Function URL| FullApp[DocsFullAppFunction]
  FullApp -->|serves| Frontend[frontend/index.html and assets]
  FullApp -->|routes /docs, /folders, /images, /lint, /parse| DocsApi[Docs API]
  FullApp -->|routes /search| Search[Search handler]
  DocsApi --> Cache[/Lambda /tmp GitHub content cache/]
  Search --> Index[/Lambda /tmp dtc-search.index/]
  FullApp -->|download tarball, read blobs, write contents| GitHub[(GitHub repo)]
  FullApp -->|GetSecretValue| Secrets[AWS Secrets Manager]
  Actions[GitHub Actions] -->|AssumeRoleWithWebIdentity| DeployRole[AWS deploy role]
  DeployRole --> CloudFormation[CloudFormation and SAM]
  CloudFormation --> FullApp
```

The deployed function is `DocsFullAppFunction`, implemented by
`lambda_functions.full_app_handler`. It owns:

- Basic-auth protected frontend serving.
- Docs CRUD and structured-SOP parsing/linting.
- GitHub-backed persistence.
- Search through a `minsearch` index.
- Compatibility `/git/*` endpoints used by the frontend.
- Same-origin `/work/api/*` brokering to the private work-engine Lambda.

The Lambda Function URL is public at the AWS edge, but the app requires its own
basic-auth session before serving internal docs or work routes. The password is
stored in AWS Secrets Manager. V1 has no public work-engine URL: the browser
uses the portal session cookie, and the Python portal invokes the private
work-engine Lambda with trusted portal headers and a SAM-owned Secrets Manager
shared secret.

## Content Save Lifecycle

When a user edits a page in the deployed app, the content path is:

```mermaid
sequenceDiagram
  participant U as Browser
  participant L as Full docs Lambda
  participant T as Lambda /tmp cache
  participant G as GitHub Contents API
  participant I as /tmp search index

  U->>L: PUT /docs?path=content/... with markdown
  L->>T: Write markdown into local cache
  L->>G: PUT /repos/.../contents/content/...
  G-->>L: Commit created on main
  L->>L: Refresh GitHub tree cache
  L->>I: Rebuild minsearch index
  L-->>U: Save response with lint warnings, if any
```

This means clicking `Save` in production already publishes the document to
GitHub. The old local `Commit & push` workflow is still useful in local
development, but in deployed Lambda `/git/commit` is compatibility behavior and
returns that changes are committed automatically.

A content edit made through the UI creates a GitHub commit with a message like:

```text
Update content/community/slack/sops/example.md
```

Images and folder operations follow the same principle: Lambda mutates its
local cache first, then writes or deletes the corresponding files through the
GitHub API.

## Startup and Refresh Lifecycle

```mermaid
sequenceDiagram
  participant L as Full docs Lambda
  participant G as GitHub
  participant T as Lambda /tmp cache
  participant I as Search index

  L->>G: Download repository tarball for configured branch
  G-->>L: Tarball
  L->>T: Extract content/**/*.md
  L->>I: Build minsearch index
```

On cold start, or after an explicit `/git/pull`, Lambda downloads markdown from
GitHub and rebuilds the search index. On a warm instance, content edited by that
same instance is immediately visible because it rebuilds the index after save.

For content commits made outside a warm Lambda instance, the content-validation
workflow calls the deployed Lambda after validation succeeds. The workflow uses
GitHub OIDC to assume the AWS deploy role and invokes Lambda directly with an
internal `/admin/refresh` event. That avoids storing the app password in GitHub
Actions and avoids redeploying code for content-only changes.

## CI/CD Split

The repository has two different lifecycles.

Content-only changes should be cheap and fast:

```mermaid
flowchart LR
  ContentPush[Push content/**] --> Validate[Validate Docs Content workflow]
  Validate --> BuildIndex[Build minsearch index]
  BuildIndex --> Smoke[Smoke test search handler]
  Smoke --> OIDC[Assume AWS OIDC role]
  OIDC --> Refresh[Invoke /admin/refresh directly]
  Refresh --> Done[No Lambda deploy]
```

App or infrastructure changes need the full deployment path:

```mermaid
flowchart LR
  CodePush[Push app/infra/test paths] --> Tests[Docs app tests]
  Tests --> IndexCheck[Build search index]
  IndexCheck --> HandlerSmoke[Full app handler smoke test]
  HandlerSmoke --> SamValidate[SAM validate/build]
  SamValidate --> OIDC[Assume AWS OIDC deploy role]
  OIDC --> Deploy[SAM deploy full Lambda stack]
```

Current workflows:

- `.github/workflows/validate-dataops-content.yml`
  - Runs for `content/**` changes.
  - Builds the search index from `content/`.
  - Smoke-tests search against the generated index.
  - On pushes with changed content files, assumes the AWS OIDC deploy role and
    directly invokes the deployed Lambda refresh endpoint.
  - Does not deploy Lambda code.
- `.github/workflows/deploy-dataops-v1.yml`
  - Runs for frontend, Lambda, infra, package, deploy script, and docs-app test
    changes.
  - Runs tests and deploys the full app Lambda stack if checks pass.
- `lambda-functions/template.api.yaml`
  - Legacy or separate API Lambda deploy path retained for compatibility.

## Credentials and CloudFormation

Deployment credentials are managed through CloudFormation, not manually through
long-lived AWS keys in GitHub.

```mermaid
flowchart TB
  CFN[template.github-actions-dataops.yaml] --> OIDCProvider[GitHub OIDC provider]
  CFN --> Role[dataops-v1 GitHub Actions deploy role]
  GitHubActions[GitHub Actions] -->|OIDC token| Role
  Role -->|limited deploy permissions| SAM[SAM deploy]
```

Runtime secrets are also managed through CloudFormation:

- `template.runtime-secrets.yaml` creates or updates the AWS Secrets Manager
  secrets.
- `template.full.yaml` gives the full docs Lambda permission to read only those
  secrets.
- GitHub Actions does not store the full-app GitHub token or basic-auth
  password.

The main runtime secrets are:

- `dataops-v1/full-app/github-token`
- `dataops-v1/full-app/basic-auth-password`

## Why Not EFS Right Now

EFS would give Lambda a persistent shared filesystem. That can be useful if we
need shared mutable state across warm instances, larger caches, or files that
should survive Lambda recycling without going through GitHub.

For this app, EFS is not currently worth the operational weight:

- GitHub already provides durable content storage and history.
- The search index is small enough to rebuild quickly.
- Lambda `/tmp` is enough for the markdown cache and generated index.
- EFS adds VPC configuration, mount targets, security groups, and extra cost.

The right trigger for reconsidering EFS is evidence that cold-start downloads or
index rebuilds are too slow, or that we need a shared runtime cache independent
from GitHub.

## Recommended Upgrade Path

1. Harden content refresh observability.
   The content workflow now refreshes the deployed Lambda after validation. The
   next improvement is to expose refresh duration, indexed document count, and
   the source Git commit in workflow logs or Lambda logs.

2. Add stricter content validation.
   The content workflow can run SOP linting across changed files, check broken
   internal links, and verify wiki-style links such as `[[slack-export-dump]]`.

3. Keep app deploys separate from content deploys.
   Code changes should run the full tests and SAM deploy. Content changes should
   validate content and refresh runtime state.

4. Move account-specific values to CloudFormation parameters.
   This makes migration from sandbox to the production AWS account reproducible:
   deploy the OIDC stack, deploy runtime secrets, then deploy the full app stack.

5. Revisit stronger access control when needed.
   Basic auth is lightweight and cheap. If the docs become broader or more
   sensitive, the next step is usually CloudFront plus auth at the edge, an
   identity-aware proxy, or a private network path. That adds cost and moving
   parts, so it should be a deliberate upgrade.

## Migration Checklist for a New AWS Account

1. Deploy `lambda-functions/template.github-actions.yaml`.
   This creates the GitHub Actions OIDC provider and deploy role.

2. Deploy `lambda-functions/template.runtime-secrets.yaml`.
   Provide the GitHub token and basic-auth password as parameters.

3. Update workflow role ARN if the deploy role ARN changes.

4. Deploy the full app stack with `sam deploy --config-env full-sandbox`, or add
   a new SAM config for the target account and environment.

5. Verify:
   - Login works.
   - A document page loads by path.
   - Search returns results.
   - Saving a test document creates a GitHub commit.
   - Refresh pulls the latest GitHub content.

## Open Design Decisions

- Whether content-only CI should call a refresh endpoint automatically.
- Whether document saves should commit directly to `main` forever, or move to a
  branch and pull-request model.
- Whether the legacy separate API Lambda should remain, or the full app Lambda
  should be the only production surface.
- Whether basic auth is enough for production, or access should move behind a
  stronger identity layer.
