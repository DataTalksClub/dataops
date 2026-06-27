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
	npm ci
	npm run build
	cp -R dist "$(ARTIFACTS_DIR)/dist"
	cp package.json package-lock.json "$(ARTIFACTS_DIR)/"
	cd "$(ARTIFACTS_DIR)" && npm ci --omit=dev

typecheck:
	npm run typecheck

clean:
	npm run clean
