import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Infrastructure } from "../../dashboard/infra.mjs";
import { configFrom } from "../../dashboard/config.mjs";
import { AgentStore } from "../../dashboard/agent/store.mjs";
import { AgentResources } from "../../dashboard/agent/resources.mjs";
import { remoteFetch } from "./remote-fetch.mjs";

const testFetch = process.env.MCP_TEST_SSH === "1" ? remoteFetch : fetch;

test("deployed MCP gateway supports current and legacy clients with real scoped writes", async () => {
  const config = configFrom();
  const infra = new Infrastructure(config);
  const store = new AgentStore(infra.pool, config.sessionSecret);
  const project = `mcp_${randomBytes(5).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const clients = [];
  let token;
  let provisioned = false;
  const endpoint = new URL(
    process.env.MCP_TEST_URL || `http://${config.host}/mcp`,
  );
  try {
    token = await store.issue({
      label: "MCP integration test",
      project,
      destructive: true,
    });
    const headers = { Authorization: `Bearer ${token.token}` };
    assert.equal((await testFetch(endpoint, { method: "POST" })).status, 401);
    for (const [Constructor, Transport] of [
      [Client, StreamableHTTPClientTransport],
      [LegacyClient, LegacyTransport],
    ]) {
      const c = new Constructor({ name: "wardroom-integration", version: "1" });
      clients.push(c);
      await c.connect(
        new Transport(endpoint, { requestInit: { headers }, fetch: testFetch }),
      );
      const tools = (await c.listTools()).tools;
      assert.ok(tools.some((t) => t.name === "project_provision"));
      assert.ok(!tools.some((t) => t.name === "container_action"));
    }
    const client = clients[0];
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      return result.structuredContent;
    };
    const mutate = (name, args = {}) =>
      call(name, { project, operationId: randomUUID(), ...args });
    await mutate("project_provision", { password });
    provisioned = true;
    const result = await mutate("sql_execute", {
      database: project,
      user: project,
      password,
      sql: "CREATE TABLE mcp_check (n integer); INSERT INTO mcp_check VALUES (42); SELECT n FROM mcp_check",
    });
    assert.equal(result.result.rows[0].n, 42);
    await mutate("redis_set", { key: "check", value: "ready" });
    assert.equal(
      (await call("redis_get", { project, key: "check" })).value,
      "ready",
    );
    const bucket = project.replaceAll("_", "-");
    await mutate("object_put", { bucket, key: "check.txt", base64: "b2s=" });
    assert.equal(
      (await call("object_get", { project, bucket, key: "check.txt" })).base64,
      "b2s=",
    );
    const metrics = await call("system_metrics");
    assert.equal(typeof metrics.available, "boolean");
    const mock = await mutate("mock_create", {
      method: "GET",
      path: "/hello",
      status: 200,
      body: "hello",
    });
    await mutate("mock_delete", { id: mock.result.id });
    const crossed = await client.callTool({
      name: "project_get",
      arguments: { project: "other_project" },
    });
    assert.equal(crossed.isError, true);
    await mutate("project_retire");
    provisioned = false;
    await store.revoke(token.id);
    await assert.rejects(clients[1].listTools());
  } finally {
    for (const client of clients) await client.close();
    if (provisioned) await new AgentResources(infra).retire(project);
    if (token) {
      await infra.pool.query(
        "DELETE FROM shared_infra.agent_operations WHERE token_id=$1",
        [token.id],
      );
      await infra.pool.query(
        "DELETE FROM shared_infra.agent_tokens WHERE id=$1",
        [token.id],
      );
    }
    await infra.close();
  }
});

test(
  "deployed broker controls only the disposable agent-check service",
  { skip: process.env.AGENT_BROKER_TEST !== "1" },
  async () => {
    const config = configFrom();
    const infra = new Infrastructure(config);
    const store = new AgentStore(infra.pool, config.sessionSecret);
    const token = await store.issue({
      label: "broker integration test",
      scope: "admin",
      destructive: true,
    });
    const client = new Client({ name: "broker-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://${config.host}/mcp`),
          {
            requestInit: {
              headers: { Authorization: `Bearer ${token.token}` },
            },
            fetch: testFetch,
          },
        ),
      );
      const denied = await client.callTool({
        name: "container_action",
        arguments: {
          operationId: randomUUID(),
          service: "gateway",
          action: "restart",
        },
      });
      assert.equal(denied.isError, true);
      for (const action of ["stop", "start", "restart"]) {
        const result = await client.callTool({
          name: "container_action",
          arguments: {
            operationId: randomUUID(),
            service: "agent-check",
            action,
          },
        });
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
      }
      const logs = await client.callTool({
        name: "container_logs",
        arguments: { service: "agent-check", lines: 10 },
      });
      assert.notEqual(logs.isError, true, logs.content?.[0]?.text);
      assert.match(logs.structuredContent.text, /disposable control test/);
    } finally {
      await client.close();
      await store.revoke(token.id);
      await infra.pool.query(
        "DELETE FROM shared_infra.agent_operations WHERE token_id=$1",
        [token.id],
      );
      await infra.pool.query(
        "DELETE FROM shared_infra.agent_tokens WHERE id=$1",
        [token.id],
      );
      await infra.close();
    }
  },
);
