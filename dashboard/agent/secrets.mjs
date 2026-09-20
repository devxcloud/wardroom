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
  decrypt(row) {
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.nonce);
    decipher.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - 16));
    return Buffer.concat([
      decipher.update(row.ciphertext.subarray(0, row.ciphertext.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  }
  async get(project, name) {
    const row = (
      await this.pool.query(
        "SELECT nonce,ciphertext FROM shared_infra.project_secrets WHERE project=$1 AND name=$2",
        [project, name],
      )
    ).rows[0];
    if (!row) return null;
    return this.decrypt(row);
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
    const { rows } = await this.pool.query(
      "SELECT name,nonce,ciphertext FROM shared_infra.project_secrets WHERE project=$1",
      [project],
    );
    const values = Object.fromEntries(
      rows.map((row) => [row.name, this.decrypt(row)]),
    );
    const dbUsers = {};
    for (const [name, value] of Object.entries(values))
      if (name.startsWith("db:")) dbUsers[name.slice(3)] = value;
    return {
      dbPassword: values[`db:${project}`] || null,
      dbUsers,
      s3AccessKey: values["s3:access"] || null,
      s3SecretKey: values["s3:secret"] || null,
    };
  }
}
