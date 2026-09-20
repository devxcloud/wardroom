# Security Policy

Wardroom is self-hosted development infrastructure for a developer or trusted team. It is not a production platform and is not a multi-tenant security boundary. Shared credentials and lightweight isolation are deliberate. Do not put production workloads or real customer data here.

## Reporting a vulnerability

Do not open a public GitHub issue for a security problem.

Use [private vulnerability reporting](https://github.com/devxcloud/wardroom/security/advisories/new) so it can be fixed before disclosure.

**In scope:** credential or hostname leaks in the public repository or CI, dashboard or MCP authentication bypass, and a project token reaching another project's data or the infrastructure admin connection.

**Out of scope:** missing tenant isolation, production availability, and issues that already require the dashboard password or an admin MCP token on a trusted-team box.

## Secrets

Never commit `.env`, `projects.local.json`, dumps, tokens, or screenshots of live data. Rotate anything that might have been committed.
