import { InputError } from "../domain.mjs";

const fail = (message = "Provider returned an invalid streaming response.") =>
  new InputError(message, 502);

export async function completeTurn({
  connection,
  messages,
  tools,
  signal,
  onText = () => {},
  fetchImpl = fetch,
}) {
  let response;
  try {
    response = await fetchImpl(`${connection.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(connection.apiKey
          ? { Authorization: `Bearer ${connection.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: connection.model,
        messages,
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 4096,
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw fail("Provider is unreachable. Check the connection URL.");
  }
  if (!response.ok)
    throw fail(
      response.status === 401 || response.status === 403
        ? "Provider rejected the API key."
        : "Provider request failed. Check the connection and model.",
    );
  if (!response.body) throw fail();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage;
  let done = false;
  let finishReason;
  const calls = new Map();
  const consume = (payload) => {
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      throw fail();
    }
    if (event.usage) usage = event.usage;
    for (const choice of event.choices || []) {
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === "string") {
        content += delta.content;
        if (Buffer.byteLength(content) > 256 * 1024)
          throw fail("Provider response exceeded the size limit.");
        onText(delta.content);
      }
      for (const fragment of delta.tool_calls || []) {
        if (
          !Number.isInteger(fragment.index) ||
          fragment.index < 0 ||
          fragment.index >= 12
        )
          throw fail();
        const call = calls.get(fragment.index) || {
          id: "",
          name: "",
          arguments: "",
        };
        if (fragment.id) call.id += fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments)
          call.arguments += fragment.function.arguments;
        if (Buffer.byteLength(call.arguments) > 64 * 1024)
          throw fail("Tool arguments exceeded the size limit.");
        calls.set(fragment.index, call);
      }
    }
  };
  while (!done) {
    const { value, done: ended } = await reader.read();
    buffer += decoder
      .decode(value || new Uint8Array(), { stream: !ended })
      .replaceAll("\r\n", "\n");
    if (Buffer.byteLength(buffer) > 256 * 1024)
      throw fail("Provider stream frame exceeded the size limit.");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (payload) consume(payload);
    }
    if (ended) break;
  }
  if (!done || buffer.trim()) throw fail();
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);
  for (const call of toolCalls) {
    if (!call.id || !call.name)
      throw fail("Provider returned an incomplete tool call.");
    try {
      JSON.parse(call.arguments);
    } catch {
      throw fail("Provider returned invalid tool arguments.");
    }
  }
  if (!finishReason && (content || toolCalls.length))
    finishReason = toolCalls.length ? "tool_calls" : "stop";
  if (!finishReason) throw fail();
  return { content, toolCalls, ...(usage ? { usage } : {}) };
}

export async function testConnection(
  connection,
  { fetchImpl = fetch, signal } = {},
) {
  const controller = signal ? null : new AbortController();
  const result = await completeTurn({
    connection,
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    tools: [],
    signal: signal || controller.signal,
    onText() {},
    fetchImpl,
  });
  return {
    ok: true,
    model: connection.model,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
