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

The dedicated `McpFunction` Lambda is deployed by the normal DataOps pipeline.
Read its full endpoint from the application stack's `McpUrl` output. It runs
`mcp/src/lambda.mjs`, which adapts Lambda Function URL events to the same proxy
as the standalone server. The SAM make target `build-McpFunction` packages its
three dependency-free modules. The runtime has only basic Lambda logging
permissions and forwards the caller's DataOps token to the portal API.

For local development or self-hosting:

```sh
node mcp/src/standalone.mjs --upstream https://ops.dtcdev.click --port 8080
```

## Auth (the DataOps auth)

Present your DataOps API token as `Authorization: Bearer <token>` — the
same credential the CLI holds after `dataops login` (device flow, browser
approval). The proxy validates it against `/api/me` on every MCP request and forwards it
unchanged. Deployment-managed service credentials retain their existing API
route restrictions for every tool call. It never mints, stores or logs
credentials. Auth and token-management routes are not exposed as tools.

## Consumer config

Claude Code (`~/.claude.json`):

```json
{ "mcpServers": { "dataops": { "url": "https://<McpUrl-host>/mcp" } } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.dataops]
url = "https://<McpUrl-host>/mcp"
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

Inspector check (Streamable HTTP, same protocol the Inspector uses):

```sh
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8080/mcp --transport http --method tools/list
```

## Parity

`mcp/COVERAGE.md` maps every command `pocketshell-mcp` exposed for DataOps
(24 commands in `manifests/dataops.json`) to the portal API family that
serves it. Both standalone and Lambda transports import the same definitions and proxy.
`mcp/test/lambda.test.mjs` covers Lambda transport and upstream authorization.
