import { randomBytes, randomUUID, createHash } from "node:crypto";
import { InputError } from "../domain.mjs";
import { tokenInput, fingerprint } from "./policy.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
function summary(result = {}) {
  const keys = [
    "project",
    "database",
    "user",
    "bucket",
    "key",
    "name",
    "service",
    "action",
    "id",
    "kind",
    "stored",
    "removed",
    "retired",
    "rotated",
    "bytes",
    "rowCount",
    "truncated",
    "complete",
    "profile",
    "urlPath",
    "createdb",
    "enabled",
    "restored",
    "generated",
  ];
  const safe = Object.fromEntries(
    keys.filter((k) => Object.hasOwn(result, k)).map((k) => [k, result[k]]),
  );
  if (Buffer.byteLength(JSON.stringify(safe)) > 16384)
    return { truncated: true };
  return safe;
}
export class AgentStore {
  constructor(pool, secret) {
    if (!secret || secret.length < 32)
      throw Error(
        "Agent operation signing key must have at least 32 characters.",
      );
    this.pool = pool;
    this.secret = secret;
  }
  async initialize() {
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS shared_infra.agent_tokens (
      id uuid PRIMARY KEY, label text NOT NULL, token_hash text UNIQUE NOT NULL,
      scope text NOT NULL CHECK(scope IN ('project','admin')), project text,
      destructive boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL, revoked_at timestamptz,
      CHECK ((scope='project' AND project IS NOT NULL) OR (scope='admin' AND project IS NULL)));
      CREATE TABLE IF NOT EXISTS shared_infra.agent_operations (
      token_id uuid NOT NULL REFERENCES shared_infra.agent_tokens(id), id uuid NOT NULL,
      tool text NOT NULL, target text NOT NULL, fingerprint text NOT NULL,
      status text NOT NULL CHECK(status IN ('started','completed','uncertain','acknowledged')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(token_id,id));
      ALTER TABLE shared_infra.agent_operations ADD COLUMN IF NOT EXISTS outcome jsonb;
      ALTER TABLE shared_infra.agent_tokens ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
      ALTER TABLE shared_infra.agent_tokens ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'mcp';
      ALTER TABLE shared_infra.agent_tokens ALTER COLUMN expires_at DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS shared_infra.agent_resources (
      kind text NOT NULL, name text NOT NULL, project text NOT NULL REFERENCES shared_infra.projects(name),
      status text NOT NULL DEFAULT 'ready', PRIMARY KEY(kind,name));
      CREATE TABLE IF NOT EXISTS shared_infra.project_secrets (
      project text NOT NULL REFERENCES shared_infra.projects(name) ON DELETE CASCADE,
      name text NOT NULL, nonce bytea NOT NULL, ciphertext bytea NOT NULL,
      PRIMARY KEY(project,name));`);
  }
  async issue(input) {
    const value = tokenInput(input);
    return this.issueValue(
      value,
      "mcp",
      value.days === 0 ? null : `${value.days} days`,
    );
  }
  async issueChat(input) {
    const value = tokenInput({ ...input, days: 1, label: "Dashboard AI" });
    return this.issueValue(value, "chat", "30 minutes");
  }
  async issueValue(value, source, lifetime) {
    const token = `wr_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO shared_infra.agent_tokens
      (id,label,token_hash,scope,project,destructive,expires_at,source) VALUES ($1,$2,$3,$4,$5,$6,now()+$7::interval,$8)
      RETURNING id,label,scope,project,destructive,expires_at`,
      [
        id,
        value.label,
        digest(token),
        value.scope,
        value.project ?? null,
        value.destructive,
        lifetime,
        source,
      ],
    );
    return { ...rows[0], token };
  }
  async authenticate(token) {
    if (typeof token !== "string" || !/^wr_[A-Za-z0-9_-]{43}$/.test(token))
      throw new InputError("Invalid agent credentials.", 401);
    const { rows } = await this.pool.query(
      `UPDATE shared_infra.agent_tokens SET last_used_at=now()
      WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())
      RETURNING id,label,scope,project,destructive`,
      [digest(token)],
    );
    if (!rows.length) throw new InputError("Invalid agent credentials.", 401);
    return rows[0];
  }
  async list() {
    return (
      await this.pool.query(
        "SELECT id,label,scope,project,destructive,created_at,expires_at,revoked_at,last_used_at FROM shared_infra.agent_tokens WHERE source='mcp' ORDER BY created_at DESC LIMIT 100",
      )
    ).rows;
  }
  async revoke(id) {
    return {
      revoked:
        (
          await this.pool.query(
            "UPDATE shared_infra.agent_tokens SET revoked_at=now() WHERE id=$1",
            [id],
          )
        ).rowCount === 1,
    };
  }
  async history(actor) {
    return (
      await this.pool.query(
        `SELECT o.id,o.token_id,o.tool,o.target,o.status,o.outcome,o.created_at,o.updated_at,
      CASE WHEN t.scope='admin' OR t.source='system' THEN 'admin' ELSE t.label END AS actor
      FROM shared_infra.agent_operations o
      JOIN shared_infra.agent_tokens t ON t.id=o.token_id
      WHERE ($1::boolean OR o.token_id=$2 OR (
        $3::text IS NOT NULL AND (
          o.outcome->>'project'=$3
          OR (o.target LIKE '{%' AND o.target::jsonb->>'project'=$3)
        )
      ))
      ORDER BY o.created_at DESC LIMIT 100`,
        [actor.scope === "admin", actor.id, actor.project ?? null],
      )
    ).rows;
  }
  async recordSystem(tool, target, outcome) {
    await this.pool.query(
      `INSERT INTO shared_infra.agent_tokens
      (id,label,token_hash,scope,project,destructive,expires_at,source)
      VALUES ('00000000-0000-0000-0000-000000000001','admin','system','admin',NULL,true,NULL,'system')
      ON CONFLICT DO NOTHING`,
    );
    await this.pool.query(
      `INSERT INTO shared_infra.agent_operations(token_id,id,tool,target,fingerprint,status,outcome)
      VALUES ('00000000-0000-0000-0000-000000000001',$1,$2,$3,'system','completed',$4)`,
      [randomUUID(), tool, target, summary(outcome)],
    );
  }
  async acknowledge(tokenId, id) {
    const result = await this.pool.query(
      `UPDATE shared_infra.agent_operations SET status='acknowledged',updated_at=now()
      WHERE token_id=$1 AND id=$2 AND status IN ('started','uncertain') RETURNING id,status`,
      [tokenId, id],
    );
    if (!result.rowCount)
      throw new InputError("No unresolved operation found.");
    return result.rows[0];
  }
  async run(actor, tool, args, target, handler) {
    const client = await this.pool.connect();
    let locked = false;
    let reserved = false;
    const lock = `wardroom-agent:${args.project || "shared"}`;
    try {
      locked = (
        await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [lock],
        )
      ).rows[0].locked;
      if (!locked)
        throw new InputError(
          "Another operation is active for this target.",
          409,
        );
      const fp = fingerprint(this.secret, { tool, args, target });
      const inserted = await client.query(
        `INSERT INTO shared_infra.agent_operations(token_id,id,tool,target,fingerprint,status)
        VALUES ($1,$2,$3,$4,$5,'started') ON CONFLICT DO NOTHING`,
        [actor.id, args.operationId, tool, target, fp],
      );
      if (!inserted.rowCount) {
        const previous = (
          await client.query(
            "SELECT fingerprint,status,outcome FROM shared_infra.agent_operations WHERE token_id=$1 AND id=$2",
            [actor.id, args.operationId],
          )
        ).rows[0];
        if (previous.fingerprint !== fp)
          throw new InputError(
            "Operation ID already belongs to different arguments.",
            409,
          );
        if (previous.status !== "completed")
          throw new InputError(
            "Operation outcome needs operator reconciliation. Do not automatically retry.",
            409,
          );
        return {
          operationId: args.operationId,
          status: "completed",
          replayed: true,
          target,
          outcome: previous.outcome,
        };
      }
      reserved = true;
      const result = await handler();
      await client.query(
        "UPDATE shared_infra.agent_operations SET status='completed',outcome=$3,updated_at=now() WHERE token_id=$1 AND id=$2",
        [actor.id, args.operationId, summary(result)],
      );
      return { operationId: args.operationId, status: "completed", result };
    } catch (error) {
      if (reserved)
        await client
          .query(
            "UPDATE shared_infra.agent_operations SET status='uncertain',outcome=$3,updated_at=now() WHERE token_id=$1 AND id=$2",
            [
              actor.id,
              args.operationId,
              summary({ removed: error.removedTargets || [] }),
            ],
          )
          .catch(() => {});
      throw error;
    } finally {
      // A broken connection must never be returned to the pool with a session lock.
      let broken = false;
      if (locked)
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            [lock],
          );
        } catch {
          broken = true;
        }
      client.release(broken);
    }
  }
}
