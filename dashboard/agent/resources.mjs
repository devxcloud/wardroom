import pg from "pg";
import {
  InputError,
  quoteIdentifier as qi,
  quoteLiteral as ql,
} from "../domain.mjs";
import { projectName, protectedNames } from "./policy.mjs";

export class AgentResources {
  constructor(infra) {
    this.infra = infra;
    this.pool = infra.pool;
  }
  async project(name) {
    projectName(name);
    const p = (await this.infra.projects()).find((p) => p.name === name);
    if (!p) throw new InputError("Project not found.", 404);
    return p;
  }
  async list(project) {
    const p = await this.project(project);
    const base = [
      ["database", p.database],
      ["database", p.testDatabase],
      ["user", p.name],
      ["bucket", p.bucket],
      ["bucket", p.testBucket],
    ].map(([kind, name]) => ({
      kind,
      name,
      project,
      status: "ready",
      base: true,
    }));
    const extra = (
      await this.pool.query(
        "SELECT kind,name,project,status FROM shared_infra.agent_resources WHERE project=$1 ORDER BY kind,name",
        [project],
      )
    ).rows;
    return [...base, ...extra];
  }
  async role(user) {
    const role = (
      await this.pool.query(
        `SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships
      FROM pg_roles r WHERE rolname=$1`,
        [user],
      )
    ).rows[0];
    if (
      !role ||
      role.rolsuper ||
      role.rolcreaterole ||
      role.rolreplication ||
      role.rolbypassrls ||
      role.memberships
    )
      throw new InputError("Role is missing or has unsafe privileges.", 403);
  }
  async owned(project, kind, name, { missing = false } = {}) {
    if (protectedNames.has(name))
      throw new InputError("Resource is not owned by this project.", 403);
    const entry = (await this.list(project)).find(
      (r) => r.kind === kind && r.name === name,
    );
    if (kind === "database") {
      const db = (
        await this.pool.query(
          "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
          [name],
        )
      ).rows[0];
      if (db && db.owner !== project)
        throw new InputError("Database ownership has changed.", 409);
      if (!db && !missing) throw new InputError("Database not found.", 404);
      if (entry) return entry;
      if (db && db.owner === project)
        return { kind, name, project, status: "ready", base: false };
    } else if (entry) {
      if (kind === "user" && !missing) await this.role(name);
      return entry;
    }
    throw new InputError("Resource is not owned by this project.", 403);
  }
  async grantCreatedb(project) {
    await this.project(project);
    await this.role(project);
    await this.pool.query(`ALTER ROLE ${qi(project)} CREATEDB`);
    return { project, user: project, createdb: true };
  }
  async create(project, kind, name, password) {
    const p = await this.project(project);
    const valid =
      kind === "bucket"
        ? /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/
        : /^[a-z][a-z0-9_]{2,62}$/;
    const prefix = kind === "bucket" ? `${p.bucket}-` : `${project}_`;
    if (
      !valid.test(name) ||
      !name.startsWith(prefix) ||
      protectedNames.has(name)
    )
      throw new InputError(
        "Extra resource must use its project's name prefix.",
      );
    if (
      kind === "user" &&
      (typeof password !== "string" ||
        password.length < 12 ||
        password.length > 256 ||
        password.includes("\0"))
    )
      throw new InputError("Supply a password of 12–256 characters.");
    const c = await this.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(734901)");
      const all = await this.infra.projects();
      const reserved = all.some((p) =>
        (kind === "database"
          ? [p.database, p.testDatabase]
          : kind === "user"
            ? [p.name]
            : [p.bucket, p.testBucket]
        ).includes(name),
      );
      if (reserved)
        throw new InputError("Resource name is reserved by a project.", 409);
      const registered = (
        await c.query(
          "SELECT project,status FROM shared_infra.agent_resources WHERE kind=$1 AND name=$2",
          [kind, name],
        )
      ).rows[0];
      if (registered)
        throw new InputError(
          "Resource already registered; inspect it instead of recreating.",
          409,
        );
      const exists =
        kind === "bucket"
          ? await this.infra.s3.bucketExists(name)
          : (
              await c.query(
                kind === "database"
                  ? "SELECT 1 FROM pg_database WHERE datname=$1"
                  : "SELECT 1 FROM pg_roles WHERE rolname=$1",
                [name],
              )
            ).rowCount;
      if (exists)
        throw new InputError(
          "Existing unregistered resource cannot be adopted.",
          409,
        );
      await c.query(
        "INSERT INTO shared_infra.agent_resources(kind,name,project,status) VALUES ($1,$2,$3,'creating')",
        [kind, name, project],
      );
      if (kind === "database") {
        await this.role(project);
        await c.query(`CREATE DATABASE ${qi(name)} OWNER ${qi(project)}`);
        await this.infra.withDatabase(
          name,
          (c) =>
            c.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public"),
          false,
        );
      } else if (kind === "user") {
        await c.query(
          `CREATE ROLE ${qi(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${ql(password)}`,
        );
      } else await this.infra.s3.makeBucket(name);
      await c.query(
        "UPDATE shared_infra.agent_resources SET status='ready' WHERE kind=$1 AND name=$2",
        [kind, name],
      );
      return { project, kind, name };
    } finally {
      let broken = false;
      try {
        await c.query("SELECT pg_advisory_unlock(734901)");
      } catch {
        broken = true;
      }
      c.release(broken);
    }
  }
  async drop(project, kind, name, allowBase = false) {
    const entry = await this.owned(project, kind, name, { missing: true });
    if (entry.base && !allowBase)
      throw new InputError("Use project_retire to remove base resources.");
    if (kind === "database")
      await this.pool.query(`DROP DATABASE IF EXISTS ${qi(name)}`);
    else if (kind === "user") {
      const exists = (
        await this.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])
      ).rowCount;
      if (exists) {
        await this.role(name);
        await this.pool.query(`DROP ROLE ${qi(name)}`);
      }
    } else throw new InputError("Use the bucket removal tool.");
    await this.pool.query(
      "DELETE FROM shared_infra.agent_resources WHERE kind=$1 AND name=$2 AND project=$3",
      [kind, name, project],
    );
    return { project, kind, name, removed: true };
  }
  async grant({ project, database, user, profile }) {
    await this.owned(project, "database", database);
    await this.owned(project, "user", user);
    if (!["read", "write"].includes(profile))
      throw new InputError("Unknown grant profile.");
    await this.infra.withDatabase(
      database,
      async (c) => {
        await c.query(
          `GRANT CONNECT ON DATABASE ${qi(database)} TO ${qi(user)}`,
        );
        await c.query(`GRANT USAGE ON SCHEMA public TO ${qi(user)}`);
        const privileges =
          profile === "read" ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE";
        await c.query(
          `GRANT ${privileges} ON ALL TABLES IN SCHEMA public TO ${qi(user)}`,
        );
        await c.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(project)} IN SCHEMA public GRANT ${privileges} ON TABLES TO ${qi(user)}`,
        );
        if (profile === "write")
          await c.query(
            `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${qi(user)}`,
          );
      },
      false,
    );
    return { project, database, user, profile };
  }
  async rotate({ project, user, password }) {
    await this.owned(project, "user", user);
    await this.pool.query(`ALTER ROLE ${qi(user)} PASSWORD ${ql(password)}`);
    return { project, user, rotated: true };
  }
  async withLogin(
    { project, database, user, password },
    task,
    readonly = false,
  ) {
    await this.owned(project, "database", database);
    await this.owned(project, "user", user);
    // Actual nonprivileged login. SET ROLE on the admin connection is not safe.
    const c = new pg.Client({
      ...this.infra.config.pg,
      database,
      user,
      password,
      statement_timeout: 5000,
      lock_timeout: 5000,
      query_timeout: 7000,
      application_name: "wardroom-agent",
    });
    let timer;
    try {
      await c.connect();
      timer = setTimeout(() => c.end().catch(() => {}), 8000);
      await c.query(readonly ? "BEGIN READ ONLY" : "BEGIN");
      const result = await task(c);
      await c.query("COMMIT");
      return result;
    } finally {
      clearTimeout(timer);
      await c.end().catch(() => {});
    }
  }
  async rows(args) {
    return this.infra.rows(
      args.database,
      args.schema,
      args.table,
      args.offset,
      (_, task) => this.withLogin(args, task, true),
    );
  }
  async sql(args) {
    const { database, sql } = args;
    return this.withLogin(args, async (c) => {
      const rows = [];
      let bytes = 0;
      let rowCount = 0;
      let truncated = false;
      await new Promise((resolve, reject) => {
        const query = new pg.Query(sql);
        query.on("row", (row) => {
          rowCount++;
          const size = Buffer.byteLength(JSON.stringify(row));
          if (rows.length < 100 && bytes + size < 128 * 1024) {
            rows.push(row);
            bytes += size;
          } else truncated = true;
        });
        query.on("error", reject);
        query.on("end", resolve);
        c.query(query);
      });
      return {
        database,
        rows,
        rowCount,
        truncated,
        transactional:
          "SQL may explicitly end its transaction; interrupted writes can have uncertain outcomes.",
      };
    });
  }
  async retire(project) {
    const { AgentData } = await import("./data.mjs");
    const data = new AgentData(this.infra, this);
    const resources = await this.list(project);
    const removed = [];
    try {
      if (resources.some((r) => r.kind === "mock")) {
        const { AgentLab } = await import("./lab.mjs");
        const lab = new AgentLab(this.infra, this);
        for (const r of resources.filter((r) => r.kind === "mock")) {
          await lab.mocks("delete", { project, id: r.name });
          removed.push(r.name);
        }
      }
      const cleared = await data.redis("clear", { project });
      if (!cleared.complete)
        throw new InputError(
          "Namespace cleanup incomplete; inspect and continue explicitly.",
        );
      for (const r of resources.filter((r) => r.kind === "bucket")) {
        await data.dropBucket({ project, bucket: r.name, purge: true }, true);
        removed.push(r.name);
      }
      for (const kind of ["database", "user"])
        for (const r of resources.filter((r) => r.kind === kind)) {
          await this.drop(project, kind, r.name, true);
          removed.push(r.name);
        }
      await this.pool.query(
        "DELETE FROM shared_infra.agent_resources WHERE project=$1",
        [project],
      );
      await this.pool.query(
        "DELETE FROM shared_infra.events WHERE project=$1",
        [project],
      );
      await this.pool.query("DELETE FROM shared_infra.projects WHERE name=$1", [
        project,
      ]);
      return { project, retired: true, removed };
    } catch {
      const error = new InputError(
        `Retirement incomplete. Removed exact resources: ${removed.join(", ") || "none"}. Inspect before continuing.`,
        409,
      );
      error.removedTargets = removed;
      throw error;
    }
  }
}
