AWS_DEFAULT_REGION ?= eu-west-1
SAM_LOCAL_AWS_DIR := .tmp/aws-empty
SAM_LOCAL_AWS_CONFIG := $(SAM_LOCAL_AWS_DIR)/config
SAM_LOCAL_AWS_CREDENTIALS := $(SAM_LOCAL_AWS_DIR)/credentials

.PHONY: help setup dev-frontend dev-compose dev search-index validate-planning-docs sop-lint test-backend typecheck-backend build-backend test-backend-e2e test-assistant sam-local-aws-config sam-validate sam-build ci clean build-BackendFunction

help:
	@printf '%s\n' 'DataOps development targets:'
	@printf '%s\n' ''
	@printf '%-28s %s\n' 'make setup' 'Install root npm workspace and Python project dependencies.'
	@printf '%-28s %s\n' 'make dev-frontend' 'Run a static frontend server in the foreground on port 5173.'
	@printf '%-28s %s\n' 'make dev' 'Run the consolidated backend (frontend + docs + work) on port 3000.'
	@printf '%-28s %s\n' 'make dev-compose' 'Run the current Docker Compose portal stack in the foreground.'
	@printf '%-28s %s\n' 'make validate-planning-docs' 'Run planning/process docs contract validation.'
	@printf '%-28s %s\n' 'make sop-lint FILES=...' 'Lint marked SOP files; FILES is required.'
	@printf '%-28s %s\n' 'make test-backend' 'Run backend unit tests.'
	@printf '%-28s %s\n' 'make typecheck-backend' 'Run backend TypeScript checks.'
	@printf '%-28s %s\n' 'make build-backend' 'Build backend TypeScript/package assets.'
	@printf '%-28s %s\n' 'make test-backend-e2e' 'Run backend Playwright E2E tests; browsers must be installed.'
	@printf '%-28s %s\n' 'make test-assistant' 'Run DataOps podcast assistant pytest.'
	@printf '%-28s %s\n' 'make sam-validate' 'Validate SAM template locally with empty AWS config; never deploys.'
	@printf '%-28s %s\n' 'make sam-build' 'Build the full-sandbox SAM artifact locally; never deploys.'
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
# API from the TypeScript backend, with backend hot-reload (tsx watch). Reads docs
# live from ./content (offline mode, no GitHub/token); auth runs open. For full
# GitHub-backed mode (commit-on-save), drop DTC_OFFLINE and set
# GITHUB_TOKEN=$$(gh auth token).
dev:
	@mkdir -p .tmp/dev-portal
	@ln -sfn $(CURDIR)/content .tmp/dev-portal/content
	DTC_OFFLINE=1 DATAOPS_DOCS_DOMAIN=1 DTC_CACHE_ROOT=$(CURDIR)/.tmp/dev-portal FRONTEND_ROOT=$(CURDIR)/frontend SKIP_AUTH=true npm --prefix backend run dev

.tmp:
	mkdir -p .tmp

validate-planning-docs:
	uv run --with pytest python -m pytest tests/planning_docs

sop-lint:
	@if [ -z "$(strip $(FILES))" ]; then echo 'FILES is required. Usage: make sop-lint FILES="content/path/to/sop.md [...]"' >&2; exit 2; fi
	npx --prefix backend tsx backend/scripts/sop.ts lint $(FILES)

test-backend:
	npm --prefix backend test

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
	sam build --config-env full-sandbox

ci:
	$(MAKE) test-backend
	$(MAKE) typecheck-backend
	$(MAKE) build-backend
	$(MAKE) sam-validate
	$(MAKE) sam-build

clean:
	rm -f .tmp/dataops-content-search.index
	npm run clean:backend

build-BackendFunction:
	npm ci
	npm run build:backend
	mkdir -p "$(ARTIFACTS_DIR)/backend"
	cp -R backend/dist "$(ARTIFACTS_DIR)/dist"
	cp package.json package-lock.json "$(ARTIFACTS_DIR)/"
	cp backend/package.json "$(ARTIFACTS_DIR)/backend/package.json"
	cp -R backend/vendor "$(ARTIFACTS_DIR)/backend/vendor"
	cd "$(ARTIFACTS_DIR)" && npm ci --omit=dev --workspace dataops-backend
	rm -rf "$(ARTIFACTS_DIR)/node_modules/zerosearch-node"
	cp -R backend/vendor/zerosearch-node "$(ARTIFACTS_DIR)/node_modules/zerosearch-node"
