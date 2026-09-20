import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpApp } from "../dashboard/agent/mcp.mjs";
import { createCatalog } from "../dashboard/agent/catalog.mjs";
import { InputError } from "../dashboard/domain.mjs";

test("MCP authenticates every request and exposes only caller-scoped tools and records", async (t) => {
  const actor = {
    id: "test",
    scope: "project",
    project: "alpha",
    destructive: false,
  };
  let revoked = false;
  const store = {
    authenticate: async (token) => {
      if (token !== "test-token" || revoked)
        throw new InputError("Invalid credentials", 401);
      return actor;
    },
  };
  const catalog = createCatalog(
    { projects: async () => [{ name: "alpha" }, { name: "beta" }] },
    store,
  );
  const app = createMcpApp({ catalog, store, hosts: ["127.0.0.1"] });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base + "/mcp", { method: "POST" })).status, 401);
  assert.equal(
    (
      await fetch(base + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          Origin: "https://evil.test",
        },
      })
    ).status,
    403,
  );
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request(
      base + "/mcp",
      {
        method: "POST",
        headers: { Authorization: "Bearer test-token", Host: "evil.test" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(wrongHost, 403);
  const client = new Client({ name: "test", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer test-token" } },
    }),
  );
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("project_provision"));
  assert.ok(!names.includes("container_action"));
  assert.ok(!names.includes("sql_execute"));
  const result = await client.callTool({ name: "project_list", arguments: {} });
  assert.deepEqual(result.structuredContent.projects, [{ name: "alpha" }]);
  assert.equal(
    (
      await client.callTool({
        name: "project_get",
        arguments: { project: "beta" },
      })
    ).isError,
    true,
  );
  revoked = true;
  await assert.rejects(client.listTools());
});

test("project metrics include actual aggregate sample without container identities", async () => {
  const catalog = createCatalog(
    {
      telemetry: {
        read: async () => ({
          sample: {
            collectedAt: "now",
            cpu: { percent: 25 },
            lvm: {
              available: true,
              volumeGroups: [{ name: "ubuntu-vg", freeBytes: 850 }],
            },
            docker: { items: [{ name: "other_project" }] },
          },
          stale: false,
          history: [],
        }),
      },
    },
    {},
  );
  const result = await catalog.call(
    { scope: "project", project: "alpha" },
    "system_metrics",
    {},
  );
  assert.equal(result.cpu.percent, 25);
  assert.equal(result.lvm.volumeGroups[0].freeBytes, 850);
  assert.doesNotMatch(JSON.stringify(result), /other_project/);
});
