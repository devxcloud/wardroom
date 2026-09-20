import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { InputError } from "../domain.mjs";

const keyOf = (secret) => {
  if (!secret || String(secret).length < 32)
    throw new InputError("Project secret key is not configured.", 503);
  return createHash("sha256").update(String(secret)).digest();
};

export class ProjectSecrets {
  constructor(pool, secret) {
    this.pool = pool;
    this.key = keyOf(secret);
  }
  async get(project, name) {
    const row = (
      await this.pool.query(
        "SELECT nonce,ciphertext FROM shared_infra.project_secrets WHERE project=$1 AND name=$2",
        [project, name],
      )
    ).rows[0];
    if (!row) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.nonce);
    decipher.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - 16));
    return Buffer.concat([
      decipher.update(row.ciphertext.subarray(0, row.ciphertext.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  }
  async set(project, name, value) {
    if (typeof value !== "string" || !value.length || value.length > 256)
      throw new InputError("Secret value is invalid.");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
    await this.pool.query(
      `INSERT INTO shared_infra.project_secrets(project,name,nonce,ciphertext)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (project,name) DO UPDATE SET nonce=EXCLUDED.nonce,ciphertext=EXCLUDED.ciphertext`,
      [project, name, nonce, ciphertext],
    );
  }
  async load(project) {
    return {
      dbPassword: await this.get(project, `db:${project}`),
      s3AccessKey: await this.get(project, "s3:access"),
      s3SecretKey: await this.get(project, "s3:secret"),
    };
  }
}
