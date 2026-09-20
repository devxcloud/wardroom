import http from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { InputError } from "../domain.mjs";
import { safeError } from "./policy.mjs";

export function createMcpApp({ catalog, store, hosts }) {
  if (!hosts?.length) throw Error("MCP_ALLOWED_HOSTS must be configured.");
  const sdk = createMcpHandler(
    ({ authInfo }) => {
      const actor = authInfo.extra.actor;
      const server = new McpServer({ name: "wardroom", version: "1.0.0" });
      for (const d of catalog.visible(actor))
        server.registerTool(
          d.name,
          {
            description: d.description,
            inputSchema: d.schema,
            annotations: {
              readOnlyHint: !d.mutation,
              destructiveHint: !!(d.destructive || d.overwrites),
              idempotentHint: !d.mutation,
              openWorldHint: false,
            },
          },
          async (args) => {
            try {
              const value = await catalog.call(actor, d.name, args);
              return {
                content: [{ type: "text", text: JSON.stringify(value) }],
                structuredContent: value,
              };
            } catch (error) {
              return {
                isError: true,
                content: [{ type: "text", text: safeError(error) }],
              };
            }
          },
        );
      return server;
    },
    { legacy: "stateless", maxSubscriptions: 0 },
  );
  const handle = toNodeHandler(sdk);
  const rates = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const fail = (status, message) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    };
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        res.end('{"status":"ok"}');
        return;
      }
      if (req.url !== "/mcp") return fail(404, "Not found.");
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (!hosts.includes(host)) return fail(403, "Host is not allowed.");
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (
          !["http:", "https:"].includes(origin.protocol) ||
          !hosts.includes(origin.hostname) ||
          origin.host !== req.headers.host
        )
          return fail(403, "Origin is not allowed.");
      }
      const now = Date.now();
      for (const [key, value] of rates)
        if (value.until < now) rates.delete(key);
      const ip = req.socket.remoteAddress;
      const rate = rates.get(ip) || { count: 0, until: now + 60000 };
      if (++rate.count > 120 || rates.size > 1024)
        return fail(429, "Request limit reached.");
      rates.set(ip, rate);
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization || "")?.[1];
      const actor = await store.authenticate(token);
      req.auth = {
        token: "redacted",
        clientId: actor.id,
        scopes: [actor.scope],
        extra: { actor },
      };
      if (req.method !== "POST") return fail(405, "Use POST.");
      if (req.headers["content-type"]?.split(";")[0] !== "application/json")
        return fail(415, "Use application/json.");
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 96 * 1024) return fail(413, "Request is too large.");
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return fail(400, "Invalid JSON.");
      }
      await handle(req, res, body);
    } catch (error) {
      if (!res.headersSent)
        fail(
          error instanceof InputError ? error.status : 503,
          safeError(error),
        );
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("close", () => sdk.close());
  return server;
}
