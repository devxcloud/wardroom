import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { argon2id } from "hash-wasm";
import { InputError } from "../domain.mjs";

const CHUNK = 16 * 1024;
const TAG = 16;

const hmac = (key, data) =>
  createHmac("sha256", key).update(data).digest();
const sha256 = (data) => createHash("sha256").update(data).digest();
const hex = (data) => Buffer.from(data).toString("hex");
const encode = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

async function deriveKey(password, salt) {
  return Buffer.from(
    await argon2id({
      password,
      salt,
      parallelism: 4,
      iterations: 1,
      memorySize: 65536,
      hashLength: 32,
      outputType: "binary",
    }),
  );
}

function additionalData(key, nonce) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.final();
  return Buffer.concat([Buffer.from([0]), cipher.getAuthTag()]);
}

export async function encryptAdmin(payload, password) {
  const salt = randomBytes(32);
  const nonce = randomBytes(8);
  const key = await deriveKey(password, salt);
  const aead = Buffer.from([0]);
  let aad = additionalData(key, Buffer.concat([nonce, Buffer.alloc(4)]));
  const chunks = [];
  const total = payload.length || 1;
  let index = 0;
  for (let offset = 0; offset < total; offset += CHUNK) {
    index += 1;
    const slice = payload.subarray(offset, offset + CHUNK);
    const last = offset + CHUNK >= total;
    if (last) aad = Buffer.concat([Buffer.from([0x80]), aad.subarray(1)]);
    const iv = Buffer.concat([nonce, Buffer.alloc(4)]);
    iv.writeUInt32LE(index, 8);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    chunks.push(cipher.update(slice), cipher.final(), cipher.getAuthTag());
  }
  return Buffer.concat([salt, aead, nonce, ...chunks]);
}

export async function decryptAdmin(payload, password) {
  const salt = payload.subarray(0, 32);
  const aead = payload[32];
  const nonce = payload.subarray(33, 41);
  if (aead !== 0) throw new InputError("Unsupported MinIO payload.");
  const key = await deriveKey(password, salt);
  let aad = additionalData(key, Buffer.concat([nonce, Buffer.alloc(4)]));
  const out = [];
  let offset = 41;
  let index = 0;
  while (offset < payload.length) {
    index += 1;
    const next = Math.min(payload.length, offset + CHUNK + TAG);
    const last = next === payload.length;
    if (last) aad = Buffer.concat([Buffer.from([0x80]), aad.subarray(1)]);
    const chunk = payload.subarray(offset, next);
    const iv = Buffer.concat([nonce, Buffer.alloc(4)]);
    iv.writeUInt32LE(index, 8);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(chunk.subarray(chunk.length - TAG));
    out.push(
      decipher.update(chunk.subarray(0, chunk.length - TAG)),
      decipher.final(),
    );
    offset = next;
  }
  return Buffer.concat(out);
}

function canonicalQuery(query) {
  return Object.keys(query)
    .sort()
    .map((key) => `${encode(key)}=${encode(String(query[key]))}`)
    .join("&");
}

function signV4({ method, url, body, accessKey, secretKey, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = hex(sha256(body));
  const host = url.host;
  const query = canonicalQuery(Object.fromEntries(url.searchParams));
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signed = Object.keys(headers).sort();
  const canonical = [
    method,
    url.pathname,
    query,
    signed.map((k) => `${k}:${headers[k]}`).join("\n") + "\n",
    signed.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hex(sha256(canonical)),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretKey}`, date), "us-east-1"), "s3"),
    "aws4_request",
  );
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${hex(hmac(signingKey, stringToSign))}`;
  return headers;
}

export function accessKeyFor(project) {
  return `wr${createHash("sha256").update(project).digest("hex").slice(0, 16)}`;
}

export function bucketPolicy(buckets) {
  const resources = buckets.flatMap((name) => [
    `arn:aws:s3:::${name}`,
    `arn:aws:s3:::${name}/*`,
  ]);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:*"],
        Resource: resources,
      },
    ],
  };
}

export class MinioIam {
  constructor(s3 = {}, { fetch: send = fetch } = {}) {
    this.s3 = s3;
    this.fetch = send;
  }
  url(command, query = {}) {
    const url = new URL(
      `http://${this.s3.endPoint}:${this.s3.port}/minio/admin/v3/${command}`,
    );
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    return url;
  }
  async admin(method, command, { query, body = Buffer.alloc(0), encrypt = false } = {}) {
    if (!this.s3?.accessKey || !this.s3?.secretKey)
      throw new InputError("MinIO is not configured.", 503);
    const payload = encrypt
      ? await encryptAdmin(body, this.s3.secretKey)
      : body;
    const url = this.url(command, query);
    const headers = signV4({
      method,
      url,
      body: payload,
      accessKey: this.s3.accessKey,
      secretKey: this.s3.secretKey,
    });
    const res = await this.fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "DELETE" ? undefined : payload,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok)
      throw new InputError("MinIO identity request failed.", 409);
    return bytes;
  }
  async ensure(project, buckets, secrets) {
    const accessKey = (await secrets.get(project, "s3:access")) || accessKeyFor(project);
    const secretKey =
      (await secrets.get(project, "s3:secret")) || randomBytes(24).toString("base64url");
    const policyName = `wardroom-${project}`;
    await this.admin("PUT", "add-user", {
      query: { accessKey },
      body: Buffer.from(
        JSON.stringify({ status: "enabled", secretKey }),
      ),
      encrypt: true,
    });
    await this.admin("PUT", "add-canned-policy", {
      query: { name: policyName },
      body: Buffer.from(JSON.stringify(bucketPolicy(buckets))),
    });
    await this.admin("PUT", "set-user-or-group-policy", {
      query: { policyName, userName: accessKey },
    });
    await secrets.set(project, "s3:access", accessKey);
    await secrets.set(project, "s3:secret", secretKey);
    return { accessKey };
  }
  async rotate(project, buckets, secrets) {
    await secrets.set(project, "s3:secret", randomBytes(24).toString("base64url"));
    return this.ensure(project, buckets, secrets);
  }
  async remove(project, secrets) {
    const accessKey =
      (await secrets.get(project, "s3:access")) || accessKeyFor(project);
    try {
      await this.admin("DELETE", "remove-user", { query: { accessKey } });
    } catch {
      // Retire still deletes project rows when the IAM user is already gone.
    }
  }
}
