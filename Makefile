.PHONY: build-WorkEngineFunction

build-WorkEngineFunction:
	npm ci
	npm run build:work-engine
	mkdir -p "$(ARTIFACTS_DIR)/work-engine"
	cp -R work-engine/dist "$(ARTIFACTS_DIR)/dist"
	cp package.json package-lock.json "$(ARTIFACTS_DIR)/"
	cp work-engine/package.json "$(ARTIFACTS_DIR)/work-engine/package.json"
	cd "$(ARTIFACTS_DIR)" && npm ci --omit=dev --workspace dataops-work-engine
