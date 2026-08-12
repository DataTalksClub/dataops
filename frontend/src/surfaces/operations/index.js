import { createAdminSurface } from "./admin.js";
import { createArtifactsSurface } from "./artifacts.js";
import { createAssistantsSurface } from "./assistants.js";
import { createInboxActions } from "./inbox-actions.js";
import { createInboxSurface } from "./inbox.js";

export { createAdminSurface };

export function createOperationsSurface(context) {
  let inbox;
  let inboxActions;
  const delegated = {
    intakeActionMarkup: (...args) => inboxActions.intakeActionMarkup(...args),
    refreshIntakeSnapshot: (...args) => inbox.refreshIntakeSnapshot(...args),
    renderInboxSurface: (...args) => inbox.renderInboxSurface(...args),
    renderIntakeHistoryMarkup: (...args) =>
      inboxActions.renderIntakeHistoryMarkup(...args),
    submitIntakeAction: (...args) => inboxActions.submitIntakeAction(...args),
  };

  inboxActions = createInboxActions({ ...context, ...delegated });
  inbox = createInboxSurface({
    ...context,
    ...delegated,
    ...inboxActions,
  });
  const assistants = createAssistantsSurface(context);
  const artifacts = createArtifactsSurface(context);

  return {
    refreshIntakeSnapshot: inbox.refreshIntakeSnapshot,
    refreshOperationsArtifactSnapshot:
      artifacts.refreshOperationsArtifactSnapshot,
    refreshOperationsAssistantSnapshot:
      assistants.refreshOperationsAssistantSnapshot,
    renderArtifactsSurface: artifacts.renderArtifactsSurface,
    renderAssistantsSurface: assistants.renderAssistantsSurface,
    renderInboxSurface: inbox.renderInboxSurface,
    resolveIntakeRouteEntity: inbox.resolveIntakeRouteEntity,
  };
}
