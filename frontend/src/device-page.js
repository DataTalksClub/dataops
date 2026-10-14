import "./dakit/shell.js";
import "./dakit/dialogs.js";
import { createDevicePage } from "./surfaces/operations/device.js";

async function request(path, options = {}) {
  const response = await fetch(`/work${path}`, {
    ...options,
    cache: "no-store",
    headers: { "content-type": "application/json" },
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = new Error("Device request failed");
    error.status = response.status;
    error.retryAfter = Number(response.headers.get("retry-after")) || 60;
    throw error;
  }
  // HTTP Date is the server clock; the API body remains unchanged.
  const serverNow = Date.parse(response.headers.get("date"));
  return {
    ...data,
    serverNow: Number.isFinite(serverNow) ? serverNow : Date.now(),
  };
}

if (location.pathname === "/device/sessions") {
  const { renderCliSessions } = await import("./cli-sessions.js");
  await renderCliSessions({ documentRef: document, request });
} else {
  const page = createDevicePage({
    documentRef: document,
    request,
    locationRef: location,
    historyRef: history,
  });
  page.start();
}
