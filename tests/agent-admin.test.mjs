import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dashboard/server.mjs";

test("token management requires dashboard session, rejects cross-origin writes and validates inputs", async (t) => {
  const issued = [];
  const agents = {
    list: async () => [
      {
        id: "8b6d8849-78db-4f50-ae3a-7d2c91dca398",
        label: "test",
        scope: "project",
        project: "sample",
      },
    ],
    issue: async (value) => {
      issued.push(value);
      return { token: "one-time-secret", ...value };
    },
    revoke: async () => ({ revoked: true }),
  };
  const app = createApp(
    { agents },
    { password: "test-dashboard-password", host: "devbox" },
  );
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base + "/api/agent-tokens")).status, 401);
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-dashboard-password" }),
  });
  const headers = {
    "Content-Type": "application/json",
    Cookie: login.headers.get("set-cookie").split(";")[0],
  };
  const post = (body, extra = {}) =>
    fetch(base + "/api/agent-tokens", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post(
        { label: "test", project: "sample" },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await post({ label: "test", project: "postgres" })).status,
    400,
  );
  assert.equal(issued.length, 0);
  const response = await post({ label: "test", project: "sample" });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).token, "one-time-secret");
  assert.equal(issued[0].destructive, false);
  const list = await fetch(base + "/api/agent-tokens", { headers });
  assert.equal(list.status, 200);
  assert.doesNotMatch(await list.text(), /one-time-secret/);
  assert.equal(
    (
      await fetch(base + "/api/agent-tokens/revoke", {
        method: "POST",
        headers,
        body: '{"id":"invalid"}',
      })
    ).status,
    400,
  );
});
