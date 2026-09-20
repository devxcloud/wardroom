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
    /^\/api\/ai\/conversations\/([0-9a-f-]+)(?:\/(messages|approve|reject|stop|close|policy))?$/.exec(
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
  if (action === "reject") {
    const input = await readBody(req);
    if (typeof input?.approvalId !== "string")
      throw new InputError("Select an approval to cancel.");
    json(res, 200, conversations.reject(owner, id, input.approvalId));
    return true;
  }
  if (action === "policy") {
    const input = await readBody(req);
    if (
      typeof input?.auto !== "boolean" ||
      !Object.keys(input).every((key) => key === "auto")
    )
      throw new InputError("Choose Protected or Auto.");
    json(res, 200, conversations.setAuto(owner, id, input.auto));
    return true;
  }
  if (action !== "messages" && action !== "approve")
    throw new InputError("AI endpoint not found.", 404);
  const input = await readBody(req, 34 * 1024);
  if (action === "messages") {
    if (
      typeof input?.message !== "string" ||
      !Object.keys(input).every((key) =>
        ["message", "context"].includes(key),
      ) ||
      (input.context !== undefined &&
        (typeof input.context !== "string" ||
          !/^[\p{L}\p{N} &._\-/]{1,120}$/u.test(input.context)))
    )
      throw new InputError("Send one message with valid page context.");
  }
  if (action === "approve" && typeof input?.approvalId !== "string")
    throw new InputError("Select an operation to approve.");
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
    if (action === "approve")
      await conversations.approve(
        owner,
        id,
        input.approvalId,
        emit,
        controller.signal,
      );
    else
      await conversations.turn(
        owner,
        id,
        input.message,
        emit,
        controller.signal,
        input.context,
      );
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
