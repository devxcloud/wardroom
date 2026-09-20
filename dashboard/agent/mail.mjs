import { InputError } from "../domain.mjs";

const addressOf = (value) =>
  String(value?.Address || value?.address || value || "").toLowerCase();

export function mailDomain(project) {
  return `${project}.test`;
}

export function addressBelongs(address, project) {
  const email = addressOf(address);
  const name = String(project || "").toLowerCase();
  if (!email || !name || !email.includes("@")) return false;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return domain === `${name}.test` || domain === `${name}.local`;
}

export function messageBelongs(message, project) {
  const recipients = [
    ...(message.To || []),
    ...(message.Cc || []),
    ...(message.Bcc || []),
  ];
  return (
    addressBelongs(message.From, project) ||
    recipients.some((item) => addressBelongs(item, project))
  );
}

const summarize = (message) => ({
  id: message.ID || message.Id,
  from: addressOf(message.From),
  to: (message.To || []).map(addressOf).filter(Boolean),
  cc: (message.Cc || []).map(addressOf).filter(Boolean),
  subject: String(message.Subject || "").slice(0, 300),
  created: message.Created || message.Date,
  size: message.Size,
  snippet: String(message.Snippet || "").slice(0, 300),
});

export class AgentMail {
  constructor(base, { fetch: send = fetch } = {}) {
    this.base = String(base || "").replace(/\/$/, "");
    this.fetch = send;
  }
  async request(path, { method = "GET", query, body } = {}) {
    if (!this.base) throw new InputError("Mailpit is not configured.", 503);
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(query || {}))
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    const res = await this.fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: body
        ? { "Content-Type": "application/json", Accept: "application/json" }
        : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok)
      throw new InputError("Mailpit request failed.", res.status === 404 ? 404 : 503);
    if (!text || res.headers.get("content-type")?.includes("text/plain"))
      return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new InputError("Invalid Mailpit response.", 503);
    }
  }
  scoped(message, project) {
    if (!messageBelongs(message, project))
      throw new InputError("Message is outside this project's mail domain.", 403);
    return message;
  }
  async list({ project, query, start = 0, limit = 50 }) {
    const page = Math.min(Math.max(Number(limit) || 50, 1), 50);
    const offset = Math.min(Math.max(Number(start) || 0, 0), 100000);
    const name = String(project || "").toLowerCase();
    const search =
      String(query || "").trim() || `${name}.test OR ${name}.local`;
    const data = await this.request("/api/v1/search", {
      query: { query: search, start: offset, limit: page },
    });
    const raw = data.messages || data.Messages || [];
    const messages = raw.filter((item) => messageBelongs(item, project));
    return {
      project,
      mailDomain: mailDomain(project),
      messages: messages.map(summarize),
      total: data.total || data.messages_count,
      start: offset,
      truncated: raw.length >= page,
    };
  }
  async get({ project, id }) {
    const message = await this.request(
      `/api/v1/message/${encodeURIComponent(id)}`,
    );
    this.scoped(message, project);
    const text = String(message.Text || "");
    const html = String(message.HTML || message.Html || "");
    return {
      ...summarize(message),
      text: text.slice(0, 32768),
      html: html.slice(0, 32768),
      truncated: text.length > 32768 || html.length > 32768,
    };
  }
  async remove({ project, id }) {
    const message = await this.request(
      `/api/v1/message/${encodeURIComponent(id)}`,
    );
    this.scoped(message, project);
    await this.request("/api/v1/messages", {
      method: "DELETE",
      body: { IDs: [id] },
    });
    return { project, id, removed: true };
  }
}
