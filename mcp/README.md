# DataOps MCP

Model Context Protocol server for the DataOps portal. Three tools —
`dataops_read`, `dataops_write`, `dataops_guide` — cover the same API the
`dataops` CLI and the portal use, so the MCP contract can never drift from
the API: contract changes land in one commit in this repo.

Home of the DataOps tools after the PocketShell separation (F10): the
DataOps/Dapier/AISL namespaces previously lived in
`PocketShell-io/pocketshell-mcp` behind the PocketShell EC2 gateway. DataOps
tools move here; Dapier, AISL and PocketShell agent tools are retired from
the old MCP surface after consumer verification.

## Deployment and runtimes

1. **Current interim endpoint in the portal Lambda.** `POST /mcp` on the portal host
   (e.g. `https://ops.dtcdev.click/mcp`) is handled in-process by
   `backend/src/mcp.ts` through the same route handlers as the CLI and
   portal. Shipped by the normal dataops deploy, no extra infrastructure.
2. **Dedicated Lambda runtime, prepared for activation.** `mcp/src/lambda.mjs`
   adapts Lambda Function URL events to the same standalone proxy. The SAM
   make target `build-McpFunction` packages its three dependency-free modules;
   its handler is `src/lambda.handler` and `DATAOPS_URL` names the portal API.
   Integration into the app stack waits for the dedicated deploy permissions
   in `aws-infra/sandbox/dataops/template.github-actions.yaml` to be applied
   by an operator. Activate through the normal DataOps pipeline and replace
   the interim portal endpoint in that same change. The separate runtime has
   no DataOps database credentials; every request validates the caller token
   with `/api/me` and tool calls retain the API's authorization rules.
3. **Standalone proxy (local dev, self-host).** `mcp/src/standalone.mjs`
   forwards MCP calls to any portal URL. Used for the Inspector check and
   for consumers that want their own endpoint:

```sh
node mcp/src/standalone.mjs --upstream https://ops.dtcdev.click --port 8080
```

## Auth (the DataOps auth)

Present your DataOps API token as `Authorization: Bearer <token>` — the
same credential the CLI holds after `dataops login` (device flow, browser
approval). The proxy and dedicated Lambda validate it against `/api/me` on
every MCP request. The interim portal handler uses its session/token tables.
The proxy forwards the credential
unchanged. Deployment-managed service credentials retain their existing API
route restrictions for every tool call. It never mints, stores or logs
credentials. Auth and token-management routes are not exposed as tools.

## Consumer config

Claude Code (`~/.claude.json`):

```json
{ "mcpServers": { "dataops": { "url": "https://ops.dtcdev.click/mcp" } } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.dataops]
url = "https://ops.dtcdev.click/mcp"
bearer_token_env_var = "DATAOPS_TOKEN"
```

Set `DATAOPS_TOKEN` to the credential issued by `dataops login` or a
deployment-managed service token. `dataops tokens list` shows metadata, not
the token value. Configure the same Authorization header in Claude Code.
Verify with a read call: `dataops_read` route `/api/tasks?status=todo&limit=1`.

## Tests

```sh
node --test mcp/test/*.test.mjs   # or: npm run test:mcp (repo root)
```

Backend (covers `POST /mcp` through the real router):

```sh
npm test --workspace dataops-backend -- tests/api-mcp.test.ts
```

Inspector check (Streamable HTTP, same protocol the Inspector uses):

```sh
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8080/mcp --transport http --method tools/list
```

## Parity

`mcp/COVERAGE.md` maps every command `pocketshell-mcp` exposed for DataOps
(24 commands in `manifests/dataops.json`) to the portal API family that
serves it. `backend/tests/api-mcp.test.ts` asserts the in-Lambda tool names
and descriptions stay identical to `mcp/src/tools.mjs`.
