.PHONY: build-McpFunction

# SAM runs this target with ARTIFACTS_DIR set. The runtime has no npm dependencies.
build-McpFunction:
	@test -n "$(ARTIFACTS_DIR)" || { printf '%s\n' 'ARTIFACTS_DIR is required'; exit 2; }
	mkdir -p "$(ARTIFACTS_DIR)/src"
	cp src/lambda.mjs src/proxy.mjs src/tools.mjs "$(ARTIFACTS_DIR)/src/"
