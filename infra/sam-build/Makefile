SAM_FUNCTION_BUILD_TARGETS := build-BackendFunction build-ConversationalExecutionWorkerFunction build-ConversationalResultDispatcherFunction build-SponsorSendWorkerFunction build-SponsorSesEventFunction build-SponsorPrivateArchiveFunction

.PHONY: $(SAM_FUNCTION_BUILD_TARGETS)

$(SAM_FUNCTION_BUILD_TARGETS):
	@test -n "$(DATAOPS_REPO_ROOT)" || { printf '%s\n' 'DATAOPS_REPO_ROOT is required; run make sam-build from the repository root.' >&2; exit 2; }
	node "$(DATAOPS_REPO_ROOT)/backend/scripts/build-sam-artifact.mjs" "$(ARTIFACTS_DIR)"
