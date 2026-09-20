import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AiConversations } from "../dashboard/ai/conversations.mjs";

test("conversation owns scope, executes audited tools and streams visible activity", async (t) => {
  const calls = [];
  let completions = 0;
  let revoked = false;
  const actor = {
    id: "token-id",
    scope: "project",
    project: "sample",
    destructive: false,
  };
  const store = {
    issueChat: async () => ({ token: "wr_private", id: "token-id" }),
    authenticate: async () => {
      if (revoked) throw Error("revoked");
      return actor;
    },
    revoke: async () => {
      revoked = true;
    },
  };
  const definition = {
    name: "project_list",
    description: "List projects",
    schema: z.object({ project: z.string() }),
    mutation: false,
  };
  const catalog = {
    visible: () => [definition],
    call: async (receivedActor, name, args) => {
      calls.push({ receivedActor, name, args });
      return { project: args.project };
    },
  };
  const complete = async ({ messages, tools, onText }) => {
    completions++;
    assert.equal(tools[0].function.name, "project_list");
    if (completions === 1)
      assert.equal(
        messages.at(-1).content,
        "[Wardroom view: Projects]\nInspect my project",
      );
    if (completions === 1)
      return {
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "project_list",
            arguments: '{"project":"sample"}',
          },
        ],
      };
    assert.equal(messages.at(-1).role, "tool");
    onText("Done.");
    return { content: "Done.", toolCalls: [], usage: { total_tokens: 12 } };
  };
  const manager = new AiConversations({
    settings: {
      private: async () => ({
        baseUrl: "https://provider.test/v1",
        model: "sample",
      }),
    },
    store,
    catalog,
    complete,
  });
  t.after(() => manager.dispose());
  const chat = await manager.create("owner-a", {
    scope: "project",
    project: "sample",
    destructive: false,
  });
  assert.throws(() => manager.get("owner-b", chat.id));
  const events = [];
  await manager.turn(
    "owner-a",
    chat.id,
    "Inspect my project",
    (event) => events.push(event),
    new AbortController().signal,
    "Projects",
  );
  assert.equal(calls[0].receivedActor.project, "sample");
  assert.equal(calls[0].args.operationId, undefined);
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-start", "tool-result", "text", "usage", "done"],
  );
  assert.equal(manager.get("owner-a", chat.id).scope.project, "sample");
});

test("global conversation pauses mutations until one operation is approved", async (t) => {
  const calls = [];
  const issued = [];
  const revoked = [];
  let completions = 0;
  const definition = {
    name: "project_retire",
    description: "Retire one project",
    schema: z.object({
      project: z.string(),
      operationId: z.string().uuid().optional(),
    }),
    mutation: true,
    destructive: true,
  };
  const store = {
    issueChat: async (scope) => {
      issued.push(scope);
      return { token: `token-${issued.length}`, id: `token-${issued.length}` };
    },
    authenticate: async (token) => ({
      id: token,
      scope: "admin",
      destructive: token === "token-2",
    }),
    revoke: async (id) => revoked.push(id),
  };
  const manager = new AiConversations({
    settings: {
      private: async () => ({
        baseUrl: "https://provider.test/v1",
        model: "sample",
      }),
    },
    store,
    catalog: {
      visible: () => [],
      visibleForApproval: () => [definition],
      call: async (actor, name, args) => {
        calls.push({ actor, name, args });
        return { retired: args.project };
      },
    },
    complete: async ({ messages, onText }) => {
      completions++;
      assert.match(messages[0].content, /one-operation approval/);
      if (completions === 1)
        return {
          content: "",
          toolCalls: [
            {
              id: "call-retire",
              name: "project_retire",
              arguments: '{"project":"sample"}',
            },
          ],
        };
      onText("Project retired.");
      return { content: "Project retired.", toolCalls: [] };
    },
  });
  t.after(() => manager.dispose());
  const chat = await manager.create("owner-a", {
    scope: "admin",
    destructive: false,
  });
  const initial = [];
  await manager.turn(
    "owner-a",
    chat.id,
    "Retire sample",
    (event) => initial.push(event),
    new AbortController().signal,
  );
  assert.equal(calls.length, 0);
  assert.equal(initial.at(-2).type, "approval-required");
  assert.equal(initial.at(-2).target.project, "sample");
  assert.equal(initial.at(-2).destructive, true);
  const resumed = [];
  await manager.approve(
    "owner-a",
    chat.id,
    initial.at(-2).approvalId,
    (event) => resumed.push(event),
    new AbortController().signal,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor.destructive, true);
  assert.match(calls[0].args.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(issued[1].destructive, true);
  assert.deepEqual(revoked, ["token-2"]);
  assert.deepEqual(
    resumed.map((event) => event.type),
    ["tool-start", "tool-result", "text", "done"],
  );
});

test("auto mode runs ordinary writes without approval", async (t) => {
  const calls = [];
  let completions = 0;
  const definition = {
    name: "database_create",
    description: "Create an extra database",
    schema: z.object({
      project: z.string(),
      operationId: z.string().uuid().optional(),
    }),
    mutation: true,
  };
  const manager = new AiConversations({
    settings: {
      private: async () => ({
        baseUrl: "https://provider.test/v1",
        model: "sample",
      }),
    },
    store: {
      issueChat: async () => ({ token: "token-1", id: "token-1" }),
      authenticate: async () => ({
        id: "token-1",
        scope: "admin",
        destructive: false,
      }),
      revoke: async () => {},
    },
    catalog: {
      visible: () => [],
      visibleForApproval: () => [definition],
      call: async (actor, name, args) => {
        calls.push({ actor, name, args });
        return { database: "sample_extra" };
      },
    },
    complete: async ({ messages, onText }) => {
      completions++;
      assert.match(messages[0].content, /ordinary writes run immediately/i);
      if (completions === 1)
        return {
          content: "",
          toolCalls: [
            {
              id: "call-create",
              name: "database_create",
              arguments: '{"project":"sample"}',
            },
          ],
        };
      onText("Created.");
      return { content: "Created.", toolCalls: [] };
    },
  });
  t.after(() => manager.dispose());
  const chat = await manager.create("owner-a", {
    scope: "admin",
    destructive: false,
    auto: true,
  });
  assert.equal(chat.auto, true);
  const events = [];
  await manager.turn(
    "owner-a",
    chat.id,
    "Create extra database",
    (event) => events.push(event),
    new AbortController().signal,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "database_create");
  assert.equal(
    events.some((event) => event.type === "approval-required"),
    false,
  );
});

test("auto mode still pauses destructive writes for approval", async (t) => {
  const calls = [];
  const definition = {
    name: "project_retire",
    description: "Retire one project",
    schema: z.object({
      project: z.string(),
      operationId: z.string().uuid().optional(),
    }),
    mutation: true,
    destructive: true,
  };
  const manager = new AiConversations({
    settings: {
      private: async () => ({
        baseUrl: "https://provider.test/v1",
        model: "sample",
      }),
    },
    store: {
      issueChat: async () => ({ token: "token-1", id: "token-1" }),
      authenticate: async () => ({
        id: "token-1",
        scope: "admin",
        destructive: false,
      }),
      revoke: async () => {},
    },
    catalog: {
      visible: () => [],
      visibleForApproval: () => [definition],
      call: async () => {
        calls.push(true);
        return { retired: true };
      },
    },
    complete: async () => ({
      content: "",
      toolCalls: [
        {
          id: "call-retire",
          name: "project_retire",
          arguments: '{"project":"sample"}',
        },
      ],
    }),
  });
  t.after(() => manager.dispose());
  const chat = await manager.create("owner-a", {
    scope: "admin",
    destructive: false,
    auto: true,
  });
  const events = [];
  await manager.turn(
    "owner-a",
    chat.id,
    "Retire sample",
    (event) => events.push(event),
    new AbortController().signal,
  );
  assert.equal(calls.length, 0);
  assert.equal(events.at(-2).type, "approval-required");
  assert.equal(events.at(-2).destructive, true);
});

test("protected conversations can switch to auto for the next tool call", async (t) => {
  const calls = [];
  let completions = 0;
  const definition = {
    name: "database_create",
    description: "Create an extra database",
    schema: z.object({
      project: z.string(),
      operationId: z.string().uuid().optional(),
    }),
    mutation: true,
  };
  const manager = new AiConversations({
    settings: {
      private: async () => ({
        baseUrl: "https://provider.test/v1",
        model: "sample",
      }),
    },
    store: {
      issueChat: async () => ({ token: "token-1", id: "token-1" }),
      authenticate: async () => ({
        id: "token-1",
        scope: "admin",
        destructive: false,
      }),
      revoke: async () => {},
    },
    catalog: {
      visible: () => [],
      visibleForApproval: () => [definition],
      call: async (_actor, name) => {
        calls.push(name);
        return { ok: true };
      },
    },
    complete: async ({ onText }) => {
      completions++;
      if (completions === 1)
        return {
          content: "",
          toolCalls: [
            {
              id: "call-create",
              name: "database_create",
              arguments: '{"project":"sample"}',
            },
          ],
        };
      onText("Created.");
      return { content: "Created.", toolCalls: [] };
    },
  });
  t.after(() => manager.dispose());
  const chat = await manager.create("owner-a", {
    scope: "admin",
    destructive: false,
  });
  assert.equal(chat.auto, false);
  const updated = manager.setAuto("owner-a", chat.id, true);
  assert.equal(updated.auto, true);
  const events = [];
  await manager.turn(
    "owner-a",
    chat.id,
    "Create extra database",
    (event) => events.push(event),
    new AbortController().signal,
  );
  assert.deepEqual(calls, ["database_create"]);
  assert.equal(
    events.some((event) => event.type === "approval-required"),
    false,
  );
});

test("conversation rejects cross-owner access, oversized messages and concurrent turns", async (t) => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const manager = new AiConversations({
    settings: {
      private: async () => ({
        baseUrl: "https://provider.test/v1",
        model: "sample",
      }),
    },
    store: {
      issueChat: async () => ({ token: "wr_private" }),
      authenticate: async () => ({ scope: "admin", destructive: false }),
      revoke: async () => {},
    },
    catalog: { visible: () => [], call: async () => ({}) },
    complete: async () => {
      await waiting;
      return { content: "ok", toolCalls: [] };
    },
  });
  t.after(() => manager.dispose());
  const chat = await manager.create("owner-a", {
    scope: "admin",
    destructive: false,
  });
  assert.throws(() => manager.get("owner-b", chat.id));
  await assert.rejects(() =>
    manager.turn(
      "owner-a",
      chat.id,
      "x".repeat(32769),
      () => {},
      new AbortController().signal,
    ),
  );
  const active = manager.turn(
    "owner-a",
    chat.id,
    "hello",
    () => {},
    new AbortController().signal,
  );
  await assert.rejects(() =>
    manager.turn(
      "owner-a",
      chat.id,
      "again",
      () => {},
      new AbortController().signal,
    ),
  );
  release();
  await active;
});
