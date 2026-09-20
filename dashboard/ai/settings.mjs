import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { InputError } from "../domain.mjs";

const schema = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().min(1).max(4096).optional(),
    clearKey: z.boolean().optional(),
    insecureHttp: z.boolean().optional(),
  })
  .strict();

export function validateConnection(input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success || (parsed.data.apiKey && parsed.data.clearKey))
    throw new InputError("Invalid AI connection settings.");
  let url;
  try {
    url = new URL(parsed.data.baseUrl);
  } catch {
    throw new InputError("Enter a valid provider URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new InputError("Provider URL must use HTTP(S) without credentials.");
  if (url.search || url.hash)
    throw new InputError("Provider URL cannot include a query or fragment.");
  if (url.protocol === "http:" && parsed.data.insecureHttp !== true)
    throw new InputError("Confirm insecure HTTP before saving this endpoint.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    model: parsed.data.model,
    ...(parsed.data.apiKey ? { apiKey: parsed.data.apiKey } : {}),
    ...(parsed.data.clearKey ? { clearKey: true } : {}),
    ...(url.protocol === "http:" ? { insecureHttp: true } : {}),
  };
}

export class AiSettings {
  constructor(pool, encryptionKey) {
    this.pool = pool;
    this.key = /^[a-f0-9]{64}$/i.test(encryptionKey || "")
      ? Buffer.from(encryptionKey, "hex")
      : null;
  }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS shared_infra.ai_settings (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), base_url text NOT NULL,
      model text NOT NULL, api_key_encrypted jsonb, insecure_http boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now())`);
  }
  async row() {
    return (
      await this.pool.query(
        "SELECT base_url,model,api_key_encrypted,insecure_http FROM shared_infra.ai_settings WHERE singleton=true",
      )
    ).rows[0];
  }
  async public() {
    const row = await this.row();
    return row
      ? {
          configured: true,
          baseUrl: row.base_url,
          model: row.model,
          hasKey: Boolean(row.api_key_encrypted),
          insecureHttp: row.insecure_http,
        }
      : { configured: false };
  }
  encrypt(value) {
    if (!this.key)
      throw new InputError(
        "AI settings encryption is unavailable. Configure AI_SETTINGS_KEY.",
        503,
      );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }
  decrypt(envelope) {
    if (!this.key)
      throw new InputError("AI settings cannot be decrypted.", 503);
    try {
      if (envelope?.version !== 1) throw Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new InputError("AI settings cannot be decrypted.", 503);
    }
  }
  async private() {
    const row = await this.row();
    if (!row) throw new InputError("Configure an AI connection first.", 409);
    return {
      baseUrl: row.base_url,
      model: row.model,
      insecureHttp: row.insecure_http,
      ...(row.api_key_encrypted
        ? { apiKey: this.decrypt(row.api_key_encrypted) }
        : {}),
    };
  }
  async preview(input) {
    const value = validateConnection(input);
    const current = await this.row();
    let apiKey = value.apiKey;
    if (
      !apiKey &&
      !value.clearKey &&
      current?.base_url === value.baseUrl &&
      current.api_key_encrypted
    )
      apiKey = this.decrypt(current.api_key_encrypted);
    return {
      baseUrl: value.baseUrl,
      model: value.model,
      insecureHttp: value.insecureHttp === true,
      ...(apiKey ? { apiKey } : {}),
    };
  }
  async save(input) {
    const value = validateConnection(input);
    const current = await this.row();
    let encrypted = null;
    if (value.apiKey) encrypted = this.encrypt(value.apiKey);
    else if (!value.clearKey && current?.base_url === value.baseUrl)
      encrypted = current.api_key_encrypted;
    await this.pool.query(
      `INSERT INTO shared_infra.ai_settings
      (singleton,base_url,model,api_key_encrypted,insecure_http) VALUES (true,$1,$2,$3,$4)
      ON CONFLICT(singleton) DO UPDATE SET base_url=$1,model=$2,api_key_encrypted=$3,insecure_http=$4,updated_at=now()`,
      [value.baseUrl, value.model, encrypted, value.insecureHttp === true],
    );
    return this.public();
  }
  async remove() {
    await this.pool.query(
      "DELETE FROM shared_infra.ai_settings WHERE singleton=true",
    );
    return { removed: true };
  }
}
