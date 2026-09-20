# Contributing

Wardroom is trusted-team development tooling. Keep it simple. Do not add billing, tenancy, or production availability promises without an explicit request.

## Checks

```sh
npm ci
make test
```

GitHub Actions runs that same `make test` job. It does not start services or talk to a live host.

For UI work, run `npm run test:ui` against a running dashboard. Integration tests must use uniquely named temporary projects and clean up only those resources.

## Constraints

- Use `scripts/compose.sh` or Make targets. Never `docker context use`, and never start duplicate local services.
- Hostnames, SSH endpoints, Docker context names, and credentials belong in ignored `.env`, not source or docs.
- Arbitrary SQL is allowed only through an unprivileged project login and a destructive-enabled token.
- Only the private allowlisted control broker and the existing read-only proxy may mount the Docker socket; never publish either.
- Files end with exactly one newline.

See `AGENTS.md` for the full operator contract and `docs/operations.md` for lifecycle commands.
