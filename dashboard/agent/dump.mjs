import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { InputError, quoteIdentifier as qi } from "../domain.mjs";

const stamp = () =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

function counting(onBytes) {
  return new Transform({
    transform(chunk, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

function finished(child, name, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new InputError("Database dump timed out.", 409));
    }, timeout);
    child.stderr?.resume?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT")
        reject(
          new InputError(
            `${name} is not installed in this environment.`,
            503,
          ),
        );
      else reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new InputError(
            `${name} failed. Inspect the database and object before retrying.`,
            409,
          ),
        );
    });
  });
}

async function defaultPut(client, params) {
  const upload = new Upload({ client, params });
  await upload.done();
}

function copySource(bucket, key) {
  return `${bucket}/${key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

export class AgentDump {
  constructor(
    infra,
    resources,
    { spawnProcess = spawn, putObjectStream = defaultPut } = {},
  ) {
    this.infra = infra;
    this.resources = resources;
    this.spawnProcess = spawnProcess;
    this.putObjectStream = putObjectStream;
  }
  env() {
    const pg = this.infra.config.pg;
    return {
      PATH: `/usr/libexec/postgresql18:/usr/bin:/usr/local/bin:${process.env.PATH || ""}`,
      PGHOST: pg.host,
      PGPORT: String(pg.port),
      PGUSER: pg.user,
      PGPASSWORD: pg.password,
      PGSSLMODE: "disable",
    };
  }
  start(command, args) {
    const child = this.spawnProcess(command, args, {
      env: { ...process.env, ...this.env() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.resume?.();
    return child;
  }
  async removeObject(bucket, key) {
    await this.infra.s3Client
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      .catch(() => {});
  }
  async backup({ project, database, bucket }) {
    await this.resources.owned(project, "database", database);
    const p = await this.resources.project(project);
    const target = bucket || `${p.bucket}-backups`;
    const listed = await this.resources.list(project);
    if (!listed.some((r) => r.kind === "bucket" && r.name === target))
      await this.resources.create(project, "bucket", target, undefined, {
        attachIam: false,
      });
    else await this.resources.owned(project, "bucket", target);
    const key = `backups/${database}-${stamp()}.dump`;
    const stagingKey = `backups/.incomplete/${key.slice("backups/".length)}`;
    const child = this.start("pg_dump", [
      "--format=custom",
      "--no-password",
      "--dbname",
      database,
    ]);
    let bytes = 0;
    const body = child.stdout.pipe(
      counting((n) => {
        bytes += n;
      }),
    );
    const uploaded = this.putObjectStream(this.infra.s3Client, {
      Bucket: target,
      Key: stagingKey,
      Body: body,
      ContentType: "application/octet-stream",
    });
    try {
      await Promise.all([uploaded, finished(child, "pg_dump")]);
      await this.infra.s3Client.send(
        new CopyObjectCommand({
          Bucket: target,
          Key: key,
          CopySource: copySource(target, stagingKey),
        }),
      );
      await this.removeObject(target, stagingKey);
    } catch (error) {
      child.kill?.("SIGKILL");
      await uploaded.catch(() => {});
      await this.removeObject(target, stagingKey);
      throw error;
    }
    return { project, database, bucket: target, key, bytes };
  }
  async restore({ project, database, bucket, key }) {
    if (/(^|\/)\.incomplete(\/|$)/.test(key))
      throw new InputError("Incomplete dump objects cannot be restored.");
    const p = await this.resources.project(project);
    const source = bucket || p.bucket;
    await this.resources.owned(project, "bucket", source);
    await this.resources.create(project, "database", database);
    const object = await this.infra.s3Client.send(
      new GetObjectCommand({ Bucket: source, Key: key }),
    );
    const child = this.start("pg_restore", [
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--single-transaction",
      "--no-password",
      `--dbname=${database}`,
    ]);
    const done = finished(child, "pg_restore");
    try {
      await pipeline(object.Body, child.stdin);
      await done;
    } catch (error) {
      child.kill?.("SIGKILL");
      throw error;
    }
    await this.grantProject(database, project);
    return { project, database, bucket: source, key, restored: true };
  }
  async grantProject(database, project) {
    const admin = this.infra.config.pg.user;
    if (!admin || admin === project) return;
    // REASSIGN OWNED BY <admin> is unsafe: the bootstrap superuser owns pinned
    // catalog objects in every database (error 2BP01). pgvector members are
    // skipped via pg_depend deptype 'e' so the extension stays intact.
    await this.infra.withDatabase(
      database,
      async (c) => {
        const { rows } = await c.query(
          `SELECT obj, sub, schema, name, extra FROM (
            SELECT 'relation'::text AS obj, c.relkind::text AS sub,
                   n.nspname AS schema, c.relname AS name, NULL::text AS extra
            FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE pg_get_userbyid(c.relowner)=$1
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg_%'
              AND c.relkind IN ('r','p','S','v','m','c','f')
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e'
              )
            UNION ALL
            SELECT 'routine', p.prokind::text, n.nspname, p.proname,
                   pg_get_function_identity_arguments(p.oid)
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE pg_get_userbyid(p.proowner)=$1
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg_%'
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e'
              )
            UNION ALL
            SELECT 'type', t.typtype::text, n.nspname, t.typname, NULL
            FROM pg_type t
            JOIN pg_namespace n ON n.oid=t.typnamespace
            WHERE pg_get_userbyid(t.typowner)=$1
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg_%'
              AND t.typtype IN ('d','e','c','r','m')
              AND (t.typrelid=0 OR EXISTS (
                SELECT 1 FROM pg_class c WHERE c.oid=t.typrelid AND c.relkind='c'
              ))
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend d WHERE d.objid=t.oid AND d.deptype='e'
              )
            UNION ALL
            SELECT 'schema', '', n.nspname, n.nspname, NULL
            FROM pg_namespace n
            WHERE pg_get_userbyid(n.nspowner)=$1
              AND n.nspname NOT IN ('pg_catalog','information_schema','public')
              AND n.nspname NOT LIKE 'pg_%'
          ) owned_objects`,
          [admin],
        );
        for (const row of rows) {
          if (row.obj === "relation") {
            const kind =
              row.sub === "S"
                ? "SEQUENCE"
                : row.sub === "v"
                  ? "VIEW"
                  : row.sub === "m"
                    ? "MATERIALIZED VIEW"
                    : row.sub === "c"
                      ? "TYPE"
                      : row.sub === "f"
                        ? "FOREIGN TABLE"
                        : "TABLE";
            await c.query(
              `ALTER ${kind} ${qi(row.schema)}.${qi(row.name)} OWNER TO ${qi(project)}`,
            );
          } else if (row.obj === "routine") {
            const kind =
              row.sub === "p"
                ? "PROCEDURE"
                : row.sub === "a"
                  ? "AGGREGATE"
                  : "FUNCTION";
            await c.query(
              `ALTER ${kind} ${qi(row.schema)}.${qi(row.name)}(${row.extra || ""}) OWNER TO ${qi(project)}`,
            );
          } else if (row.obj === "type")
            await c.query(
              `ALTER TYPE ${qi(row.schema)}.${qi(row.name)} OWNER TO ${qi(project)}`,
            );
          else if (row.obj === "schema")
            await c.query(
              `ALTER SCHEMA ${qi(row.name)} OWNER TO ${qi(project)}`,
            );
        }
      },
      false,
    );
  }
}
