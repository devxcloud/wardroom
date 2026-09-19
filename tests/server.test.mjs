import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dashboard/server.mjs";

test("authenticated API, origin checks, and static security headers", async (t) => {
  let writes = 0;
  let fault;
  const app = createApp(
    {
      overview: async () => ({ services: [] }),
      tools: {
        read: async () => ({ tools: [], lab: { active: false } }),
        applyFault: async (target, preset) => {
          fault = { target, preset };
          return fault;
        },
      },
      provision: async () => {
        writes++;
        return { name: "sample" };
      },
    },
    { password: "test-dashboard-password", host: "100.1.2.3" },
  );
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(`${base}/authz`)).status, 401);
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  const wrong = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"password":"wrong"}',
  });
  assert.equal(wrong.status, 401);
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"password":"test-dashboard-password"}',
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const headers = { Cookie: cookie, "Content-Type": "application/json" };
  assert.equal((await fetch(`${base}/authz`, { headers })).status, 204);
  assert.equal((await fetch(`${base}/api/overview`, { headers })).status, 200);
  assert.deepEqual(
    await (await fetch(`${base}/api/tools`, { headers })).json(),
    { tools: [], lab: { active: false } },
  );
  assert.equal(
    (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(writes, 0);
  assert.equal(
    (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    201,
  );
  assert.equal(writes, 1);
  const faultResponse = await fetch(`${base}/api/lab/fault`, {
    method: "POST",
    headers,
    body: JSON.stringify({ target: "redis", preset: "timeout" }),
  });
  assert.equal(faultResponse.status, 200);
  assert.deepEqual(await faultResponse.json(), {
    target: "redis",
    preset: "timeout",
  });
  assert.deepEqual(fault, { target: "redis", preset: "timeout" });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal(
    (await fetch(`${base}/fonts/manrope/files/manrope-latin-wght-normal.woff2`))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(9000),
      })
    ).status,
    413,
  );
});
