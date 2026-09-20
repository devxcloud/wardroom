# Agent operations

Wardroom's optional MCP server is for trusted development agents. It shares one validated tool catalog with future integrations; a chat UI and model-provider connections are not implemented. Use the setup commands in the [README](../README.md#coding-agent-tools-optional-mcp).

## Access and credentials

The main menu's **AI & MCP** page (`/#ai-mcp`) provides client tabs with copyable installation commands, token environment setup, optional manual configuration, and endpoint copying. The old `/#tools/ai-mcp` link redirects here. Choose **New token** to open the creation form; scope and destructive access are separate choices. Tokens appear only once for copy/download and are never stored in browser local/session storage. A downloaded credential file is sensitive: move it outside repositories and restrict its filesystem permissions. Active tokens appear first; **Show inactive tokens** reveals revoked and expired entries within the newest 100 records. Each token shows scope, expiry, last successful authentication and revocation controls, including on mobile. Last-used timestamps do not imply that an operation completed.

Claude Code's example uses environment-variable expansion in `.mcp.json` ([official documentation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json)); Codex uses `--bearer-token-env-var`. Grok Build's CLI example uses user scope and passes an environment-expanded authorization header: the resolved secret is saved in its private user configuration and briefly appears in the command's arguments. Do not use that example with project scope. Other clients should use a private secret field; variable interpolation syntax is client-specific.

`make mcp-up` deploys the MCP service and its private container-control broker. Neither publishes a host port. Connect directly through Caddy at `http://devbox/mcp` or the devbox Tailnet IP, with a bearer token. Configure the names/IPs you use in `MCP_ALLOWED_HOSTS`; the service validates Host/Origin and authenticates every request. Dashboard cookies do not grant MCP access. No client-IP allowlist or SSH tunnel is needed.

MCP is reachable wherever the dashboard gateway is reachable. Keep traffic on an encrypted Tailnet path: ordinary LAN HTTP exposes bearer tokens. Do not publish this trusted-development gateway on the Internet. Token scope, destructive opt-in, expiry and revocation remain enforced regardless of client address.

Issue project tokens through `make agent-token ARGS="--project example --output .env.agent-example.json"`. Add `--destructive` deliberately; use `--admin` instead of `--project` for shared-service operations. Tokens expire in 30 days by default, with a configurable 1–90 day lifetime. Only the token hash is stored. Save the issuance result privately: the raw token cannot be recovered later. Use `make agent-tokens` and `make agent-revoke ID=<uuid>` to inspect and revoke access.

Project scope is enforced by these tools, not by a separate infrastructure tenant. Developers with shared Redis/MinIO credentials still have shared access. SQL passwords, returned records, application logs and object contents may be retained by your agent client or model provider. Do not use customer data or production secrets.

## Tool boundaries

| Area | Supported behavior | Deliberate limits |
| --- | --- | --- |
| Projects | Provision, inspect, connection templates, retire | Registry-owned resources only; system projects protected |
| PostgreSQL | Extra databases/users, fixed grants, password rotation, table preview, SQL | Actual project login for SQL/previews; bounded output and timeouts; SQL requires destructive opt-in |
| Redis | Scan/get/set/delete relative keys, clear namespace | Project prefix always applied; no arbitrary commands or global flush |
| S3 | Owned bucket lifecycle, object list/get/put/delete | Bounded pages/bodies; explicit purge; versioned bucket deletion refused |
| Diagnostics | Service health and host metrics | Project responses exclude unrestricted container inventory |
| Test lab | Project-namespaced static mocks, fixed fault presets | No raw WireMock mappings or arbitrary proxy destinations |
| Containers | List/logs/start/stop/restart | Admin only; fixed service allowlist and Compose-label checks; no shell, exec, image creation, volumes or control-plane actions |

Normal exact-key/object writes are available without destructive opt-in. Broader operations such as SQL, retirement, namespace clearing, password rotation and container actions require it. The MCP discovery response reflects the caller's permissions; dispatch checks them again.

## Mutation recovery

Every mutation requires a UUID `operationId`. Wardroom records intent before invoking the effect, serializes conflicting project operations, and records a bounded outcome. Reusing the same token, operation ID, tool and arguments returns the completed outcome without executing again. Reusing an ID with changed arguments is rejected.

Inspect `make agent-history` after an interrupted or failed operation. `started` or `uncertain` means the effect may have happened: do not automatically retry with a new UUID. Compare the exact target with actual service state, finish or undo partial work deliberately, then acknowledge the inspected operation:

```sh
node scripts/agent-token.mjs acknowledge --token-id <token-uuid> --id <operation-uuid>
```

Acknowledgment does not roll back or retry anything. Use a new operation ID only after reconciliation. This is especially important for arbitrary SQL and project retirement, which may partially complete. Audit history stores target identifiers and allowlisted outcome metadata, not passwords, SQL text, row results or object bodies. This is an operational audit, not a tamper-proof compliance log.

## Verification and shutdown

```sh
make test
node --env-file=.env --test tests/integration/agent.mjs
node --env-file=.env --test tests/integration/mcp.mjs
make mcp-down
```

Integration tests write disposable randomly named projects and clean up their exact resources. The MCP test normally exercises the configured gateway path. `MCP_TEST_SSH=1` instead uses the existing remote Docker SSH connection as a test-only transport to the deployed service; it does not prove workstation gateway reachability or install a client tunnel.

For broker lifecycle tests, start only the disposable `agent-check` service with `bash scripts/compose.sh --profile agent-test up -d agent-check`, run the MCP test with `AGENT_BROKER_TEST=1`, then stop and remove that exact service. Tests never restart the shared database or cache. `make mcp-down` preserves project resources, token records and operation history.
