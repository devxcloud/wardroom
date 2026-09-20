import { test } from "node:test";
import assert from "node:assert/strict";
import { completeTurn, testConnection } from "../dashboard/ai/provider.mjs";

const response = (parts, status = 200) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts)
          controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }),
    { status },
  );

test("provider decodes split text, tool calls and usage", async () => {
  let request;
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","function":{"name":"project_","arguments":"{\\"pro"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"list","arguments":"ject\\":\\"sample\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":9}}\n\n',
    "data: [DONE]\n\n",
  ];
  const seen = [];
  const result = await completeTurn({
    connection: {
      baseUrl: "https://provider.test/v1",
      model: "sample",
      apiKey: "secret",
    },
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    signal: new AbortController().signal,
    onText: (value) => seen.push(value),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(chunks);
    },
  });
  assert.equal(seen.join(""), "Hello");
  assert.deepEqual(result.toolCalls, [
    { id: "call_1", name: "project_list", arguments: '{"project":"sample"}' },
  ]);
  assert.equal(result.usage.total_tokens, 9);
  assert.equal(request.url, "https://provider.test/v1/chat/completions");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
});

test("provider rejects malformed streams without exposing upstream bodies", async () => {
  await assert.rejects(
    () =>
      completeTurn({
        connection: { baseUrl: "https://provider.test/v1", model: "sample" },
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        onText() {},
        fetchImpl: async () => response(["private upstream failure"], 500),
      }),
    (error) =>
      error.message ===
      "Provider request failed. Check the connection and model.",
  );
  await assert.rejects(() =>
    completeTurn({
      connection: { baseUrl: "https://provider.test/v1", model: "sample" },
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      onText() {},
      fetchImpl: async () => response(['data: {"choices":[]\n\n']),
    }),
  );
});

test("connection test sends no tools or infrastructure context", async () => {
  let body;
  await testConnection(
    { baseUrl: "https://provider.test/v1", model: "sample" },
    {
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return response([
          'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ]);
      },
    },
  );
  assert.equal(body.tools, undefined);
  assert.equal(body.messages.length, 1);
});
