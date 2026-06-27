# Lambda Functions

The Python backend that powers the docs editor and search.

Deployable functions:

- `DocsFullAppFunction` (`lambda_functions.full_app_handler`) — protected
  frontend, docs editing API, GitHub-backed persistence, and same-origin
  `/search`.
- `DocsApiFunction` (`lambda_functions.api_handler`) — docs CRUD,
  structured SOP parsing/linting, image upload, folder ops, backlinks.

For local development the frontend container also proxies `/git/*`
endpoints (status/commit/pull/log) that aren't part of the deployed
lambda — they exist only in `scripts/serve_frontend.py`.

## Endpoints (api_handler)

- `GET /docs`: List all docs under `CONTENT_ROOT`. Returns title, summary,
  stable ID, aliases, title, summary, doc_type, domain, tags, systems,
  related docs, and updated timestamp.
- `GET /docs/registry`: List canonical document registry records for all
  Markdown docs under `CONTENT_ROOT`.
- `GET /docs/resolve?ref=<ref>`: Resolve a canonical ID, alias, repo-relative
  path, visible `/path.md`, `doc:id`, or `[[wiki-ref]]` to one registry record.
- `GET /docs?path=<p>`: Read a single doc. Returns `content`, `updated`, and
  `parsed` for structured SOP trees where applicable.
- `PUT /docs?path=<p>`: Save a doc body. Body: `{"content": "..."}`. Returns
  mtime and any lint `warnings`.
- `POST /docs`: Create a new doc. Body: `{path, title, doc_type, summary,
  scaffold}`. SOP/checklist docs get the marker scaffold, full or minimal.
- `DELETE /docs?path=<p>`: Remove a doc file and prune now-empty parent dirs.
- `POST /docs/rename`: Rename a doc. Body: `{old_path, new_path}`. Both paths
  are validated to live under `content/`.
- `GET /docs/backlinks?path=<p>`: Return docs that link to the target through a
  markdown link.
- `DELETE /folders?path=<p>`: Recursively remove a content subfolder.
- `POST /folders/rename`: Move an entire subtree. Body: `{old_path, new_path}`.
- `POST /images`: Save an uploaded image under `content/images/<slug>/`. Body:
  `{doc_path, filename, data(base64)}`. Returns a relative path.
- `GET /lint`: Scan every `schema_version: 1` doc and return violations per
  file.
- `POST /parse`: Parse a document body. Body: `{content}`. Returns the parsed
  SOP tree or a parse error.
- `GET /search?q=<q>`: Full-text search. In production this is served by the
  protected full app Lambda, which builds the `minsearch` index from the
  GitHub-backed content cache.

## Endpoints (frontend dev server)

These live in `scripts/serve_frontend.py` and are local-only:

- `GET /git/status`: Branch, porcelain file list, origin remote, and derived
  `https://github.com/...` URL.
- `POST /git/commit`: Commit and optionally push local changes. Body:
  `{message?, push?}`.
- `POST /git/pull`: Run `git pull --ff-only`.
- `GET /git/log`: With `?path=<p>`, return the last 10 commits touching that
  file.
- `GET /content/...`: Serve image and asset files from the host's `content/`
  directory, mounted read-only.

## Local development

```bash
docker compose up --build
```

The compose stack:

- `frontend` (port 5173) — uvicorn-served ASGI app from
  `scripts/serve_frontend.py`. Mounts `./frontend` and `./content` read-only,
  the host `~/.ssh` and `~/.gitconfig` for git push, and the full repo at
  `/app/repo` so git can read history.
- `lambda-functions` (port 8787) — runs the real Lambda code locally
  through `local_server.py`. Builds the search index on startup.

The frontend proxies any `/docs`, `/search`, `/health`, `/images`, `/folders`,
`/lint`, or `/parse` request to the lambda upstream over the docker network,
so the browser only ever talks to port 5173.

## Build the search index manually

```bash
cd lambda-functions
uv run --extra search python -m lambda_functions.build_search_index --docs-dir ../content
```

## Run a single search handler smoke test

```bash
uv run --extra search python - <<'PY'
from lambda_functions.search_handler import handler
print(handler({"queryStringParameters": {"q": "invoice", "limit": "3"}}, None))
PY
```

## SOP parser + linter

The structured-SOP parser and linter ship inside `lambda_functions/`:

- `lambda_functions.sop_parse.parse(text)` → dict
- `lambda_functions.sop_lint.lint_text(text)` → list[str] violations

The CLI shims in `scripts/sop_parse.py`, `scripts/sop_lint.py`, and
`scripts/sop_normalize.py` import from the same module. CI can call
`scripts/sop_lint.py path/to/file.md` to validate.

## Deploy

```bash
aws cloudformation deploy \
  --template-file template.github-actions-dataops.yaml \
  --stack-name dataops-v1-github-actions \
  --capabilities CAPABILITY_NAMED_IAM

aws cloudformation deploy \
  --template-file template.runtime-secrets.yaml \
  --stack-name dataops-v1-runtime-secrets \
  --parameter-overrides \
    GitHubToken=... \
    BasicAuthPassword=... \
  --capabilities CAPABILITY_IAM

sam build --template-file template.api.yaml
sam deploy --template-file .aws-sam/build/template.yaml --stack-name dataops-v1-api

sam build --config-env full-sandbox
sam deploy --config-env full-sandbox
```

If SAM is not installed locally, the existing sandbox Lambda can be updated
with the Python helper from the repository root:

```bash
python scripts/deploy_full_lambda.py
```

The GitHub Actions OIDC provider and deploy role are managed by
`template.github-actions.yaml`. The workflows use the role ARN directly, so
the deploy role is not a GitHub secret.

Required repository secrets for the API workflow:

- `GITHUB_TOKEN_SECRET_ARN`

The full app GitHub token and basic-auth password are stored in AWS Secrets
Manager, managed by `template.runtime-secrets.yaml`:

- `dataops-v1/full-app/github-token`
- `dataops-v1/full-app/basic-auth-password`

The full app Lambda reads these secrets at runtime. GitHub Actions does not
store or pass either runtime secret.

Optional repository variables:

- `AWS_REGION` (default `eu-central-1`, used by the API workflow)
- `API_STACK_NAME` (default `dataops-v1-api`)
- `DOCS_GITHUB_OWNER` (default `DataTalksClub`)
- `DOCS_GITHUB_REPO` (default `dataops`)
- `DOCS_GITHUB_BRANCH` (default `main`)
- `ALLOWED_EMAIL_DOMAIN` (default `datatalks.club`)
- `FULL_APP_BASIC_AUTH_USERNAME` (default `admin`)

The full protected docs app workflow deploys the `full-sandbox` SAM config,
which targets the `dataops-v1` stack in `eu-west-1`.
