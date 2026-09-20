# Wardroom

Public name: Wardroom. Repository: https://github.com/devxcloud/wardroom. Read README.md and docs/operations.md before changing infrastructure. Hostnames, SSH endpoints, and Docker context names belong in ignored .env, not public source or docs. Caddy serves the dashboard on the configured host, with port 8787 as fallback; its source is dashboard/.

Scope: development-workflow tooling for a developer or trusted team, not a commercial hosted infrastructure service or a production/multi-tenant platform. Favor simple shared dev services and debugging tools. Do not add billing, tenancy, production availability promises, or operational complexity without an explicit request.

- Use scripts/compose.sh or Make targets, which verify DOCKER_CONTEXT against DOCKER_ENDPOINT. Never change the globally selected Docker context.
- Containers, images, builds and volumes belong on the configured remote host. Do not start duplicate local services or add workstation bind mounts. Preserve the existing shared-infra Compose project and telemetry service identifiers; renaming them is a data migration, not branding.
- Use the project registry and shared provisioning implementation in dashboard/infra.mjs. CLI and web must enforce the same resource ownership rules.
- Preserve existing project passwords, databases, buckets and named volumes. Use uniquely named temporary resources for integration tests and clean up only those exact resources.
- Keep .env, backups, screenshots containing data, and credentials out of version control. Never print raw database errors that might include SQL or credentials.
- The dashboard retains read-only database browsing. Optional MCP provides scoped mutations; arbitrary SQL is allowed only through an actual unprivileged project login and a destructive-enabled token, never an admin connection or SET ROLE fallback. No arbitrary shell execution. Only the private allowlisted control broker and existing read-only proxy may mount the Docker socket; never publish either. Host telemetry is pushed by the separate telemetry/ user service; reinstall it with make telemetry after collector changes.
- Run make test after changes. For UI work, run npm run test:ui against a running dashboard and inspect desktop/mobile screenshots. Tests create and remove isolated test projects.
- Files end with exactly one newline. Never stage files unless the user explicitly asks.
