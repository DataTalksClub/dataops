import { createAdminSurface } from "./admin.js";
import { createAssistantsSurface } from "./assistants.js";

export { createAdminSurface };

export function createOperationsSurface(context) {
  const assistants = createAssistantsSurface(context);

  return {
    refreshOperationsAssistantSnapshot:
      assistants.refreshOperationsAssistantSnapshot,
    renderAssistantsSurface: assistants.renderAssistantsSurface,
  };
}
