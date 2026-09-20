import pg from "pg";
import { createClient } from "redis";
import {
  S3Client,
  ListBucketsCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import { TelemetryStore } from "./telemetry.mjs";
import { ToolService } from "./tools.mjs";
import {
  InputError,
  projectInput,
  quoteIdentifier as qi,
  quoteLiteral as ql,
  pageOffset,
} from "./domain.mjs";

export async function loadProjectSeeds(
  source = new URL("../projects.local.json", import.meta.url),
) {
  try {
    return JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export class Infrastructure {
  constructor(config) {
    this.config = config;
    this.pool = new pg.Pool(config.pg);
    this.pool.on("error", () => {});
    this.telemetry = new TelemetryStore(this.pool);
    this.tools = new ToolService({ host: config.host });
    this.s3Client = new S3Client({
      endpoint: `http://${config.s3.endPoint}:${config.s3.port}`,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey,
      },
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 4000, requestTimeout: 8000 },
    });
    this.s3 = {
      listBuckets: async () =>
        (await this.s3Client.send(new ListBucketsCommand({}))).Buckets.map(
          (b) => ({ name: b.Name, creationDate: b.CreationDate }),
        ),
      bucketExists: async (name) => {
        try {
          await this.s3Client.send(new HeadBucketCommand({ Bucket: name }));
          return true;
        } catch (e) {
          if (e.$metadata?.httpStatusCode === 404) return false;
          throw e;
        }
      },
      makeBucket: (name) =>
        this.s3Client.send(new CreateBucketCommand({ Bucket: name })),
    };
  }

  async initialize() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS shared_infra;
      REVOKE ALL ON SCHEMA shared_infra FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS shared_infra.projects (
        name text PRIMARY KEY, config jsonb NOT NULL, status text NOT NULL DEFAULT 'registered',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS shared_infra.events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, project text NOT NULL,
        message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`);
    await this.telemetry.initialize();
    const seeds = await loadProjectSeeds();
    for (const seed of seeds) {
      const value = projectInput(seed);
      await this.pool.query(
        "INSERT INTO shared_infra.projects(name, config) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [value.name, value],
      );
    }
  }

  async projects() {
    return (
      await this.pool.query(
        "SELECT config, status, created_at, updated_at FROM shared_infra.projects ORDER BY name",
      )
    ).rows.map((r) => ({
      ...r.config,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async provision(input) {
    const p = projectInput(input);
    if (
      typeof input.password !== "string" ||
      input.password.length < 1 ||
      input.password.length > 256 ||
      input.password.includes("\0")
    )
      throw new InputError(
        "Supply a database password (maximum 256 characters).",
      );
    const client = await this.pool.connect();
    let registered = false;
    try {
      await client.query("SELECT pg_advisory_lock(734901)");
      const entries = await this.projects();
      const existing = entries.find((x) => x.name === p.name);
      for (const entry of entries) {
        if (entry.name === p.name) {
          for (const key of [
            "database",
            "testDatabase",
            "bucket",
            "testBucket",
          ]) {
            if (entry[key] !== p[key])
              throw new InputError(
                "Existing project resources cannot be reassigned.",
                409,
              );
          }
          continue;
        }
        if (
          [p.database, p.testDatabase].some((v) =>
            [entry.database, entry.testDatabase].includes(v),
          ) ||
          [p.bucket, p.testBucket].some((v) =>
            [entry.bucket, entry.testBucket].includes(v),
          )
        )
          throw new InputError(
            `Resources already belong to ${entry.name}.`,
            409,
          );
      }
      const role = (
        await client.query(
          "SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname=$1",
          [p.name],
        )
      ).rows[0];
      if (!role && input.password.length < 12)
        throw new InputError(
          "New database passwords must have at least 12 characters.",
        );
      if (
        role &&
        (!existing || role.rolsuper || role.rolcreaterole || role.rolcreatedb)
      )
        throw new InputError(
          "Existing role cannot be adopted by this project.",
          409,
        );
      for (const db of [p.database, p.testDatabase]) {
        const found = (
          await client.query(
            "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
            [db],
          )
        ).rows[0];
        if (found && (!existing || found.owner !== p.name))
          throw new InputError(
            `Database ${db} already exists with a conflicting owner.`,
            409,
          );
      }
      for (const bucket of [p.bucket, p.testBucket]) {
        if ((await this.s3.bucketExists(bucket)) && !existing)
          throw new InputError(
            `Bucket ${bucket} already exists outside this project.`,
            409,
          );
      }
      // An existing password is never silently rotated by an idempotent retry.
      if (role) {
        const login = new pg.Client({
          ...this.config.pg,
          user: p.name,
          password: input.password,
          database: "postgres",
        });
        try {
          await login.connect();
        } catch {
          throw new InputError(
            "The existing project password does not match.",
            409,
          );
        } finally {
          await login.end();
        }
      }
      await client.query(
        `INSERT INTO shared_infra.projects(name,config,status) VALUES ($1,$2,'provisioning')
        ON CONFLICT(name) DO UPDATE SET status='provisioning',updated_at=now()`,
        [p.name, p],
      );
      registered = true;
      if (!role)
        await client.query(
          `CREATE ROLE ${qi(p.name)} LOGIN PASSWORD ${ql(input.password)}`,
        );
      for (const db of [p.database, p.testDatabase]) {
        if (
          !(
            await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [
              db,
            ])
          ).rowCount
        )
          await client.query(`CREATE DATABASE ${qi(db)} OWNER ${qi(p.name)}`);
        await this.withDatabase(
          db,
          (c) =>
            c.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public"),
          false,
        );
      }
      for (const bucket of [p.bucket, p.testBucket])
        if (!(await this.s3.bucketExists(bucket)))
          await this.s3.makeBucket(bucket, "us-east-1");
      await client.query(
        "UPDATE shared_infra.projects SET status='ready',updated_at=now() WHERE name=$1",
        [p.name],
      );
      await client.query(
        "INSERT INTO shared_infra.events(project,message) VALUES ($1,'Project provisioned')",
        [p.name],
      );
      return { ...p, status: "ready" };
    } catch (error) {
      if (registered) {
        await client.query(
          "UPDATE shared_infra.projects SET status='failed',updated_at=now() WHERE name=$1",
          [p.name],
        );
        await client.query(
          "INSERT INTO shared_infra.events(project,message) VALUES ($1,'Provisioning interrupted; retry with the same settings')",
          [p.name],
        );
      }
      throw error;
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(734901)");
      } finally {
        client.release();
      }
    }
  }

  async withDatabase(database, task, readonly = true) {
    if (
      typeof database !== "string" ||
      database.length > 63 ||
      !(
        await this.pool.query(
          "SELECT 1 FROM pg_database WHERE datname=$1 AND datallowconn AND NOT datistemplate",
          [database],
        )
      ).rowCount
    )
      throw new InputError("Database not found.", 404);
    const client = new pg.Client({ ...this.config.pg, database });
    try {
      await client.connect();
      await client.query(readonly ? "BEGIN READ ONLY" : "BEGIN");
      await client.query("SET LOCAL statement_timeout='5s'");
      const result = await task(client);
      await client.query("COMMIT");
      return result;
    } finally {
      await client.end();
    }
  }

  async databases() {
    return (
      await this.pool
        .query(`SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner,
      pg_database_size(d.oid)::float8 AS bytes, pg_encoding_to_char(d.encoding) AS encoding,
      (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid) AS connections
      FROM pg_database d WHERE NOT d.datistemplate AND d.datallowconn ORDER BY d.datname`)
    ).rows;
  }

  async roles() {
    return (
      await this.pool
        .query(`SELECT rolname AS name, rolcanlogin AS login, rolsuper AS superuser,
      rolcreatedb AS "createDb", rolcreaterole AS "createRole", rolconnlimit AS "connectionLimit"
      FROM pg_roles WHERE rolname NOT LIKE 'pg_%' ORDER BY rolname`)
    ).rows;
  }

  async tables(database) {
    return this.withDatabase(
      database,
      async (c) =>
        (
          await c.query(`SELECT n.nspname AS schema, c.relname AS name,
      c.reltuples::bigint AS "estimatedRows", pg_total_relation_size(c.oid)::float8 AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema','shared_infra')
      AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,c.relname`)
        ).rows,
    );
  }

  async rows(
    database,
    schema,
    table,
    offsetValue,
    withDatabase = this.withDatabase.bind(this),
  ) {
    const offset = pageOffset(offsetValue);
    if (typeof schema !== "string" || typeof table !== "string")
      throw new InputError("Select a table.");
    return withDatabase(database, async (c) => {
      const allowed = await c.query(
        `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p')
        AND n.nspname NOT IN ('pg_catalog','information_schema','shared_infra') AND n.nspname NOT LIKE 'pg_toast%'`,
        [schema, table],
      );
      if (!allowed.rowCount) throw new InputError("Table not found.", 404);
      const columns = (
        await c.query(
          `SELECT attname AS name,format_type(atttypid,atttypmod) AS type,attnotnull AS required
        FROM pg_attribute WHERE attrelid=$1 AND attnum>0 AND NOT attisdropped ORDER BY attnum`,
          [allowed.rows[0].oid],
        )
      ).rows;
      // Bound response size per cell. Large binary/text/vector values are previews.
      const projection = columns
        .map((col) => `left(${qi(col.name)}::text,2000) AS ${qi(col.name)}`)
        .join(",");
      const keys = (
        await c.query(
          `SELECT a.attname AS name FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE i.indrelid=$1 AND i.indisprimary ORDER BY k.ord`,
          [allowed.rows[0].oid],
        )
      ).rows;
      const order = keys.length
        ? keys.map((k) => `source.${qi(k.name)}`).join(",")
        : "source.tableoid,source.ctid";
      const result = await c.query(
        `SELECT ${projection || "*"} FROM ${qi(schema)}.${qi(table)} AS source ORDER BY ${order} LIMIT 51 OFFSET $1`,
        [offset],
      );
      return {
        columns,
        rows: result.rows.slice(0, 50),
        hasMore: result.rows.length > 50,
        offset,
        limit: 50,
      };
    });
  }

  async redisInfo() {
    const client = createClient(this.config.redis);
    client.on("error", () => {});
    try {
      await client.connect();
      const info = await client.info();
      const parsed = Object.fromEntries(
        info
          .split("\r\n")
          .filter((l) => l.includes(":"))
          .map((l) => {
            const i = l.indexOf(":");
            return [l.slice(0, i), l.slice(i + 1)];
          }),
      );
      return {
        version: parsed.redis_version,
        memory: parsed.used_memory_human,
        clients: Number(parsed.connected_clients),
        keys: parsed.db0 || "keys=0",
        uptime: Number(parsed.uptime_in_seconds),
      };
    } finally {
      if (client.isOpen) client.destroy();
    }
  }

  async overview() {
    const checks = [
      [
        "postgres",
        async () => ({
          version: (await this.pool.query("SHOW server_version")).rows[0]
            .server_version,
        }),
      ],
      ["redis", () => this.redisInfo()],
      [
        "minio",
        async () => ({ buckets: (await this.s3.listBuckets()).length }),
      ],
      [
        "mailpit",
        async () => {
          const r = await fetch(`${this.config.mailpit}/readyz`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!r.ok) throw Error();
          return {};
        },
      ],
    ];
    const services = await Promise.all(
      checks.map(async ([id, fn]) => {
        const start = performance.now();
        try {
          return {
            id,
            status: "healthy",
            ...(await fn()),
            checkedAt: new Date().toISOString(),
            duration: Math.round(performance.now() - start),
          };
        } catch {
          return {
            id,
            status: "unreachable",
            checkedAt: new Date().toISOString(),
          };
        }
      }),
    );
    const [projects, databases, events] = await Promise.all([
      this.projects().catch(() => []),
      this.databases().catch(() => []),
      this.pool
        .query(
          "SELECT project,message,created_at FROM shared_infra.events ORDER BY id DESC LIMIT 8",
        )
        .then((r) => r.rows)
        .catch(() => []),
    ]);
    return {
      host: this.config.host,
      services,
      projects,
      databases,
      events,
      checkedAt: new Date().toISOString(),
    };
  }
  async close() {
    this.s3Client.destroy();
    await this.pool.end();
  }
}
