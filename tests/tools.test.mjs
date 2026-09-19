import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../dashboard/tools.mjs";

const urls = {
  logs: "http://logs/health",
  redis: "http://redis/health",
  traces: "http://traces/health",
  api: "http://hoppscotch/backend/ping",
  wiremock: "http://wiremock/health",
  toxiproxy: "http://toxiproxy/version",
};

test("tool health is allowlisted and exposes private developer endpoints", async () => {
  const fetchImpl = async (url) => {
    if (url === urls.redis) return { ok: false, status: 503 };
    if (url === urls.wiremock || url === urls.toxiproxy)
      throw new Error("connect ECONNREFUSED with secret upstream text");
    return { ok: true, status: 200 };
  };
  const tools = await new ToolService({
    fetchImpl,
    urls,
    host: "100.100.100.100",
  }).read();

  assert.deepEqual(tools, {
    tools: [
      { id: "api", status: "healthy", detail: "API workbench is ready." },
      { id: "logs", status: "healthy", detail: "Container logs are ready." },
      {
        id: "redis",
        status: "unavailable",
        detail: "Redis workspace is unavailable.",
      },
      {
        id: "traces",
        status: "healthy",
        detail: "Trace explorer is ready.",
      },
    ],
    lab: {
      active: false,
      wiremock: "inactive",
      toxiproxy: "inactive",
    },
    connections: {
      otlpGrpc: "100.100.100.100:4317",
      otlpHttp: "http://100.100.100.100:4318",
      postgresProxy: "100.100.100.100:15434",
      redisProxy: "100.100.100.100:16379",
      minioProxy: "http://100.100.100.100:19100",
    },
  });
  assert.doesNotMatch(JSON.stringify(tools), /secret|ECONNREFUSED/);
});

test("optional API workbench is parked when its backend cannot be reached", async () => {
  const service = new ToolService({
    urls,
    fetchImpl: async (url) => {
      if (url === urls.api) throw new Error("private connection details");
      return { ok: true };
    },
  });
  const result = await service.read();
  assert.deepEqual(
    result.tools.find((tool) => tool.id === "api"),
    {
      id: "api",
      status: "inactive",
      detail: "Start with make api-up.",
    },
  );
});

test("test lab is active only when both services answer", async () => {
  const result = await new ToolService({
    urls,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    host: "devbox",
  }).read();
  assert.deepEqual(result.lab, {
    active: true,
    wiremock: "healthy",
    toxiproxy: "healthy",
  });
});

test("fault injection accepts only fixed targets and presets", async () => {
  const calls = [];
  const service = new ToolService({
    urls,
    fetchImpl: async (url, options = {}) => {
      calls.push([url, options.method || "GET", options.body]);
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(await service.applyFault("postgres", "latency-500"), {
    target: "postgres",
    preset: "latency-500",
  });
  assert.deepEqual(calls, [
    [
      "http://toxiproxy/proxies/postgres/toxics/shared-infra-fault",
      "DELETE",
      undefined,
    ],
    [
      "http://toxiproxy/proxies/postgres",
      "POST",
      JSON.stringify({ enabled: true }),
    ],
    [
      "http://toxiproxy/proxies/postgres/toxics",
      "POST",
      JSON.stringify({
        name: "shared-infra-fault",
        type: "latency",
        stream: "downstream",
        toxicity: 1,
        attributes: { latency: 500, jitter: 0 },
      }),
    ],
  ]);
  await assert.rejects(
    () => service.applyFault("admin", "latency-500"),
    /Unknown fault target/,
  );
  await assert.rejects(
    () => service.applyFault("postgres", "arbitrary"),
    /Unknown fault preset/,
  );
});
