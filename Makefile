AWS_DEFAULT_REGION ?= eu-west-1
SAM_LOCAL_AWS_DIR := .tmp/aws-empty
SAM_LOCAL_AWS_CONFIG := $(SAM_LOCAL_AWS_DIR)/config
SAM_LOCAL_AWS_CREDENTIALS := $(SAM_LOCAL_AWS_DIR)/credentials

.PHONY: help setup dev-docs dev-frontend dev-work-engine seed-work-engine dev-compose search-index validate-docs-links validate-planning-docs sop-lint test-docs test-work-engine typecheck-work-engine build-work-engine test-work-engine-e2e test-assistant smoke-docs sam-local-aws-config sam-validate sam-build ci clean build-WorkEngineFunction

help:
	@printf '%s\n' 'DataOps development targets:'
	@printf '%s\n' ''
	@printf '%-28s %s\n' 'make setup' 'Install root npm workspace and Python project dependencies.'
	@printf '%-28s %s\n' 'make dev-docs' 'Run the docs portal Lambda local server in the foreground on port 8787.'
	@printf '%-28s %s\n' 'make dev-frontend' 'Run a static frontend server in the foreground on port 5173.'
	@printf '%-28s %s\n' 'make dev-work-engine' 'Run the work-engine dev server in the foreground on port 3000.'
	@printf '%-28s %s\n' 'make seed-work-engine' 'Seed local work-engine users and templates through the workspace script.'
	@printf '%-28s %s\n' 'make dev-compose' 'Run the current Docker Compose portal stack in the foreground.'
	@printf '%-28s %s\n' 'make search-index' 'Build .tmp/dataops-content-search.index from content/.'
	@printf '%-28s %s\n' 'make validate-docs-links' 'Validate content/process-doc links and workflow doc IDs.'
	@printf '%-28s %s\n' 'make validate-planning-docs' 'Run planning/process docs contract validation.'
	@printf '%-28s %s\n' 'make sop-lint FILES=...' 'Lint marked SOP files; FILES is required.'
	@printf '%-28s %s\n' 'make test-docs' 'Run docs portal pytest.'
	@printf '%-28s %s\n' 'make test-work-engine' 'Run work-engine unit tests.'
	@printf '%-28s %s\n' 'make typecheck-work-engine' 'Run work-engine TypeScript checks.'
	@printf '%-28s %s\n' 'make build-work-engine' 'Build work-engine TypeScript/package assets.'
	@printf '%-28s %s\n' 'make test-work-engine-e2e' 'Run work-engine Playwright E2E tests; browsers must be installed.'
	@printf '%-28s %s\n' 'make test-assistant' 'Run DataOps podcast assistant pytest.'
	@printf '%-28s %s\n' 'make smoke-docs' 'Run local docs Lambda handler/import smoke check.'
	@printf '%-28s %s\n' 'make sam-validate' 'Validate SAM template locally with empty AWS config; never deploys.'
	@printf '%-28s %s\n' 'make sam-build' 'Build the full-sandbox SAM artifact locally; never deploys.'
	@printf '%-28s %s\n' 'make ci' 'Run non-interactive deploy-workflow parity checks; no AWS deploy/cache refresh.'
	@printf '%-28s %s\n' 'make clean' 'Remove root generated search index and work-engine dist.'
	@printf '%s\n' ''
	@printf '%s\n' 'For Operations Home local proxy testing, use two terminals:'
	@printf '%s\n' '  1. make dev-work-engine'
	@printf '%s\n' '  2. WORK_ENGINE_DEV_URL=http://127.0.0.1:3000 make dev-docs'
	@printf '%s\n' 'Then run make dev-frontend in another terminal if you want frontend hot/static serving.'

setup:
	uv sync
	uv sync --project lambda-functions --extra search
	uv sync --project assistants/podcast
	npm ci

dev-docs:
	cd lambda-functions && uv run --extra search python -m lambda_functions.local_server --port 8787

dev-frontend:
	python3 -m http.server 5173 --directory frontend

dev-work-engine:
	npm run dev:work-engine

seed-work-engine:
	npm run seed:work-engine

dev-compose:
	docker compose up --build

.tmp:
	mkdir -p .tmp

search-index: .tmp
	cd lambda-functions && uv run --extra search python -m lambda_functions.build_search_index --docs-dir ../content --output ../.tmp/dataops-content-search.index

validate-docs-links:
	uv run --project lambda-functions --extra search python -m lambda_functions.validate_docs_links --repo-root . --content-root content

validate-planning-docs:
	uv run --with pytest python -m pytest tests/planning_docs

sop-lint:
	@if [ -z "$(strip $(FILES))" ]; then echo 'FILES is required. Usage: make sop-lint FILES="content/path/to/sop.md [...]"' >&2; exit 2; fi
	uv run --project lambda-functions python scripts/sop_lint.py $(FILES)

test-docs:
	uv run --project lambda-functions --extra search --with pytest python -m pytest tests/docs_app

test-work-engine:
	npm --prefix work-engine test

typecheck-work-engine:
	npm --prefix work-engine run typecheck

build-work-engine:
	npm --prefix work-engine run build

test-work-engine-e2e:
	npm --prefix work-engine run test:e2e

test-assistant:
	uv run --project assistants/podcast pytest

smoke-docs:
	cd lambda-functions && BASIC_AUTH_PASSWORD=smoke-test-password BASIC_AUTH_USERNAME=smoke-test-user uv run --extra search python -c 'from lambda_functions.full_app_handler import handler; login = handler({"rawPath": "/login", "requestContext": {"http": {"method": "GET"}}}, None); assert login["statusCode"] == 200, login; protected = handler({"rawPath": "/", "requestContext": {"http": {"method": "GET"}}}, None); assert protected["statusCode"] == 302, protected; assert protected["headers"]["location"] == "/login", protected'

sam-local-aws-config: .tmp
	mkdir -p $(SAM_LOCAL_AWS_DIR)
	: > $(SAM_LOCAL_AWS_CONFIG)
	: > $(SAM_LOCAL_AWS_CREDENTIALS)

sam-validate: sam-local-aws-config
	cd lambda-functions && AWS_CONFIG_FILE=../$(SAM_LOCAL_AWS_CONFIG) AWS_SHARED_CREDENTIALS_FILE=../$(SAM_LOCAL_AWS_CREDENTIALS) AWS_EC2_METADATA_DISABLED=true AWS_DEFAULT_REGION=$(AWS_DEFAULT_REGION) sam validate --template-file template.full.yaml

sam-build:
	cd lambda-functions && sam build --config-env full-sandbox

ci:
	$(MAKE) validate-docs-links
	$(MAKE) test-docs
	$(MAKE) test-work-engine
	$(MAKE) typecheck-work-engine
	$(MAKE) search-index
	$(MAKE) smoke-docs
	$(MAKE) sam-validate
	$(MAKE) sam-build

clean:
	rm -f .tmp/dataops-content-search.index
	npm run clean:work-engine

build-WorkEngineFunction:
	npm ci
	npm run build:work-engine
	mkdir -p "$(ARTIFACTS_DIR)/work-engine"
	cp -R work-engine/dist "$(ARTIFACTS_DIR)/dist"
	cp package.json package-lock.json "$(ARTIFACTS_DIR)/"
	cp work-engine/package.json "$(ARTIFACTS_DIR)/work-engine/package.json"
	cd "$(ARTIFACTS_DIR)" && npm ci --omit=dev --workspace dataops-work-engine
