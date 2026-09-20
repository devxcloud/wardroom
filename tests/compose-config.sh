#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

env_file="$temp_dir/test.env"
rendered_file="$temp_dir/rendered.yaml"
images_file="$temp_dir/images.txt"
expected_images_file="$temp_dir/expected-images.txt"
lab_file="$temp_dir/lab.yaml"

cat >"$env_file" <<'EOF'
SHARED_INFRA_BIND_IP=100.100.100.100
SHARED_INFRA_HOST=100.100.100.100
DASHBOARD_PASSWORD=test-dashboard-password
DASHBOARD_SESSION_SECRET=test-session-secret-at-least-32-characters
AI_SETTINGS_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TELEMETRY_TOKEN=test-telemetry-token-at-least-32-characters
RI_ENCRYPTION_KEY=test-redisinsight-encryption-key-32chars
POSTGRES_ADMIN_USER=postgres
POSTGRES_ADMIN_PASSWORD=test-admin-password
REDIS_PASSWORD=test-redis-password
MINIO_ROOT_USER=shared-infra
MINIO_ROOT_PASSWORD=test-minio-password
EOF

cat >"$expected_images_file" <<'EOF'
amir20/dozzle:v10.6.15@sha256:5bb13e26b62f9bc4bd390e3e0c9423263b7df86e3a4167b718cc6e352f96b54f
axllent/mailpit:v1.27.8
ghcr.io/tecnativa/docker-socket-proxy:v0.4.2@sha256:1f3a6f303320723d199d2316a3e82b2e2685d86c275d5e3deeaf182573b47476
pgvector/pgvector:pg18@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a
quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z
quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z
redis/redisinsight:3.8.0@sha256:b5e19ee240abef6edb435871b90ff8a210995422e8e018ab61c0339d318a1f84
redis:8.0.2-alpine3.21
shared-infra-dashboard:local
shared-infra-gateway:local
shared-infra-jaeger:local
EOF

cd "$repo_root"
docker compose --env-file "$env_file" -f compose.yaml config --quiet
docker compose --env-file "$env_file" -f compose.yaml config >"$rendered_file"
docker compose --profile tools --env-file "$env_file" -f compose.yaml config --images | LC_ALL=C sort -u >"$images_file"

diff -u "$expected_images_file" "$images_file"

for port in 80 3000 4317 4318 5434 6379 9100 9101 1125 8125 8787; do
  grep -q "published: \"$port\"" "$rendered_file"
done

host_bind_count=$(grep -c 'host_ip: 100.100.100.100' "$rendered_file")
if [[ "$host_bind_count" -ne 8 ]]; then
  echo "expected eight service ports to bind to SHARED_INFRA_BIND_IP" >&2
  exit 1
fi
[[ $(grep -c 'host_ip: 0.0.0.0' "$rendered_file") -eq 3 ]]

bind_mount_count=$(grep -c 'type: bind' "$rendered_file")
if [[ "$bind_mount_count" -ne 1 ]] || ! grep -q 'source: /var/run/docker.sock' "$rendered_file"; then
  echo "only the Docker socket proxy may have a host bind mount" >&2
  exit 1
fi
grep -q 'POST: "0"' "$rendered_file"
grep -q 'DOZZLE_ENABLE_ACTIONS: "false"' "$rendered_file"
grep -q 'DOZZLE_ENABLE_SHELL: "false"' "$rendered_file"

docker compose --profile test-lab --env-file "$env_file" -f compose.yaml config >"$lab_file"
for port in 15434 16379 19100; do
  grep -q "published: \"$port\"" "$lab_file"
done
grep -q 'wiremock/wiremock:3.13.2-2-alpine@sha256:5d1fb808bbe2ac9d249a97cb0fced628c78bc4b8457e9bf62683d1265584e954' "$lab_file"
grep -q 'image: shared-infra-toxiproxy:local' "$lab_file"
if grep -q '8474:8474' "$lab_file"; then
  echo "Toxiproxy admin API must not be published" >&2
  exit 1
fi

echo "compose configuration contract passed"

docker compose --profile agents --profile agent-control --env-file "$env_file" -f compose.yaml config --format json | node --input-type=module -e '
import assert from "node:assert/strict";
let raw="";for await(const c of process.stdin) raw+=c;
const config=JSON.parse(raw);
assert.equal(config.services.mcp.ports,undefined);
assert.equal(config.services.mcp.environment.AI_SETTINGS_KEY,undefined);
assert.equal(config.services.dashboard.environment.AI_SETTINGS_KEY,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
assert.equal(config.services["agent-broker"].ports,undefined);
assert.equal(config.services["docker-proxy"].environment.POST,"0");
assert.equal(config.services["agent-broker"].networks.default,undefined);
assert.equal(config.networks["agent-control"].internal,true);
console.log("MCP network isolation contract passed");'
