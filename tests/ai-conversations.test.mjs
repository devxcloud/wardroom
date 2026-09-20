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
    mutation: true,
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
  );
  assert.equal(calls[0].receivedActor.project, "sample");
  assert.match(calls[0].args.operationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool-start", "tool-result", "text", "usage", "done"],
  );
  assert.equal(manager.get("owner-a", chat.id).scope.project, "sample");
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
