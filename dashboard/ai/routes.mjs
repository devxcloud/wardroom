import { InputError } from "../domain.mjs";
import { testConnection } from "./provider.mjs";

export async function handleAiRequest({
  req,
  res,
  path,
  owner,
  readBody,
  json,
  ai,
}) {
  if (!path.startsWith("/api/ai/")) return false;
  const { settings, conversations } = ai;
  if (path === "/api/ai/settings" && req.method === "GET") {
    json(res, 200, await settings.public());
    return true;
  }
  if (path === "/api/ai/settings" && req.method === "POST") {
    json(res, 200, await settings.save(await readBody(req)));
    return true;
  }
  if (path === "/api/ai/settings/remove" && req.method === "POST") {
    json(res, 200, await settings.remove());
    return true;
  }
  if (path === "/api/ai/test" && req.method === "POST") {
    const connection = await settings.preview(await readBody(req));
    json(
      res,
      200,
      await testConnection(connection, {
        signal: AbortSignal.timeout(20_000),
      }),
    );
    return true;
  }
  if (path === "/api/ai/conversations" && req.method === "POST") {
    json(res, 201, await conversations.create(owner, await readBody(req)));
    return true;
  }
  const match =
    /^\/api\/ai\/conversations\/([0-9a-f-]+)(?:\/(messages|stop|close))?$/.exec(
      path,
    );
  if (!match) throw new InputError("AI endpoint not found.", 404);
  const [, id, action] = match;
  if (!action && req.method === "GET") {
    json(res, 200, conversations.get(owner, id));
    return true;
  }
  if (req.method !== "POST") throw new InputError("Method not allowed.", 405);
  if (action === "stop") {
    json(res, 200, conversations.stop(owner, id));
    return true;
  }
  if (action === "close") {
    json(res, 200, await conversations.close(owner, id));
    return true;
  }
  if (action !== "messages")
    throw new InputError("AI endpoint not found.", 404);
  const input = await readBody(req, 34 * 1024);
  if (typeof input?.message !== "string" || Object.keys(input).length !== 1)
    throw new InputError("Send one message.");
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  const controller = new AbortController();
  const emit = (event) => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    await conversations.turn(owner, id, input.message, emit, controller.signal);
  } catch (error) {
    emit({
      type: "error",
      error:
        error instanceof InputError
          ? error.message
          : "AI request failed. Check the connection and retry.",
    });
  }
  if (!res.destroyed) res.end();
  return true;
}
