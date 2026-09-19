import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dashboard/server.mjs";

const config = {
  password: "test-dashboard-password",
  sessionSecret: "test-session-secret-at-least-32-characters",
};
async function start(t, settings = config) {
  const app = createApp({}, settings);
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  return `http://127.0.0.1:${app.address().port}`;
}
async function login(base, rememberDevice) {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: config.password, rememberDevice }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie");
}
test("only explicit remember-device opt-in extends session to 30 days", async (t) => {
  const base = await start(t);
  for (const [choice, seconds] of [
    [undefined, 43200],
    [false, 43200],
    ["true", 43200],
    [true, 2592000],
  ]) {
    const before = Date.now();
    const cookie = await login(base, choice);
    assert.match(cookie, new RegExp(`Max-Age=${seconds}$`));
    assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\//);
    const expires = Number(cookie.split("=")[1].split(".")[0]);
    assert.ok(expires >= before + seconds * 1000);
    assert.ok(expires <= Date.now() + seconds * 1000);
  }
});
test("remembered sessions survive restart but not password or signing-key rotation", async (t) => {
  const cookie = (await login(await start(t), true)).split(";")[0];
  for (const [settings, status] of [
    [config, 204],
    [{ ...config, password: "changed-dashboard-password" }, 401],
    [
      {
        ...config,
        sessionSecret: "another-session-secret-at-least-32-characters",
      },
      401,
    ],
  ]) {
    const base = await start(t, settings);
    assert.equal(
      (await fetch(`${base}/authz`, { headers: { Cookie: cookie } })).status,
      status,
    );
  }
  const base = await start(t);
  const logout = await fetch(`${base}/api/logout`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /infra_session=;.*Max-Age=0/);
});
