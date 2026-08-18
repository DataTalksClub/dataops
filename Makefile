AWS_DEFAULT_REGION ?= eu-west-1
SAM_LOCAL_AWS_DIR := .tmp/aws-empty
SAM_LOCAL_AWS_CONFIG := $(SAM_LOCAL_AWS_DIR)/config
SAM_LOCAL_AWS_CREDENTIALS := $(SAM_LOCAL_AWS_DIR)/credentials

.PHONY: help setup dev-frontend dev-compose dev search-index validate-planning-docs sop-lint test-frontend-unit test-frontend-coverage test-backend typecheck-backend build-backend test-backend-e2e test-assistant sam-local-aws-config sam-validate sam-build test-sam-workspace-isolation verify-sam-frontend verify-sam-runtime-boundary test-sam-frontend-isolation ci clean

help:
	@printf '%s\n' 'DataOps development targets:'
	@printf '%s\n' ''
	@printf '%-28s %s\n' 'make setup' 'Install root npm workspace and Python project dependencies.'
	@printf '%-28s %s\n' 'make dev-frontend' 'Run a static frontend server in the foreground on port 5173.'
	@printf '%-28s %s\n' 'make dev' 'Run the consolidated backend (frontend + docs + work) on port 3000.'
	@printf '%-28s %s\n' 'make dev-compose' 'Run the current Docker Compose portal stack in the foreground.'
	@printf '%-28s %s\n' 'make validate-planning-docs' 'Run planning/process docs contract validation.'
	@printf '%-28s %s\n' 'make sop-lint FILES=...' 'Lint marked SOP files; FILES is required.'
	@printf '%-28s %s\n' 'make test-frontend-unit' 'Run fast frontend routing and work-model unit tests.'
	@printf '%-28s %s\n' 'make test-frontend-coverage' 'Run frontend unit tests with all production modules in coverage.'
	@printf '%-28s %s\n' 'make test-backend' 'Run backend unit tests.'
	@printf '%-28s %s\n' 'make typecheck-backend' 'Run backend TypeScript checks.'
	@printf '%-28s %s\n' 'make build-backend' 'Build backend TypeScript/package assets.'
	@printf '%-28s %s\n' 'make test-backend-e2e' 'Run backend Playwright E2E tests; browsers must be installed.'
	@printf '%-28s %s\n' 'make test-assistant' 'Run DataOps podcast assistant pytest.'
	@printf '%-28s %s\n' 'make sam-validate' 'Validate SAM template locally with empty AWS config; never deploys.'
	@printf '%-28s %s\n' 'make sam-build' 'Build the full-sandbox SAM artifact locally; never deploys.'
	@printf '%-28s %s\n' 'make test-sam-workspace-isolation' 'Run one clean SAM build beside fresh root dependency imports.'
	@printf '%-28s %s\n' 'make verify-sam-frontend' 'Verify canonical frontend bytes in the existing SAM artifact.'
	@printf '%-28s %s\n' 'make verify-sam-runtime-boundary' 'Verify the existing SAM artifact contains no local infrastructure code.'
	@printf '%-28s %s\n' 'make test-sam-frontend-isolation' 'Run the existing SAM artifact in frontend isolation; never rebuilds.'
	@printf '%-28s %s\n' 'make ci' 'Run non-interactive deploy-workflow parity checks; no AWS deploy/cache refresh.'
	@printf '%-28s %s\n' 'make clean' 'Remove root generated search index and work-engine dist.'
	@printf '%-28s %s\n' 'make clean' 'Remove root generated search index and backend dist.'
	@printf '%s\n' ''
	@printf '%s\n' 'Local dev is a single backend (frontend + docs + work): make dev'

setup:
	uv sync --project assistants/podcast
	npm ci

dev-frontend:
	python3 -m http.server 5173 --directory frontend

seed-backend:
	npm run seed:backend

dev-compose:
	docker compose up --build

# Consolidated dev: one origin (port 3000) serves the frontend + docs API + work
# APIs through the same supervisor used by `npm run dev`. Local configuration is
# read from the ignored root `.env`; explicit shell values still take precedence.
dev:
	npm run dev

.tmp:
	mkdir -p .tmp

validate-planning-docs:
	uv run --with pytest python -m pytest tests/planning_docs

sop-lint:
	@if [ -z "$(strip $(FILES))" ]; then echo 'FILES is required. Usage: make sop-lint FILES="content/path/to/sop.md [...]"' >&2; exit 2; fi
	npx --prefix backend tsx backend/scripts/sop.ts lint $(FILES)

test-backend:
	npm --prefix backend test

test-frontend-unit:
	npm run test:frontend:unit

test-frontend-coverage:
	npm run test:frontend:coverage

typecheck-backend:
	npm --prefix backend run typecheck

build-backend:
	npm --prefix backend run build

test-backend-e2e:
	npm --prefix backend run test:e2e

test-assistant:
	uv run --project assistants/podcast pytest

sam-local-aws-config: .tmp
	mkdir -p $(SAM_LOCAL_AWS_DIR)
	: > $(SAM_LOCAL_AWS_CONFIG)
	: > $(SAM_LOCAL_AWS_CREDENTIALS)

sam-validate: sam-local-aws-config
	AWS_CONFIG_FILE=$(SAM_LOCAL_AWS_CONFIG) AWS_SHARED_CREDENTIALS_FILE=$(SAM_LOCAL_AWS_CREDENTIALS) AWS_EC2_METADATA_DISABLED=true AWS_DEFAULT_REGION=$(AWS_DEFAULT_REGION) sam validate --template-file infra/template.full.yaml

sam-build:
	DATAOPS_REPO_ROOT="$(CURDIR)" sam build --parallel --config-env full-sandbox $(if $(SAM_BUILD_DIR),--build-dir "$(SAM_BUILD_DIR)",)

test-sam-workspace-isolation:
	node backend/scripts/sam-workspace-isolation.test.mjs

verify-sam-frontend:
	node backend/scripts/verify-frontend-artifact.mjs --source frontend --artifact .aws-sam/build/BackendFunction

verify-sam-runtime-boundary:
	node backend/scripts/verify-runtime-boundary.mjs .aws-sam/build/BackendFunction

test-sam-frontend-isolation:
	node --test backend/scripts/frontend-artifact.test.mjs

ci:
	$(MAKE) test-frontend-coverage
	$(MAKE) test-backend
	$(MAKE) typecheck-backend
	$(MAKE) build-backend
	$(MAKE) sam-validate
	$(MAKE) sam-build
	$(MAKE) verify-sam-frontend
	$(MAKE) verify-sam-runtime-boundary
	$(MAKE) test-sam-frontend-isolation

clean:
	rm -f .tmp/dataops-content-search.index
	npm run clean:backend
