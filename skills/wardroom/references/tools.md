# Wardroom MCP tools

Mutations need `operationId` (UUID). Destructive tools also need `destructive: true` on the token. Admin-only tools need `scope: admin`.

## Projects

| Tool | Notes |
| --- | --- |
| `project_list` | Visible projects for this token |
| `project_get` | Registry resources |
| `project_connections` | Placeholder connection templates |
| `project_provision` | Create user, `{name}` + `{name}_test` DBs, buckets. Same password on retry |
| `project_retire` | Destructive. All registered resources |

## PostgreSQL

| Tool | Notes |
| --- | --- |
| `database_list` | Owned DBs, including extras the owner created |
| `database_create` | Extra registered DB + pgvector, owner = project |
| `database_drop` | Destructive. Not base DBs |
| `user_list` | No passwords |
| `user_create` | Extra login, `NOCREATEDB` |
| `user_drop` | Destructive |
| `user_grant` | `read` or `write` on public schema |
| `user_createdb` | `ALTER ROLE {project} CREATEDB` only. No admin password |
| `user_password_rotate` | Destructive |
| `table_list` / `table_rows` | Rows use project login + password |
| `sql_execute` | Destructive. Project login only. 8s limit |

## Redis (relative keys)

| Tool | Notes |
| --- | --- |
| `redis_scan` / `redis_get` | Prefix `{project}:` applied server-side |
| `redis_set` / `redis_delete` | Overwrites |
| `redis_clear` | Destructive namespace wipe in batches |

## MinIO

| Tool | Notes |
| --- | --- |
| `bucket_list` / `bucket_create` / `bucket_drop` | Drop is destructive; purge empties objects |
| `object_list` / `object_get` / `object_put` / `object_delete` | Get ≤32 KiB |

## Host and Docker (admin unless noted)

| Tool | Notes |
| --- | --- |
| `service_health` | Shared service status |
| `system_metrics` | CPU/memory/filesystem/LVM/I/O/network. Project tokens omit other containers |
| `lvm_list` / `lvm_extend` | Admin. Grow-only; `sizeGiB` absolute GiB |
| `container_list` / `container_logs` / `container_action` | Admin. Name or Compose service. No exec |
| `volume_list` / `volume_create` / `volume_remove` | Admin. List includes `sizeBytes` when available |
| `network_list` / `network_create` / `network_remove` | Admin. Built-in + `shared-infra_*` protected |
| `operation_history` | Sanitized mutation outcomes |
| `fault_apply` | Admin destructive. Fixed toxiproxy presets |
| `mock_list` / `mock_create` / `mock_delete` | Project-owned WireMock paths |

## Docker CLI (repo work only)

When changing the Wardroom stack itself, use `make` / `scripts/compose.sh` so `DOCKER_CONTEXT` is applied and checked against `DOCKER_ENDPOINT`. Never `docker context use`. Never a bare `docker` that hits the local daemon. Do not print `.env` hostnames or SSH endpoints.

## Control plane (do not stop/delete)

`dashboard`, `gateway`, `agent-broker`, `docker-proxy`. Wardroom data volumes `postgres-data`, `redis-data`, `minio-data`, `redisinsight-data` (and `shared-infra_*` names) cannot be removed.
