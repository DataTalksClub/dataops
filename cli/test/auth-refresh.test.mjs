import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, test } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "dataops-auth-refresh-"));
const configDir = path.join(root, "config");
const configModule = pathToFileURL(fileURLToPath(new URL("../src/config.mjs", import.meta.url))).href;
const authModule = pathToFileURL(fileURLToPath(new URL("../src/commands/auth.mjs", import.meta.url))).href;
const portalUrl = "https://portal.test";
const oldConfigDir = process.env.DATAOPS_CONFIG_DIR;
const oldIssuer = process.env.DTC_OAUTH_ISSUER;
const oldToken = process.env.DATAOPS_TOKEN;
let server;
let issuerUrl;
let refreshCalls;
let issuerError;

process.env.DATAOPS_CONFIG_DIR = configDir;
delete process.env.DATAOPS_TOKEN;

const { resolveProfile, saveProfile } = await import("../src/config.mjs");
const { sessionCredential } = await import("../src/commands/auth.mjs");

function runChild() {
  const source = `
    import { resolveProfile } from ${JSON.stringify(configModule)};
    import { sessionCredential } from ${JSON.stringify(authModule)};
    await sessionCredential(resolveProfile({ url: ${JSON.stringify(portalUrl)} }))();
    process.stdout.write("ok");
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, DATAOPS_CONFIG_DIR: configDir, DTC_OAUTH_ISSUER: issuerUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exit ${code}`)));
  });
}

describe("human session refresh", () => {
  before(async () => {
    server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/oauth/token") {
        response.writeHead(404).end();
        return;
      }
      refreshCalls += 1;
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal(new URLSearchParams(body).get("grant_type"), "refresh_token");
      await new Promise((resolve) => setTimeout(resolve, 150));
      response.writeHead(issuerError ? 400 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(issuerError || {
        access_token: "fresh-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    issuerUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.DTC_OAUTH_ISSUER = issuerUrl;
  });

  beforeEach(() => {
    refreshCalls = 0;
    issuerError = null;
    saveProfile(portalUrl, {
      accessToken: "expired-access-token",
      refreshToken: "initial-refresh-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
  });

  test("silently refreshes an expired access token", async () => {
    const credential = sessionCredential(resolveProfile({ url: portalUrl }));
    assert.equal(await credential(), "fresh-access-token");
    assert.equal(refreshCalls, 1);
    const stored = resolveProfile({ url: portalUrl });
    assert.equal(stored.refreshToken, "rotated-refresh-token");
    assert.ok(Date.parse(stored.expiresAt) > Date.now());
  });

  test("serializes concurrent processes and rereads the rotated credentials", async () => {
    const results = await Promise.all([runChild(), runChild()]);
    assert.deepEqual(results, ["ok", "ok"]);
    assert.equal(refreshCalls, 1, "the single-use refresh token is sent only once");
    const stored = resolveProfile({ url: portalUrl });
    assert.equal(stored.accessToken, "fresh-access-token");
    assert.equal(stored.refreshToken, "rotated-refresh-token");
  });

  test("surfaces the issuer error description", async () => {
    issuerError = { error: "invalid_grant", error_description: "Refresh token family was revoked." };
    const credential = sessionCredential(resolveProfile({ url: portalUrl }));
    await assert.rejects(() => credential(), /Refresh token family was revoked/);
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (oldConfigDir === undefined) delete process.env.DATAOPS_CONFIG_DIR;
  else process.env.DATAOPS_CONFIG_DIR = oldConfigDir;
  if (oldIssuer === undefined) delete process.env.DTC_OAUTH_ISSUER;
  else process.env.DTC_OAUTH_ISSUER = oldIssuer;
  if (oldToken === undefined) delete process.env.DATAOPS_TOKEN;
  else process.env.DATAOPS_TOKEN = oldToken;
  rmSync(root, { recursive: true, force: true });
});
