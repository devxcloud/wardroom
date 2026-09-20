# Wardroom operations

Run commands from the repository root. Docker always uses the explicitly validated `DOCKER_CONTEXT` (default `wardroom`) and `DOCKER_ENDPOINT`. Credentials remain in ignored `.env`; project credentials belong in each project's ignored environment file. The hostname `devbox` in examples is fictional; replace it with your configured host.

## Lifecycle and diagnostics

- `make context`: create or validate the remote SSH context.
- `make config`: validate the context and Compose configuration without printing interpolated secrets.
- `make up`: build remotely, deploy, and wait up to 120 seconds for health checks.
- `make ps`, `make logs`: inspect services.
- `make doctor`: verify workstation access to the published core ports via the Tailnet IP, remote PostgreSQL volume capacity, and service checks.
- `make smoke`: authenticate to services and execute a vector operation in every ready project's development/test databases; verify both buckets.
- `make down`: stop all shared services, preserving named volumes.

If SSH works but service ports do not, inspect Tailscale connectivity and access rules. Container health alone does not prove workstation reachability. If devbox's Tailnet IP changes, update all three host/endpoint settings in `.env` and deliberately update the context before redeploying.

## Resource bounds

| Service              | Container memory                           |
| -------------------- | ------------------------------------------ |
| PostgreSQL           | 2 GiB; 256 MiB shared memory               |
| Redis                | 512 MiB; 384 MiB dataset cap, `noeviction` |
| MinIO                | 2 GiB                                      |
| Dashboard            | 512 MiB                                    |
| Caddy gateway        | 128 MiB                                    |
| Mailpit              | 128 MiB                                    |
| Jaeger               | 512 MiB                                    |
| RedisInsight         | 512 MiB                                    |
| Dozzle               | 256 MiB                                    |
| Docker socket proxy  | 64 MiB                                     |
| WireMock / Toxiproxy | 256 MiB / 128 MiB when the test lab runs   |

Redis returns write errors when its dataset cap is reached rather than evicting queue/job keys. Monitor usage and adjust limits deliberately. Every long-running service rotates Docker JSON logs at 10 MiB with three files. Named volumes can still fill the host disk; `make doctor` reports capacity but does not enforce quotas.

Mailpit's inbox is intentionally ephemeral. PostgreSQL, Redis AOF, and MinIO objects persist in named volumes on devbox. Avoid workstation bind mounts: the remote daemon resolves them on devbox.

## Gateway and host telemetry

Caddy serves HTTP on all IPv4 interfaces at port 80, proxying to the authenticated dashboard. Use `http://devbox` on the LAN, or `http://<tailscale-ip>` over Tailscale. Port 8787 remains available directly. Caddy does not configure DNS: if the hostname fails but the IP works, check client name resolution. TLS and public exposure are not configured; LAN HTTP carries credentials without transport encryption.

Run `make telemetry` to install/update the Python 3.10+ collector and its private configuration on devbox. The installer enables a systemd user service and lingering for boot/logout persistence. If lingering is denied, it prints the administrator command required. Reinstall after rotating `TELEMETRY_TOKEN`; redeploy the dashboard with the same token.

The collector has no listener. It reads Linux `/proc` counters and fixed read-only Docker CLI commands, then pushes allowlisted metrics with a separate bearer token. The dashboard has no Docker socket. On devbox, inspect `systemctl --user status shared-infra-telemetry` and `journalctl --user -u shared-infra-telemetry -n 30`. Stop collection with `systemctl --user stop shared-infra-telemetry`.

Samples arrive every 10 seconds; after 35 seconds without a sample the UI marks them stale. PostgreSQL stores the latest snapshot and a rolling 24-hour summary history. The chart ranges use 10/30/120-second buckets. First samples and counter resets show unknown rates instead of invented values; history survives dashboard restarts.

- Host CPU is normalized across all cores; Docker CPU uses 100% per core.
- Memory uses Linux `MemAvailable`, accounting for reclaimable cache. Docker reports its own cache-adjusted memory.
- Filesystem capacity separates used, reserved, and available space. That is free space inside a mounted filesystem, not unallocated LVM capacity.
- LVM volume groups, physical volumes, and logical volumes are collected from sysfs. Volume-group free is physical-volume size minus logical-volume size, so a few megabytes of metadata may be counted as free.
- Growing a logical volume is an allowlisted host operation (`lvextend` then `resize2fs`/`xfs_growfs`) through the private host broker. It never shrinks. Use the System page Grow control, chat `lvm_extend`, or MCP. `sizeGiB` is the new absolute size in GiB.
- Disk I/O sums physical devices, excluding device-mapper duplicates.
- Network charts use the default-route interface. Tailnet traffic is listed separately to avoid double-counting encapsulated traffic.
- Container network and block-I/O columns are cumulative counters, not rates. Inventory includes other stacks, capped at 128 entries with truncation indicated.

## Developer tools and failure lab

Caddy protects `/logs/`, `/redis/`, `/jaeger/`, and `/mock/` with the dashboard session. Dozzle reaches Docker only through a separate read-only socket proxy; POST, shell, and container actions are disabled. RedisInsight data persists in its own named volume and is encrypted with `RI_ENCRYPTION_KEY`. Jaeger is intentionally ephemeral and keeps up to 10,000 development traces in memory.

Start the optional lab with `make lab-up` and stop it with `make lab-down`. WireMock has no committed mappings, so configure stubs through its API for the current experiment. Toxiproxy loads three fixed proxies from `lab/toxiproxy.json`; its admin port remains on the Compose network. The dashboard can apply only fixed presets. Always reset a proxy after testing a failure, and point applications back to the normal service ports when the experiment ends.

## Optional API workbench

Start the base stack before running `make api-up`. This provisions the registered `hoppscotch` project without adopting conflicting resources or rotating existing passwords, applies upstream Prisma migrations, then deploys Hoppscotch and the updated dashboard/gateway. The API service has a 1 GiB memory limit and rotating logs; its backend ports are not directly published. Caddy's port 3000 follows `DASHBOARD_BIND_IP` and requires the dashboard session for all routes. `/api` and `/api/` redirect there; dashboard `/api/*` endpoints are unchanged.

Use `HOPPSCOTCH_HOST` consistently for dashboard and API workbench access, because the shared cookie is host-scoped. Changing it requires redeploying both gateway and Hoppscotch. `make api-down` stops the app, preserving data; the launcher and authenticated gateway listener remain, but cannot serve Hoppscotch until restarted. `make down` preserves its database in the shared PostgreSQL volume.

Complete the first administrator setup through `/admin` on port 3000. Configure Mailpit only for trusted development accounts: shared inbox access grants access to magic-link emails. Browser clients use Browser or a workstation Agent; the public proxy default is disabled with a deliberately unreachable loopback destination. Dashboard forward-auth targets browser sessions, not unattended CLI clients or desktop-instance login.

Run `API_WORKBENCH_TEST=1 DASHBOARD_URL=http://devbox npm run test:ui` to include the optional live workbench browser test. Preserve `HOPPSCOTCH_DB_PASSWORD` and the exactly 32-character `HOPPSCOTCH_ENCRYPTION_KEY`. Do not run migrations against another database or rotate the key to resolve a startup failure.

## Credentials and registry

The Compose wrapper generates `AI_SETTINGS_KEY` in ignored `.env`. Keep it stable: Wardroom encrypts the optional model-provider API key with it. Provider settings are workspace-wide and editable only through an authenticated dashboard session. Changing the endpoint does not forward the old key to the new host. HTTP endpoints require explicit acknowledgement; use HTTPS or a private development network. Prompts and selected infrastructure results leave Wardroom for the configured provider.

Dashboard AI conversations are memory-only and expire after 30 minutes. Their internal short-lived agent tokens stay out of the MCP token list but retain normal operation audit records. Stopping a response prevents later dispatch; inspect operation history if a mutation was already running. Provider failures never trigger a fallback or automatic mutation retry.

The dashboard is a trusted development admin interface. Its server uses the PostgreSQL administrator and shared Redis/MinIO root credentials. The browser never receives those credentials; generated connection settings contain placeholders. Destructive project MCP tokens may request stored project secrets (`includeSecrets`) for the database password and MinIO service account; Redis stays a placeholder. Copy remaining values from local ignored environment files and URL-encode passwords inside database/Redis URLs.

Change `DASHBOARD_PASSWORD` in `.env` and run `make up` to rotate dashboard access; restarting invalidates sessions. PostgreSQL's `POSTGRES_PASSWORD` only initializes an empty cluster: changing `.env` alone does not rotate an existing database password. Project provisioning intentionally does not rotate passwords.

The ignored `projects.local.json` is an optional initial metadata catalog; `projects.example.json` documents its format. The live source of truth is `postgres.shared_infra.projects`; events are in `shared_infra.events`. The dashboard and CLI serialize provisioning with a PostgreSQL advisory lock. Failures can leave partially created resources; retry the same project/password to finish. Existing resource assignments cannot be edited into another project.

Redis prefixes are an application convention, not an access boundary. Ensure cache/queue libraries apply them to all keys; do not use `FLUSHALL` or `FLUSHDB`. Use a distinct project name for each concurrent destructive test suite. Mailpit is a shared inbox: MCP mail tools only return messages whose From or recipients use the exact domain `{project}.test` or `{project}.local`. Project names `test`, `local`, and `mail` are reserved so those suffixes cannot collide. Set application `From` (and test recipients) accordingly. MinIO root credentials still exist for the console; provision mints a per-project service account limited to that project's buckets.

## Backups and restore

```sh
make backup DB=example
make backup DB=postgres
make restore DB=example_recovery FILE=backups/example-<timestamp>.dump
```

Backups are custom-format logical dumps on the workstation under ignored `backups/`, created with private file permissions. Back up `postgres` as well to capture the registry. Dumps do not include cluster roles or passwords; retain project credential records separately. The scripts refuse overwriting backup filenames and existing restore databases.

Restore uses a single transaction and stops on errors. The new database is owned by the infrastructure admin; reassignment to a project is a separate deliberate operation. If restoration fails after database creation, the empty target can remain for inspection. Never use an incomplete backup marked by a failed backup command.

For MinIO backups, use `mc mirror` to another S3 endpoint:

```sh
bash scripts/compose.sh \
  run --rm --no-deps --entrypoint /bin/sh minio-init
```

Configure an alias inside that container using its existing environment credentials and a second alias for the destination. The shell is remote; a local path inside it is not on the workstation. Scheduled backups and off-host object replication are not configured.

## Upgrades

PostgreSQL, Dozzle, RedisInsight, Jaeger, the Docker socket proxy, WireMock, and Toxiproxy are digest-pinned. Remaining third-party services use explicit release tags; npm packages are exact versions with a lockfile. Update intentionally, back up first, then run `make test`, `make up`, and `make doctor`.

Never change the PostgreSQL major version against the existing volume. Major upgrades require a dump/restore or reviewed `pg_upgrade` procedure. The PostgreSQL 18 volume is correctly mounted at `/var/lib/postgresql`.

## Destructive operations

The browser dashboard cannot drop databases, buckets or roles. The Containers page can start, stop and delete non-control-plane containers, unused Docker volumes, and unused user networks through the private broker. Built-in networks (`bridge`, `host`, `none`) and Wardroom Compose networks stay protected. Optional [agent tools](agent-tools.md) can retire registered project resources with an explicitly destructive token. Wardroom named volumes stay protected. The command below permanently deletes all shared PostgreSQL, Redis, and MinIO data, including the project registry:

```sh
bash scripts/compose.sh down --volumes
```

Inspect the exact context, back up needed data, and coordinate with all developers before any shared reset. To retire test-run resources, use their exact registry names; never derive deletion targets from broad prefixes or wildcards.
