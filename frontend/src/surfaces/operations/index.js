import { createAdminSurface } from "./admin.js";
import { createDeviceAuthSurface } from "./device.js";
import { createArtifactsSurface } from "./artifacts.js";
import { createAssistantsSurface } from "./assistants.js";

export { createAdminSurface };

export function createOperationsSurface(context) {
  const assistants = createAssistantsSurface(context);
  const artifacts = createArtifactsSurface(context);
  const device = createDeviceAuthSurface(context);

  return {
    refreshOperationsArtifactSnapshot:
      artifacts.refreshOperationsArtifactSnapshot,
    refreshOperationsAssistantSnapshot:
      assistants.refreshOperationsAssistantSnapshot,
    renderArtifactsSurface: artifacts.renderArtifactsSurface,
    renderAssistantsSurface: assistants.renderAssistantsSurface,
    renderDeviceSurfaceView: device.renderDeviceSurfaceView,
  };
}
