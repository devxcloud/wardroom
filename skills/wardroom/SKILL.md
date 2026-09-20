---
name: wardroom
description: This skill should be used when the user mentions Wardroom, shared-infra, Docker context, or asks to provision a project database, run project SQL, read captured Mailpit mail, manage Redis or MinIO, grow LVM, or operate Docker containers, volumes, or networks through Wardroom MCP. Also use for Claude Code or Codex MCP token setup against the Wardroom endpoint.
---

# Wardroom

Operate the shared development stack through the **wardroom** MCP server. Do not invent admin SQL, host shell, or Docker socket access. Use MCP tools; they already encode ownership and allowlists.

Wardroom is a trusted-team devbox (PostgreSQL+pgvector, Redis, MinIO, mail capture, tracing), not a multi-tenant production platform. Do not put customer data or production secrets here.

## Connect

MCP is Streamable HTTP at `http://<devbox>/mcp` (same gateway as the dashboard). Dashboard cookies do not authenticate. Every request needs `Authorization: Bearer wr_…`.

1. Open the dashboard **AI & MCP** page (`/#ai-mcp`).
2. Create a token (project or admin; destructive is a separate opt-in). Copy it once.
3. Export `WARDROOM_MCP_TOKEN` in the client launch environment. Never commit the token.

Claude Code (project `.mcp.json`; env expansion at start):

```json
{
  "mcpServers": {
    "wardroom": {
      "type": "http",
      "url": "http://<devbox>/mcp",
      "headers": { "Authorization": "Bearer ${WARDROOM_MCP_TOKEN}" }
    }
  }
}
```

Codex:

```sh
codex mcp add wardroom --url http://<devbox>/mcp --bearer-token-env-var WARDROOM_MCP_TOKEN
```

Restart the client after setting the env var. On HTTP 401 with a newly issued **No expiration** token, the MCP container must be running the current image (`make mcp-up`). On HTTP 403, the Host header is not in `MCP_ALLOWED_HOSTS`.

If Wardroom tools are missing from the session, the MCP server is not connected. Do not fall back to guessing Postgres URLs or running `docker` against the workstation daemon.

## Docker context

The stack runs on a **remote** Docker host reached over SSH. The name and endpoint live only in ignored `.env` as `DOCKER_CONTEXT` (default `wardroom`) and `DOCKER_ENDPOINT` (`ssh://…`). Do not print those values, hostnames, or SSH targets.

- Drive Compose with `make …` or `scripts/compose.sh`. They pass `docker --context "$DOCKER_CONTEXT"` and check the context still matches `DOCKER_ENDPOINT`.
- Never run `docker context use`. Never change the globally selected Docker context.
- Never `docker compose` / `docker run` without `--context`. Bare `docker` talks to the workstation and will start duplicate local services.
- Do not add workstation bind mounts. Images, containers, and named volumes belong on the remote host.
- Create or repair the context with `make context`. If the Tailnet IP changed, update `.env` first; do not overwrite a context that points somewhere else.
- For container, volume, and network operations from an agent session, prefer Wardroom MCP (`container_*`, `volume_*`, `network_*`) over the Docker CLI.

## How to call tools

- Discover tools with the client's MCP listing. The set depends on token **scope** (project vs admin) and **destructive**.
- Mutations require a fresh UUID `operationId`. Reuse the same id+args to replay a completed outcome. Do not mint a new id after `started`/`uncertain` — inspect `operation_history` first.
- Pass `project` on project-scoped tools. Names are `^[a-z][a-z0-9_]{2,47}$`.
- Never ask for infrastructure admin SQL passwords. Never use `sql_execute` as a stand-in for `ALTER ROLE`.
- Prefer one change at a time. Do not claim a write completed before the tool result returns.

Full catalog: [references/tools.md](references/tools.md).

## Typical work

**Inspect a project.** `project_list` → `project_get` → `project_connections`. Default templates use placeholders. On a **destructive** project token, `includeSecrets: true` fills the stored database password and MinIO service-account keys. Redis stays `<REDIS_PASSWORD>` (shared). Do not read Wardroom `.env` for the project DB password when the token can return it. The browser connections page never includes secrets.

**Provision.** `project_provision` with `project` and `password` (≥12 chars). Retry with the **same** password if it partially failed. Provision stores the password and mints a MinIO service account limited to the project's buckets.

**Extra databases.** Project owner logins have `CREATEDB`. Grant or revoke with `user_set_createdb` `{ enabled }` (no admin SQL). `user_createdb` still grants. Create a registered extra DB with `database_create`. `database_list` includes `createdAt`, `ageSeconds`, and `lastConnected`. List/drop include DBs the owner created. Extra logins stay without `CREATEDB`.

**SQL.** `sql_query` is read-only SELECT/WITH/EXPLAIN/SHOW as the project login; safe token; 8s; 100 rows. `sql_execute` is destructive, same login, may write. Password may be omitted after provision or `user_password_rotate` without a password argument (server generates and stores it; read once via `project_connections` `includeSecrets`). Never paste the database password into chat. Never `SET ROLE` or admin SQL.

**Mail.** Shared Mailpit inbox. `mail_list` / `mail_search` / `mail_get` / `mail_delete` only see messages whose From or To/Cc/Bcc domain is exactly `{project}.test` or `{project}.local`. Set app `From` (and test recipients) to `MAIL_DOMAIN`. Names `test`, `local`, and `mail` are reserved. Never delete the whole inbox.

**Backup.** `database_backup` dumps an owned database to `{bucket}-backups` (created if missing), key `backups/{database}-{timestamp}.dump`. That bucket is not on the project's MinIO service-account policy. `database_restore` creates a **new** extra database from that object (destructive) and reassigns non-extension objects to the project login. Snapshot before a test suite that truncates.

**Redis.** Keys are **relative**. The server prefixes `{project}:`. Do not send the prefix. Do not `FLUSHALL`.

**S3.** Only owned buckets. `object_get` is capped at 32 KiB base64. App credentials from `project_connections` `includeSecrets` are the project service account, not MinIO root. Rotate with `s3_credentials_rotate`.

**Host metrics vs LVM.** `system_metrics` `storage[].availableBytes` is filesystem free on a mount. `lvm.volumeGroups[].freeBytes` (or `lvm_list`) is unallocated VG space. Do not treat them as the same. Grow with `lvm_extend`: `sizeGiB` is the new **absolute** size in GiB (1024³), never a shrink. Example: `vg=ubuntu-vg`, `lv=ubuntu-lv`, `sizeGiB=200`.

**Docker (admin).** Address containers by **name** (from `container_list` or the dashboard Containers page), not only Compose service ids. `container_action` start/stop/restart/remove. Control plane (`dashboard`, `gateway`, `agent-broker`, `docker-proxy`) cannot be stopped or deleted. Wardroom services cannot be deleted. Volumes and networks: list/create/remove; Wardroom data volumes and `bridge`/`host`/`none` plus `shared-infra_*` networks are protected. Volume list includes `sizeBytes` when Docker reports usage.

## Limits

No host shell, exec, image build, or arbitrary SQL as admin. No `SET ROLE`. Control-plane stop/delete is refused. Do not publish the gateway. Do not change the global Docker context or start services on the workstation. Token text, SQL, row results, logs, and object bodies can enter the model provider — keep them off production data.

## Install this skill

From a Wardroom checkout:

```sh
make skill-install
```

That copies `skills/wardroom` to `~/.claude/skills/wardroom`, `~/.codex/skills/wardroom`, and `~/.agents/skills/wardroom`. Restart Claude Code / Codex so they load it.
