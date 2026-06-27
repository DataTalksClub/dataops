.PHONY: build-DocsApiFunction build-DocsFullAppFunction

LAMBDA_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
CONTENT_DIR := $(abspath $(LAMBDA_DIR)/../content)
FRONTEND_DIR := $(abspath $(LAMBDA_DIR)/../frontend)

build-DocsApiFunction:
	uv pip install --target "$(ARTIFACTS_DIR)" .
	rm -f "$(ARTIFACTS_DIR)/lambda_functions/search.index"

build-DocsFullAppFunction:
	uv pip install --target "$(ARTIFACTS_DIR)" ".[search]"
	cp -R "$(FRONTEND_DIR)" "$(ARTIFACTS_DIR)/frontend"
	rm -f "$(ARTIFACTS_DIR)/lambda_functions/search.index"
