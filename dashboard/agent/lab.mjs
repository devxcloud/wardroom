import { randomUUID } from "node:crypto";
import { InputError } from "../domain.mjs";

async function jsonRequest(url, { timeoutMs = 10000, ...options } = {}) {
  const res = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 204) return {};
  const reader = res.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024)
        throw new InputError("Optional service response too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const text = Buffer.concat(chunks).toString();
  if (!res.ok) {
    let message =
      "Optional service is unavailable or refused the operation.";
    try {
      const parsed = text ? JSON.parse(text) : {};
      if (typeof parsed.error === "string" && parsed.error.length <= 300)
        message = parsed.error;
    } catch {}
    throw new InputError(
      message,
      res.status >= 400 && res.status < 500 ? res.status : 503,
    );
  }
  return text ? JSON.parse(text) : {};
}
export class AgentLab {
  constructor(
    infra,
    resources,
    {
      wiremock = "http://wiremock:8080",
      broker = "http://agent-broker:8791",
      hostBroker = "http://host-broker:8792",
      secret = process.env.AGENT_BROKER_SECRET,
    } = {},
  ) {
    Object.assign(this, {
      infra,
      resources,
      wiremock,
      broker,
      hostBroker,
      secret,
    });
  }
  async containers(action, args = {}) {
    if (!this.secret)
      throw new InputError("Container control is not configured.", 503);
    return jsonRequest(`${this.broker}/control`, {
      method: "POST",
      timeoutMs: 35000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.secret}`,
      },
      body: JSON.stringify({
        action,
        service: args.service,
        name: args.name,
        lines: args.lines,
      }),
    });
  }
  async host(action, args = {}) {
    if (!this.secret)
      throw new InputError("Host storage control is not configured.", 503);
    return jsonRequest(`${this.hostBroker}/control`, {
      method: "POST",
      timeoutMs: 120000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.secret}`,
      },
      body: JSON.stringify({
        action,
        vg: args.vg,
        lv: args.lv,
        sizeGiB: args.sizeGiB,
      }),
    });
  }
  async mocks(action, a) {
    await this.resources.project(a.project);
    if (action === "list")
      return {
        mappings: (await this.resources.list(a.project)).filter(
          (r) => r.kind === "mock",
        ),
      };
    if (action === "create") {
      const id = randomUUID();
      // Project namespace prevents another project's stub shadowing the same URL.
      const urlPath = `/${a.project}${a.path}`;
      await this.infra.pool.query(
        "INSERT INTO shared_infra.agent_resources(kind,name,project,status) VALUES ('mock',$1,$2,'creating')",
        [id, a.project],
      );
      await jsonRequest(`${this.wiremock}/__admin/mappings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          metadata: { wardroomProject: a.project },
          request: { method: a.method, urlPath },
          response: { status: a.status, body: a.body },
        }),
      });
      await this.infra.pool.query(
        "UPDATE shared_infra.agent_resources SET status='ready' WHERE kind='mock' AND name=$1 AND project=$2",
        [id, a.project],
      );
      return { id, urlPath, project: a.project };
    }
    await this.resources.owned(a.project, "mock", a.id);
    const response = await fetch(`${this.wiremock}/__admin/mappings/${a.id}`, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 404) {
      if (!response.ok) throw new InputError("Mock service unavailable.", 503);
      await response.body?.cancel();
      const existing = await jsonRequest(
        `${this.wiremock}/__admin/mappings/${a.id}`,
      );
      if (existing.metadata?.wardroomProject !== a.project)
        throw new InputError("Mock ownership changed.", 409);
      await jsonRequest(`${this.wiremock}/__admin/mappings/${a.id}`, {
        method: "DELETE",
      });
    }
    await this.infra.pool.query(
      "DELETE FROM shared_infra.agent_resources WHERE kind='mock' AND name=$1 AND project=$2",
      [a.id, a.project],
    );
    return { id: a.id, removed: true };
  }
}
