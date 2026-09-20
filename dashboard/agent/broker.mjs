import http from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { InputError } from "../domain.mjs";

const controlPlane = new Set([
  "dashboard",
  "gateway",
  "agent-broker",
  "host-broker",
  "docker-proxy",
]);
const wardroomServices = new Set([
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
  "mcp",
  "agent-check",
  ...controlPlane,
]);
const protectedVolumes = new Set([
  "postgres-data",
  "redis-data",
  "minio-data",
  "redisinsight-data",
]);
const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const builtinNetworks = new Set(["bridge", "host", "none"]);
const hash = (s) => createHash("sha256").update(s).digest();
const containerName = (value) => String(value || "").replace(/^\//, "");

export function dockerRequest(
  method,
  path,
  limit = 256 * 1024,
  body,
  timeout = 15000,
) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? undefined : Buffer.from(body);
    const req = http.request(
      {
        socketPath: "/var/run/docker.sock",
        method,
        path,
        timeout,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": payload.length,
            }
          : undefined,
      },
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
    if (payload) req.end(payload);
    else req.end();
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
  classify(labels) {
    const service = labels?.["com.docker.compose.service"];
    if (
      labels?.["com.docker.compose.project"] === this.project &&
      controlPlane.has(service)
    )
      return "control";
    if (
      labels?.["com.docker.compose.project"] === this.project &&
      wardroomServices.has(service)
    )
      return "wardroom";
    return "other";
  }
  volumeProtected(name) {
    return (
      protectedVolumes.has(name) ||
      [...protectedVolumes].some((item) => name.endsWith(`_${item}`))
    );
  }
  networkProtected(name) {
    return builtinNetworks.has(name) || name.startsWith(`${this.project}_`);
  }
  summary(container) {
    const labels = container.Labels || container.Config?.Labels || {};
    const names = container.Names || (container.Name ? [container.Name] : []);
    return {
      id: container.Id,
      name: containerName(names[0]),
      service: labels["com.docker.compose.service"] || null,
      composeProject: labels["com.docker.compose.project"] || null,
      state:
        typeof container.State === "string"
          ? container.State
          : container.State?.Status,
      status: container.Status || container.State?.Status || "",
      class: this.classify(labels),
    };
  }
  async run(action, args = {}) {
    const actions = [
      "list",
      "logs",
      "start",
      "stop",
      "restart",
      "remove",
      "volume_list",
      "volume_create",
      "volume_remove",
      "network_list",
      "network_create",
      "network_remove",
    ];
    if (!actions.includes(action))
      throw new InputError("Unknown container action.");
    if (action.startsWith("volume_")) return this.volume(action, args);
    if (action.startsWith("network_")) return this.network(action, args);
    if (action === "list") {
      const raw = await this.request("GET", "/containers/json?all=1");
      const items = raw.map((c) => this.summary(c));
      return {
        containers: items.slice(0, 128),
        truncated: items.length > 128,
      };
    }
    const { id, inspect, item } = await this.resolve(args);
    const klass = this.classify(inspect.Config?.Labels);
    if (["stop", "restart", "remove"].includes(action) && klass === "control")
      throw new InputError(
        "Control-plane containers cannot be stopped or removed.",
        403,
      );
    if (action === "remove" && klass !== "other")
      throw new InputError(
        "Wardroom service containers cannot be deleted; stop or restart them instead.",
        403,
      );
    if (action === "logs") {
      const lines = args.lines ?? 100;
      if (!Number.isInteger(lines) || lines < 1 || lines > 200)
        throw new InputError("Invalid line limit.");
      const raw = await this.request(
        "GET",
        `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${lines}`,
        65536,
      );
      let text = "";
      if (inspect.Config.Tty) text = raw.toString("utf8");
      else
        for (let offset = 0; offset + 8 <= raw.length; ) {
          const length = raw.readUInt32BE(offset + 4);
          if (offset + 8 + length > raw.length) break;
          text += raw
            .subarray(offset + 8, offset + 8 + length)
            .toString("utf8");
          offset += 8 + length;
        }
      return {
        name: item.name,
        service: item.service,
        text: text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""),
      };
    }
    if (action === "remove") {
      await this.request("DELETE", `/containers/${id}`);
      return { name: item.name, action, containerId: id };
    }
    await this.request(
      "POST",
      `/containers/${id}/${action}${action === "start" ? "" : "?t=5"}`,
    );
    return {
      name: item.name,
      service: item.service,
      action,
      containerId: id,
    };
  }
  async resolve({ service, name } = {}) {
    if (service && name)
      throw new InputError("Choose a service or a container name.");
    const raw = await this.request("GET", "/containers/json?all=1");
    let found;
    if (service) {
      found = raw.filter((c) => this.matches(c.Labels, service));
    } else if (name) {
      const needle = containerName(name);
      if (!needle || needle.length > 128)
        throw new InputError("Invalid container name.");
      found = raw.filter((c) => {
        const names = (c.Names || []).map(containerName);
        return (
          names.includes(needle) || c.Id === needle || c.Id.startsWith(needle)
        );
      });
    } else throw new InputError("Choose a container.");
    if (found.length !== 1 || !/^[a-f0-9]{64}$/.test(found[0].Id))
      throw new InputError("Expected one exact managed container.", 409);
    const id = found[0].Id;
    const inspect = await this.request("GET", `/containers/${id}/json`);
    if (inspect.Id !== id)
      throw new InputError(
        "Container is no longer managed by this service.",
        409,
      );
    if (service && !this.matches(inspect.Config?.Labels, service))
      throw new InputError(
        "Container is no longer managed by this service.",
        409,
      );
    return {
      id,
      inspect,
      item: this.summary({
        ...found[0],
        Name: inspect.Name,
        Labels: inspect.Config?.Labels,
      }),
    };
  }
  async volume(action, { name } = {}) {
    if (action === "volume_list") {
      const result = await this.request("GET", "/volumes");
      const usage = new Map();
      try {
        const df = await this.request(
          "GET",
          "/system/df?type=volume",
          1024 * 1024,
          undefined,
          30000,
        );
        for (const volume of df.Volumes || []) {
          const bytes = volume.UsageData?.Size;
          usage.set(
            volume.Name,
            typeof bytes === "number" && bytes >= 0 ? bytes : null,
          );
        }
      } catch {
        // Size is optional; listing still works if disk usage is slow.
      }
      const items = (result.Volumes || []).map((v) => ({
        name: v.Name,
        driver: v.Driver,
        createdAt: v.CreatedAt || null,
        protected: this.volumeProtected(v.Name),
        sizeBytes: usage.has(v.Name) ? usage.get(v.Name) : null,
      }));
      return { volumes: items.slice(0, 128), truncated: items.length > 128 };
    }
    if (!name || !volumeName.test(name))
      throw new InputError("Invalid volume name.");
    if (this.volumeProtected(name))
      throw new InputError("Wardroom data volumes cannot be changed.", 403);
    if (action === "volume_create") {
      await this.request(
        "POST",
        "/volumes/create",
        256 * 1024,
        JSON.stringify({ Name: name }),
      );
      return { name, created: true };
    }
    await this.request("DELETE", `/volumes/${encodeURIComponent(name)}`);
    return { name, removed: true };
  }
  async network(action, { name } = {}) {
    if (action === "network_list") {
      const raw = await this.request("GET", "/networks");
      const items = (Array.isArray(raw) ? raw : []).map((n) => ({
        name: n.Name,
        driver: n.Driver || "bridge",
        scope: n.Scope || "local",
        internal: Boolean(n.Internal),
        subnet: n.IPAM?.Config?.[0]?.Subnet || null,
        protected: this.networkProtected(n.Name),
      }));
      return { networks: items.slice(0, 128), truncated: items.length > 128 };
    }
    if (!name || !volumeName.test(name))
      throw new InputError("Invalid network name.");
    if (this.networkProtected(name))
      throw new InputError("Wardroom and built-in networks cannot be changed.", 403);
    if (action === "network_create") {
      await this.request(
        "POST",
        "/networks/create",
        256 * 1024,
        JSON.stringify({ Name: name, CheckDuplicate: true }),
      );
      return { name, created: true };
    }
    await this.request("DELETE", `/networks/${encodeURIComponent(name)}`);
    return { name, removed: true };
  }
}
export function createBroker({ secret, control = new DockerControl() } = {}) {
  if (!secret || secret.length < 32)
    throw Error("AGENT_BROKER_SECRET must contain at least 32 characters.");
  const schema = z
    .object({
      action: z.enum([
        "list",
        "logs",
        "start",
        "stop",
        "restart",
        "remove",
        "volume_list",
        "volume_create",
        "volume_remove",
        "network_list",
        "network_create",
        "network_remove",
      ]),
      service: z.string().min(1).max(64).optional(),
      name: z.string().min(1).max(128).optional(),
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
    } catch (error) {
      if (error instanceof InputError)
        return reply(error.status || 409, { error: error.message });
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
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.listen(8791, "0.0.0.0");
}
