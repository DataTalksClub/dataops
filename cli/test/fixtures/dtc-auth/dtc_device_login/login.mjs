/**
 * Stand-in for DataTalksClub/auth's shared device loop used by CLI tests.
 * Same contract: start on `${baseUrl}/oauth/device`, prompt, poll
 * `${baseUrl}/oauth/token` with the RFC grant name until a 200.
 */
export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export class DeviceLoginError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.name = "DeviceLoginError";
    this.code = code;
  }
}

export async function deviceLogin({
  post,
  baseUrl,
  startBody = {},
  startPath = "/oauth/device",
  tokenPath = "/oauth/token",
  prompt = null,
  presentUri = null,
  sleep = () => new Promise((resolve) => setTimeout(resolve, 0)),
}) {
  console.log("FIXTURE-LOOP-LOADED");
  const started = await post(`${baseUrl}${startPath}`, startBody);
  const start = started.body || {};
  if (started.status !== 200 || !start.device_code || !start.user_code) {
    throw new DeviceLoginError(`The server did not offer device login (status=${started.status}, keys=${Object.keys(start).join(",")}).`, "invalid_response");
  }
  const uri = presentUri ? presentUri(start.verification_uri_complete || start.verification_uri || '') : String(start.verification_uri_complete || start.verification_uri || '');
  if (prompt) prompt(`Confirm this code:  ${start.user_code}\nOpen in a browser:  ${uri}`);
  const deadline = Date.now() + 15_000;
  let interval = Math.max(Number(start.interval) || 5, 1);
  while (Date.now() < deadline) {
    await sleep(interval);
    const polled = await post(`${baseUrl}${tokenPath}`, {
      grant_type: GRANT_TYPE,
      device_code: start.device_code,
    });
    if (polled.status === 200 && polled.body && !polled.body.error) return polled.body;
    const code = String(polled.body?.error || "failed");
    if (code === "slow_down") {
      interval += 5;
      continue;
    }
    if (code === "authorization_pending") continue;
    throw new DeviceLoginError(
      code === "access_denied" ? "The login was denied in the browser."
        : code === "expired_token" ? "The code expired. Run login again."
        : `Device login failed (${code}).`,
      code,
    );
  }
  throw new DeviceLoginError("Timed out waiting for approval. Run login again.", "timeout");
}
