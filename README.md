# Wardroom

**Shared services for your development workflow.**

Run one shared, batteries-included development stack on a remote Docker host. Reach it through Tailscale, operate it from a polished web control room, and stop making every project fight for the same ports on every laptop.

Wardroom is a self-hosted development tool for you and trusted teammates—not a hosted infrastructure service or a production platform. Use it for development databases, test data, captured emails, API experiments, and debugging. Shared credentials and lightweight isolation are deliberate conveniences for trusted development, not tenant-security boundaries. Do not put production workloads or real customer data here.

![Wardroom control room](docs/images/control-room-overview.png)

## What you get

| Foundation               | Developer experience                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| PostgreSQL 18 + pgvector | Project-scoped roles, development/test databases, and a read-only web explorer |
| Redis 8                  | Persistent shared cache with project key-prefix conventions and RedisInsight   |
| MinIO                    | S3-compatible development/test buckets and browser console                     |
| Mailpit                  | Shared SMTP capture and email UI                                               |
| Jaeger v2                | OTLP over gRPC/HTTP and an in-memory trace explorer                            |
| Dozzle                   | Live logs for every container on the host through a read-only socket proxy     |
| Caddy                    | One memorable URL for the dashboard and every web tool                         |
| Host collector           | CPU, memory, storage, disk I/O, network, per-core, and container telemetry     |
| Optional test lab        | WireMock API simulation plus safe, preset-only Toxiproxy faults                |

Everything heavy runs on the devbox. Your workstation only needs Docker CLI, SSH, Node.js for development, and access to the same Tailnet.

## The control room

The built-in dashboard is more than a launcher:

- live topology and health checks;
- CPU, memory, storage, I/O, network, and container charts;
- PostgreSQL database, role, schema, table, and paged-record exploration;
- one-flow project provisioning for PostgreSQL, pgvector, MinIO, and Redis;
- authenticated access to logs, RedisInsight, Jaeger, and WireMock;
- copy-ready connection settings with credential placeholders;
- fixed fault profiles for latency, timeouts, and connection failures.

![Host and container monitoring](docs/images/system-monitoring.png)

![Developer tools cockpit](docs/images/developer-tools.png)

The interface is responsive too:

<p align="center"><img src="docs/images/mobile-control-room.png" alt="Mobile control room" width="390"></p>

All screenshots use generated demo data. No real hostnames, projects, addresses, or credentials are included.

## How it fits together

```text
workstation                         remote devbox
┌──────────────────┐    Tailscale   ┌─────────────────────────────────────┐
│ Docker CLI       │ ─── SSH ─────▶ │ Docker Engine                       │
│ browser / apps   │ ─── HTTP/TCP ▶ │ Caddy → dashboard + web tools       │
└──────────────────┘                │ PostgreSQL · Redis · MinIO · Mailpit │
                                    │ Jaeger · Dozzle · optional test lab │
                                    └─────────────────────────────────────┘
```

Compose is always invoked from this repository with the named Docker context. It never changes your globally selected context. Volumes, images, networks, builds, and containers remain on the remote host.

## Quick start

Requirements: a Linux devbox reachable over SSH/Tailscale, Docker Engine on that box, Docker CLI + Compose locally, and Node.js 22+ for dashboard development.

```sh
cp .env.example .env
# Fill in the devbox Tailnet IP, SSH endpoint, and private credentials.

make context
make config
make up
make telemetry
make doctor
```

Open `http://<devbox-hostname>` or `http://<tailscale-ip>` and sign in with `DASHBOARD_PASSWORD`.

`make up` builds on the remote host and waits for health. The Compose wrapper verifies that `DOCKER_CONTEXT` (default: `wardroom`) still points at `DOCKER_ENDPOINT`. A missing RedisInsight encryption key is generated into the ignored `.env`; it is never committed or printed.

`devbox` in these examples is fictional: replace it with your machine's resolvable hostname or IP. Set the real values only in ignored `.env`, including `DOCKER_CONTEXT`, `DOCKER_ENDPOINT`, `SHARED_INFRA_HOST`, `SHARED_INFRA_BIND_IP`, `DASHBOARD_URL`, and `HOPPSCOTCH_HOST`. No custom DNS is configured by Wardroom.

The public product is **Wardroom**, published at [devxcloud/wardroom](https://github.com/devxcloud/wardroom). Existing runtime identifiers such as the `shared-infra` Compose project, database schema, and telemetry service remain stable to preserve deployed data.

### Private configuration

`.env`, `projects.local.json`, backups, test output, generated reports, and internal planning notes are ignored. Start an optional local project recipe with:

```sh
cp projects.example.json projects.local.json
```

The public recipe contains generic examples only. Local recipes never enter the Docker build context; the shared database registry is the runtime source of truth.

## One URL, several tools

After signing in to the control room, the same session protects:

| Path             | Tool                                           |
| ---------------- | ---------------------------------------------- |
| `/logs/`         | Dozzle live container logs                     |
| `/redis/`        | RedisInsight                                   |
| `/jaeger/`       | Jaeger trace explorer                          |
| `/mock/__admin/` | WireMock admin API when the test lab is active |

Send traces from development apps to `<tailscale-ip>:4317` (OTLP/gRPC) or `http://<tailscale-ip>:4318` (OTLP/HTTP).

Dozzle does not receive the Docker socket. A dedicated proxy exposes only read operations needed for container inventory and logs; POST, shell, and container actions are disabled.

## Project isolation

Provision from the dashboard or CLI:

```sh
PROJECT_DB_PASSWORD='<at-least-12-characters>' make provision PROJECT=example
make connections PROJECT=example
```

That creates:

- role `example`;
- databases `example` and `example_test`, both with pgvector;
- buckets `example` and `example-test`;
- Redis prefixes `example:` and `example:test:`.

Provisioning is serialized and retryable. It refuses ownership conflicts, duplicate resources, privileged role adoption, and silent password rotation. For parallel CI or agent runs, use unique names such as `example_run_42`.

## Optional failure lab

The test lab is intentionally off by default:

```sh
make lab-up
# Use the Tools page to apply a fixed fault profile.
make lab-down
```

WireMock simulates upstream APIs. Toxiproxy exposes private data-plane ports for PostgreSQL (`15434`), Redis (`16379`), and MinIO (`19100`). Its admin API is never published. The dashboard accepts only allowlisted targets and presets: healthy/reset, 500 ms latency, 2 s latency, timeout, or connection refused.

## API workbench

```sh
make api-up                 # generate private keys, provision, migrate, deploy
make api-down               # stop Hoppscotch; keep its database
```

Sign in at `http://devbox`, then open **Tools → API workbench**, or visit `http://devbox/api`. Caddy redirects to `http://devbox:3000` and checks the same dashboard session on every request, including the Hoppscotch backend and admin UI. No domain purchase or DNS change is required. For another devbox name or an IP-only setup, set `HOPPSCOTCH_HOST` in `.env` and use that same host for dashboard sign-in.

On first use, complete Hoppscotch's administrator onboarding at `http://devbox:3000/admin`. Its accounts are separate from the dashboard session. For trusted-team development, configure SMTP with `mailpit:1025` (no TLS or authentication); sign-in emails are captured by the shared Mailpit inbox. Anyone with inbox access can read those links, so this is not a production identity boundary.

Use the Browser interceptor for CORS-enabled APIs, or install the Hoppscotch Agent on your workstation for localhost APIs and CORS restrictions. The default public relay is deliberately replaced with an unusable loopback URL; select Browser or Agent instead of Proxy. Hosting the UI on devbox does not move request execution there.

The `hoppscotch` project uses the existing registry and provisioning rules, including the usual development/test databases and buckets. Only its development database is used by Hoppscotch. Keys remain in ignored `.env`; losing the encryption key can make stored encrypted configuration unreadable. Project collections and exported environments may contain secrets—keep them outside the public repository.

## Everyday commands

```sh
make ps                     # remote container status
make logs                   # follow stack logs
make smoke                  # connectivity + pgvector checks
make doctor                 # context, ports, disk, and health diagnostics
make backup DB=example      # local logical backup
make restore DB=recovery FILE=backups/example.dump
make down                   # stop the shared stack; preserve volumes
```

Coordinate `make down` with other developers. Restore always targets a new database and refuses to overwrite an existing one.

## Security model

This is trusted-team development infrastructure—not an Internet-facing control plane.

- Data ports bind only to `SHARED_INFRA_BIND_IP` (normally the devbox Tailnet address).
- The gateway may bind to all local interfaces so the short devbox hostname works on the LAN.
- Dashboard sessions are `HttpOnly`, `SameSite=Strict`, and expire after 12 hours or a restart.
- Tool routes reuse dashboard authentication through Caddy `forward_auth`.
- Database browsing is read-only; there is no arbitrary SQL console or destructive cleanup UI.
- Images are versioned, critical additions are digest-pinned, containers use bounded memory, and logs rotate.
- LAN HTTP is unencrypted. Tailscale encrypts peer traffic. Never expose these ports directly to the public Internet.

## Development

```sh
npm ci
make test
DASHBOARD_URL=http://<devbox-hostname> npm run test:ui
DASHBOARD_URL=http://<devbox-hostname> node scripts/capture-screenshots.mjs
```

The test suite covers Compose/privacy contracts, provisioning rules, authentication, telemetry validation, the tool allowlist, the fixed fault API, Python collector parsing, ShellCheck, and live browser journeys. Screenshot generation intercepts data APIs with sanitized fixtures, so committed images never reveal the active environment.

See [operations](docs/operations.md) for metric definitions, limits, upgrades, diagnostics, backups, and recovery.

## License

Copyright 2026 [DevX](https://devx.cloud).

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
