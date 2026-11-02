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

## Auth (the shared issuer)

The MCP server is an OAuth 2.0 protected resource (RFC 9728). The only
accepted credential is an RS256 access token minted by the shared issuer
`https://oauth.dtcdev.click` and audience-bound to this MCP resource: the
server verifies the signature against the issuer's JWKS, the issuer,
validity window and audience locally on every request and forwards the JWT
to the portal unchanged. Opaque portal tokens are not accepted.

OAuth-aware clients discover the issuer through the challenge: an
unauthenticated call gets `WWW-Authenticate: Bearer resource_metadata="…/
.well-known/oauth-protected-resource/mcp"`, and
`GET /.well-known/oauth-protected-resource` (plus the `/mcp` path form)
returns the RFC 9728 metadata naming the authorization server. Human
callers mint tokens through the issuer's authorization-code or device flow
(`dtc-cli`/`dtc-mcp-public` clients, Google SSO restricted to verified
@datalks.club accounts); deployment-managed services use their issuer
service clients. The server never mints, stores or logs credentials, and
issuer tokens never outlive their one-hour TTL without a refresh.

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

`DATAOPS_TOKEN` is the shared-issuer access token (`dataops login` mints and
refreshes it; the same JWT works for the portal API and this MCP resource).
Clients that speak MCP OAuth can skip the env var entirely: on a 401 they
follow the `resource_metadata` challenge to the issuer and run the
authorization-code flow themselves. `dataops whoami` shows the identity a
token carries; token values are never printed.
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
