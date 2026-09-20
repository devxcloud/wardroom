DOCKER_COMPOSE = bash scripts/compose.sh

.PHONY: context config up down ps logs provision smoke test doctor backup restore connections telemetry lab-up lab-down api-up api-down
.PHONY: mcp-up mcp-down agent-token agent-tokens agent-revoke agent-history

mcp-up:
	node scripts/ensure-private-config.mjs
	$(DOCKER_COMPOSE) --profile agents up -d --build --wait --wait-timeout 120 mcp agent-broker host-broker dashboard gateway

mcp-down:
	$(DOCKER_COMPOSE) --profile agents stop mcp

agent-token:
	node scripts/agent-token.mjs issue $(ARGS)

agent-tokens:
	node scripts/agent-token.mjs list

agent-revoke:
	node scripts/agent-token.mjs revoke --id "$(ID)"

agent-history:
	node scripts/agent-token.mjs history

context:
	./scripts/setup-context.sh

config:
	$(DOCKER_COMPOSE) config --quiet

up:
	$(DOCKER_COMPOSE) up --build --wait --wait-timeout 120

lab-up:
	$(DOCKER_COMPOSE) --profile test-lab up -d --build --wait --wait-timeout 120 wiremock toxiproxy

lab-down:
	$(DOCKER_COMPOSE) --profile test-lab stop wiremock toxiproxy

api-up:
	node scripts/ensure-private-config.mjs --api
	node --env-file=.env scripts/provision-api.mjs
	$(DOCKER_COMPOSE) --profile api-tools run --rm --no-deps --entrypoint sh hoppscotch -c 'pnpm exec prisma migrate deploy'
	$(DOCKER_COMPOSE) --profile api-tools up -d --build --wait --wait-timeout 180 hoppscotch dashboard gateway

api-down:
	$(DOCKER_COMPOSE) --profile api-tools stop hoppscotch

down:
	$(DOCKER_COMPOSE) down

ps:
	$(DOCKER_COMPOSE) ps

logs:
	$(DOCKER_COMPOSE) logs -f --tail=100

provision:
	@test -n "$(PROJECT)" || (echo "PROJECT is required" >&2; exit 2)
	bash scripts/provision-project.sh "$(PROJECT)"

smoke:
	bash scripts/smoke.sh

test:
	@set -e; for test_file in tests/*.sh; do bash "$$test_file"; done
	npm test
	PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py'
	shellcheck scripts/*.sh tests/*.sh

telemetry:
	node scripts/install-telemetry.mjs

doctor:
	bash scripts/doctor.sh

backup:
	bash scripts/backup.sh "$(DB)"

restore:
	bash scripts/restore.sh "$(DB)" "$(FILE)"

connections:
	@test -n "$(PROJECT)" || (echo "PROJECT is required" >&2; exit 2)
	$(DOCKER_COMPOSE) exec -T dashboard node dashboard/cli.mjs connections "$(PROJECT)"
