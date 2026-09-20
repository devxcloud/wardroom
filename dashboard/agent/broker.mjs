import http from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { InputError } from "../domain.mjs";

const services = new Set([
  "postgres",
  "redis",
  "minio",
  "mailpit",
  "redisinsight",
  "jaeger",
  "dozzle",
  "wiremock",
  "toxiproxy",
  "hoppscotch",
  "agent-check",
]);
const hash = (s) => createHash("sha256").update(s).digest();
export function dockerRequest(method, path, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: "/var/run/docker.sock", method, path, timeout: 10000 },
      (res) => {
        let bytes = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > limit) {
            req.destroy();
            reject(new InputError("Docker output exceeded its limit."));
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode >= 300)
            return reject(new InputError("Docker operation failed.", 409));
          const buffer = Buffer.concat(chunks);
          if (path.includes("/logs?")) return resolve(buffer);
          try {
            resolve(buffer.length ? JSON.parse(buffer.toString()) : {});
          } catch {
            reject(new InputError("Invalid Docker response."));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Docker timeout")));
    req.on("error", reject);
    req.end();
  });
}
export class DockerControl {
  constructor({ request = dockerRequest, project = "shared-infra" } = {}) {
    this.request = request;
    this.project = project;
  }
  matches(labels, service) {
    return (
      labels?.["com.docker.compose.project"] === this.project &&
      (!service || labels?.["com.docker.compose.service"] === service)
    );
  }
  async run(action, { service, lines = 100 } = {}) {
    if (!["list", "logs", "start", "stop", "restart"].includes(action))
      throw new InputError("Unknown container action.");
    if (action !== "list" && !services.has(service))
      throw new InputError("Container service is not allowed.", 403);
    if (!Number.isInteger(lines) || lines < 1 || lines > 200)
      throw new InputError("Invalid line limit.");
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`com.docker.compose.project=${this.project}`] }),
    );
    const raw = await this.request(
      "GET",
      `/containers/json?all=1&filters=${filters}`,
    );
    const items = raw.filter((c) => this.matches(c.Labels));
    if (action === "list")
      return {
        containers: items.slice(0, 100).map((c) => ({
          id: c.Id,
          service: c.Labels["com.docker.compose.service"],
          state: c.State,
          status: c.Status,
        })),
        truncated: items.length > 100,
      };
    const found = items.filter((c) => this.matches(c.Labels, service));
    if (found.length !== 1 || !/^[a-f0-9]{64}$/.test(found[0].Id))
      throw new InputError("Expected one exact managed container.", 409);
    const id = found[0].Id;
    const inspect = await this.request("GET", `/containers/${id}/json`);
    if (inspect.Id !== id || !this.matches(inspect.Config?.Labels, service))
      throw new InputError(
        "Container is no longer managed by this service.",
        409,
      );
    if (action === "logs") {
      const raw = await this.request(
        "GET",
        `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${lines}`,
        65536,
      );
      // Docker multiplexes non-TTY logs with an eight-byte frame header.
      let text = "";
      if (inspect.Config.Tty) text = raw.toString("utf8");
      else
        for (let offset = 0; offset + 8 <= raw.length;) {
          const length = raw.readUInt32BE(offset + 4);
          if (offset + 8 + length > raw.length) break;
          text += raw
            .subarray(offset + 8, offset + 8 + length)
            .toString("utf8");
          offset += 8 + length;
        }
      return { service, text: text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") };
    }
    await this.request(
      "POST",
      `/containers/${id}/${action}${action === "start" ? "" : "?t=5"}`,
    );
    return { service, action, containerId: id };
  }
}
export function createBroker({ secret, control = new DockerControl() } = {}) {
  if (!secret || secret.length < 32)
    throw Error("AGENT_BROKER_SECRET must contain at least 32 characters.");
  const schema = z
    .object({
      action: z.enum(["list", "logs", "start", "stop", "restart"]),
      service: z.string().max(48).optional(),
      lines: z.number().int().min(1).max(200).optional(),
    })
    .strict();
  return http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/healthz" && req.method === "GET")
      return reply(200, { status: "ok" });
    if (req.url !== "/control" || req.method !== "POST")
      return reply(404, { error: "Not found." });
    if (
      !timingSafeEqual(
        hash(req.headers.authorization || ""),
        hash(`Bearer ${secret}`),
      )
    )
      return reply(401, { error: "Unauthorized." });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 2048)
          return reply(413, { error: "Request too large." });
      }
      const a = schema.safeParse(JSON.parse(body));
      if (!a.success) return reply(400, { error: "Invalid control request." });
      reply(200, await control.run(a.data.action, a.data));
    } catch {
      reply(409, {
        error:
          "Container operation failed; inspect the exact target before retrying.",
      });
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createBroker({
    secret: process.env.AGENT_BROKER_SECRET,
    control: new DockerControl({
      project: process.env.AGENT_COMPOSE_PROJECT || "shared-infra",
    }),
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(8791, "0.0.0.0");
}
