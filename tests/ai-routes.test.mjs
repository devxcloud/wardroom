import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dashboard/server.mjs";

test("AI routes require dashboard authentication and stream server-owned events", async (t) => {
  const chatId = "8b6d8849-78db-4f50-ae3a-7d2c91dca398";
  const created = [];
  const turns = [];
  const ai = {
    settings: {
      public: async () => ({
        configured: true,
        baseUrl: "https://provider.test/v1",
        model: "sample",
        hasKey: true,
      }),
      save: async (value) => ({
        configured: true,
        baseUrl: value.baseUrl,
        model: value.model,
        hasKey: Boolean(value.apiKey),
      }),
      private: async () => ({
        baseUrl: "https://provider.test/v1",
        model: "sample",
        apiKey: "secret",
      }),
      remove: async () => ({ removed: true }),
    },
    conversations: {
      create: async (owner, scope) => {
        created.push({ owner, scope });
        return { id: chatId, scope, events: [] };
      },
      get: () => ({
        id: chatId,
        scope: { scope: "project", project: "sample" },
        events: [],
      }),
      turn: async (_owner, _id, message, emit, _signal, context) => {
        turns.push({ message, context });
        emit({ type: "text", text: "Hello" });
        emit({ type: "done" });
      },
      approve: async (_owner, _id, approvalId, emit) => {
        assert.equal(approvalId, "approval-1");
        emit({ type: "tool-result", id: "call-1", ok: true });
        emit({ type: "done" });
      },
      reject: () => ({ rejected: true }),
      stop: () => ({ stopped: true }),
      close: async () => ({ closed: true }),
      closeOwner: async () => {},
      setAuto: (_owner, id, auto) => {
        assert.equal(id, chatId);
        return {
          id: chatId,
          scope: { scope: "admin", destructive: false },
          auto,
          events: [],
        };
      },
    },
  };
  const app = createApp(
    { ai },
    { password: "test-dashboard-password", host: "devbox" },
  );
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base + "/api/ai/settings")).status, 401);
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-dashboard-password" }),
  });
  const headers = {
    "Content-Type": "application/json",
    Cookie: login.headers.get("set-cookie").split(";")[0],
  };
  const settings = await fetch(base + "/api/ai/settings", { headers });
  assert.equal(settings.status, 200);
  assert.doesNotMatch(await settings.text(), /secret/);
  const crossOrigin = await fetch(base + "/api/ai/conversations", {
    method: "POST",
    headers: { ...headers, Origin: "https://evil.example" },
    body: JSON.stringify({ scope: "project", project: "sample" }),
  });
  assert.equal(crossOrigin.status, 403);
  const conversation = await fetch(base + "/api/ai/conversations", {
    method: "POST",
    headers,
    body: JSON.stringify({
      scope: "project",
      project: "sample",
      destructive: false,
    }),
  });
  assert.equal(conversation.status, 201);
  assert.equal(created[0].scope.project, "sample");
  const stream = await fetch(
    base + `/api/ai/conversations/${chatId}/messages`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "Hello", context: "AI & MCP" }),
    },
  );
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  const output = await stream.text();
  assert.match(output, /"type":"text"/);
  assert.match(output, /"type":"done"/);
  assert.deepEqual(turns, [{ message: "Hello", context: "AI & MCP" }]);
  const approval = await fetch(
    base + `/api/ai/conversations/${chatId}/approve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ approvalId: "approval-1" }),
    },
  );
  assert.match(approval.headers.get("content-type"), /text\/event-stream/);
  assert.match(await approval.text(), /"type":"tool-result"/);
  const policy = await fetch(base + `/api/ai/conversations/${chatId}/policy`, {
    method: "POST",
    headers,
    body: JSON.stringify({ auto: true }),
  });
  assert.equal(policy.status, 200);
  assert.equal((await policy.json()).auto, true);
});
