import { InputError } from "./domain.mjs";

const defaults = {
  logs: "http://dozzle:8080/logs/healthcheck",
  redis: "http://redisinsight:5540/redis/api/health/",
  traces: "http://jaeger:13133/status",
  api: "http://hoppscotch:80/backend/ping",
  wiremock: "http://wiremock:8080/__admin/health",
  toxiproxy: "http://toxiproxy:8474/version",
};

const copy = {
  logs: {
    ready: "Container logs are ready.",
    unavailable: "Container logs are unavailable.",
  },
  redis: {
    ready: "Redis workspace is ready.",
    unavailable: "Redis workspace is unavailable.",
  },
  traces: {
    ready: "Trace explorer is ready.",
    unavailable: "Trace explorer is unavailable.",
  },
};

export class ToolService {
  constructor({ fetchImpl = fetch, urls = defaults, host } = {}) {
    this.fetch = fetchImpl;
    this.urls = urls;
    this.host = host || "127.0.0.1";
  }

  async status(id, optional = false) {
    try {
      const response = await this.fetch(this.urls[id], {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return "healthy";
    } catch {}
    return optional ? "inactive" : "unavailable";
  }

  async read() {
    const [logs, redis, traces, api, wiremock, toxiproxy] = await Promise.all([
      this.status("logs"),
      this.status("redis"),
      this.status("traces"),
      this.status("api", true),
      this.status("wiremock", true),
      this.status("toxiproxy", true),
    ]);
    return {
      tools: [
        {
          id: "api",
          status: api,
          detail:
            api === "healthy"
              ? "API workbench is ready."
              : "Start with make api-up.",
        },
        {
          id: "logs",
          status: logs,
          detail: logs === "healthy" ? copy.logs.ready : copy.logs.unavailable,
        },
        {
          id: "redis",
          status: redis,
          detail:
            redis === "healthy" ? copy.redis.ready : copy.redis.unavailable,
        },
        {
          id: "traces",
          status: traces,
          detail:
            traces === "healthy" ? copy.traces.ready : copy.traces.unavailable,
        },
      ],
      lab: {
        active: wiremock === "healthy" && toxiproxy === "healthy",
        wiremock,
        toxiproxy,
      },
      connections: {
        otlpGrpc: `${this.host}:4317`,
        otlpHttp: `http://${this.host}:4318`,
        postgresProxy: `${this.host}:15434`,
        redisProxy: `${this.host}:16379`,
        minioProxy: `http://${this.host}:19100`,
      },
    };
  }

  async applyFault(target, preset) {
    const targets = new Set(["postgres", "redis", "minio"]);
    const presets = {
      "latency-500": {
        type: "latency",
        attributes: { latency: 500, jitter: 0 },
      },
      "latency-2000": {
        type: "latency",
        attributes: { latency: 2000, jitter: 100 },
      },
      timeout: { type: "timeout", attributes: { timeout: 0 } },
    };
    if (!targets.has(target)) throw new InputError("Unknown fault target.");
    if (![...Object.keys(presets), "disabled", "reset"].includes(preset))
      throw new InputError("Unknown fault preset.");
    const base = this.urls.toxiproxy.replace(/\/version\/?$/, "");
    const proxy = `${base}/proxies/${target}`;
    const request = async (url, options) => {
      const response = await this.fetch(url, {
        ...options,
        headers: options?.body
          ? { "Content-Type": "application/json" }
          : undefined,
        signal: AbortSignal.timeout(2000),
      });
      if (
        !response.ok &&
        !(options?.method === "DELETE" && response.status === 404)
      )
        throw Error("Toxiproxy request failed");
    };
    if (preset === "disabled") {
      await request(proxy, {
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      });
    } else {
      await request(`${proxy}/toxics/shared-infra-fault`, { method: "DELETE" });
      await request(proxy, {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      });
      if (preset !== "reset") {
        const toxic = presets[preset];
        await request(`${proxy}/toxics`, {
          method: "POST",
          body: JSON.stringify({
            name: "shared-infra-fault",
            type: toxic.type,
            stream: "downstream",
            toxicity: 1,
            attributes: toxic.attributes,
          }),
        });
      }
    }
    return { target, preset };
  }
}
