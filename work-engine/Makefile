.PHONY: run test test-e2e seed build clean typecheck build-WorkEngineFunction

run:
	npm run dev

test:
	npm test

test-e2e:
	npx playwright test

seed:
	npm run seed:users
	npm run seed

cron:
	npm run cron

build:
	npm run build

build-WorkEngineFunction:
	cd .. && npm ci
	cd .. && npm run build:work-engine
	mkdir -p "$(ARTIFACTS_DIR)/work-engine"
	cp -R dist "$(ARTIFACTS_DIR)/dist"
	cp ../package.json ../package-lock.json "$(ARTIFACTS_DIR)/"
	cp package.json "$(ARTIFACTS_DIR)/work-engine/package.json"
	cd "$(ARTIFACTS_DIR)" && npm ci --omit=dev --workspace dataops-work-engine

typecheck:
	npm run typecheck

clean:
	npm run clean
