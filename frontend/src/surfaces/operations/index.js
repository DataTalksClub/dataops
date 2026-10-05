import { createAdminSurface } from "./admin.js";
import { createDeviceAuthSurface } from "./device.js";
import { createAssistantsSurface } from "./assistants.js";

export { createAdminSurface };

export function createOperationsSurface(context) {
  const assistants = createAssistantsSurface(context);
  const device = createDeviceAuthSurface(context);

  return {
    refreshOperationsAssistantSnapshot:
      assistants.refreshOperationsAssistantSnapshot,
    renderAssistantsSurface: assistants.renderAssistantsSurface,
    renderDeviceSurfaceView: device.renderDeviceSurfaceView,
  };
}
