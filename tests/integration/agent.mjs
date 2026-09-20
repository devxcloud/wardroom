import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Infrastructure } from "../../dashboard/infra.mjs";
import { configFrom } from "../../dashboard/config.mjs";
import { AgentStore } from "../../dashboard/agent/store.mjs";
import { AgentResources } from "../../dashboard/agent/resources.mjs";
import { AgentData } from "../../dashboard/agent/data.mjs";
import { createCatalog } from "../../dashboard/agent/catalog.mjs";

test("remote agent lifecycle is scoped, audited, retry-safe and revocable", async () => {
  const infra = new Infrastructure(configFrom());
  const store = new AgentStore(
    infra.pool,
    process.env.DASHBOARD_SESSION_SECRET,
  );
  const project = `agent_${randomBytes(5).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  let issued;
  let provisioned = false;
  try {
    await infra.initialize();
    await store.initialize();
    issued = await store.issue({
      label: "integration test",
      project,
      destructive: true,
    });
    const actor = await store.authenticate(issued.token);
    assert.ok(
      (await store.list()).find((token) => token.id === issued.id).last_used_at,
    );
    const catalog = createCatalog(infra, store);
    const provision = { project, password, operationId: randomUUID() };
    const first = await catalog.call(actor, "project_provision", provision);
    provisioned = true;
    assert.equal(first.status, "completed");
    assert.equal(
      (await catalog.call(actor, "project_provision", provision)).replayed,
      true,
    );
    await assert.rejects(
      catalog.call(actor, "project_provision", {
        ...provision,
        password: "changed-password",
      }),
      /different arguments/,
    );
    await assert.rejects(
      catalog.call(actor, "project_get", { project: "another_project" }),
      /scope/,
    );
    const resources = new AgentResources(infra);
    const data = new AgentData(infra, resources);
    const call = (tool, args = {}) =>
      catalog.call(actor, tool, {
        project,
        operationId: randomUUID(),
        ...args,
      });
    const db = `${project}_extra`;
    const user = `${project}_reader`;
    await call("database_create", { database: db });
    await call("user_create", { user, password });
    await call("user_grant", { database: db, user, profile: "read" });
    await call("sql_execute", {
      database: db,
      user: project,
      password,
      sql: "CREATE TABLE sample (id integer); INSERT INTO sample VALUES (7); CREATE SCHEMA app; CREATE FUNCTION app.sample_inc(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1 + 1'",
    });
    const read = await call("sql_execute", {
      database: db,
      user: project,
      password,
      sql: "SELECT id FROM sample",
    });
    assert.equal(read.result.rows[0].id, 7);
    await call("sql_execute", {
      database: db,
      user: project,
      password,
      sql: "CREATE TYPE probe_type AS (x integer); CREATE FUNCTION probe_text(probe_type) RETURNS text LANGUAGE sql STABLE AS 'SELECT current_user::text'; CREATE CAST (probe_type AS text) WITH FUNCTION probe_text(probe_type); CREATE TABLE cast_probe (v probe_type); INSERT INTO cast_probe VALUES (ROW(1)::probe_type)",
    });
    const preview = await catalog.call(actor, "table_rows", {
      project,
      database: db,
      schema: "public",
      table: "cast_probe",
      user: project,
      password,
    });
    assert.equal(
      preview.rows[0].v,
      project,
      "project-defined casts must not run as admin",
    );
    await assert.rejects(
      call("sql_execute", {
        database: "postgres",
        user: project,
        password,
        sql: "SELECT 1",
      }),
    );
    await assert.rejects(
      catalog.call({ ...actor, destructive: false }, "sql_execute", {
        project,
        operationId: randomUUID(),
        database: db,
        user: project,
        password,
        sql: "SELECT 1",
      }),
      /destructive/,
    );
    const queried = await catalog.call(
      { ...actor, destructive: false },
      "sql_query",
      {
        project,
        database: db,
        user: project,
        password,
        sql: "SELECT id FROM sample",
      },
    );
    assert.equal(queried.rows[0].id, 7);
    await assert.rejects(
      catalog.call(
        { ...actor, destructive: false },
        "sql_query",
        {
          project,
          database: db,
          user: project,
          password,
          sql: "DELETE FROM sample",
        },
      ),
      /read-only/,
    );
    const backup = await call("database_backup", { database: db });
    assert.match(backup.result.bucket, /-backups$/);
    const snap = `${project}_snap`;
    await call("database_restore", {
      database: snap,
      bucket: backup.result.bucket,
      key: backup.result.key,
    });
    const restored = await catalog.call(
      { ...actor, destructive: false },
      "sql_query",
      {
        project,
        database: snap,
        user: project,
        password,
        sql: "SELECT id FROM sample",
      },
    );
    assert.equal(restored.rows[0].id, 7);
    await call("sql_execute", {
      database: snap,
      user: project,
      password,
      sql: "CREATE OR REPLACE FUNCTION app.sample_inc(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1 + 2'",
    });
    const replaced = await catalog.call(
      { ...actor, destructive: false },
      "sql_query",
      {
        project,
        database: snap,
        user: project,
        password,
        sql: "SELECT app.sample_inc(1) AS n",
      },
    );
    assert.equal(replaced.rows[0].n, 3);
    await infra.pool.query(
      "DELETE FROM shared_infra.project_secrets WHERE project=$1 AND name=$2",
      [project, `db:${project}`],
    );
    await assert.rejects(
      catalog.call(
        { ...actor, destructive: false },
        "sql_query",
        {
          project,
          database: db,
          user: project,
          sql: "SELECT 1 AS n",
        },
      ),
      /password/,
    );
    const rotated = await call("user_password_rotate", { user: project });
    assert.equal(rotated.result.generated, true);
    assert.doesNotMatch(JSON.stringify(rotated), /PASSWORD|password":"/);
    const storedLogin = await catalog.call(
      { ...actor, destructive: false },
      "sql_query",
      {
        project,
        database: db,
        user: project,
        sql: "SELECT 1 AS n",
      },
    );
    assert.equal(storedLogin.rows[0].n, 1);
    await call("redis_set", { key: "sample", value: "hello", ttl: 60 });
    const redisAudit = (await store.history(actor)).find(
      (o) => o.tool === "redis_set",
    );
    assert.equal(JSON.parse(redisAudit.target).key, "sample");
    assert.equal(redisAudit.outcome.stored, true);
    assert.ok(!("value" in redisAudit.outcome));
    assert.equal(
      (await catalog.call(actor, "redis_get", { project, key: "sample" }))
        .value,
      "hello",
    );
    await call("redis_delete", { key: "sample" });
    const bucket = project.replaceAll("_", "-");
    await call("object_put", {
      bucket,
      key: "sample.txt",
      base64: Buffer.from("hello").toString("base64"),
    });
    assert.equal(
      (
        await catalog.call(actor, "object_get", {
          project,
          bucket,
          key: "sample.txt",
        })
      ).base64,
      "aGVsbG8=",
    );
    await call("object_delete", { bucket, key: "sample.txt" });
    await assert.rejects(
      data.objects("list", { project, bucket: "another-bucket" }),
    );
    const stored = await infra.pool.query(
      "SELECT token_hash FROM shared_infra.agent_tokens WHERE id=$1",
      [actor.id],
    );
    assert.notEqual(stored.rows[0].token_hash, issued.token);
    assert.doesNotMatch(
      JSON.stringify(await store.history(actor)),
      new RegExp(password),
    );
    const uncertainId = randomUUID();
    await assert.rejects(
      store.run(
        actor,
        "test_failure",
        { project, operationId: uncertainId },
        project,
        async () => {
          throw Error("private-test-value");
        },
      ),
    );
    assert.equal(
      (await store.history(actor)).find((o) => o.id === uncertainId).status,
      "uncertain",
    );
    await assert.rejects(
      store.run(
        actor,
        "test_failure",
        { project, operationId: uncertainId },
        project,
        async () => {
          throw Error("must not execute");
        },
      ),
      /reconciliation/,
    );
    await store.acknowledge(actor.id, uncertainId);
    assert.doesNotMatch(
      JSON.stringify(await store.history(actor)),
      /private-test-value/,
    );
    await infra.pool.query(
      "UPDATE shared_infra.agent_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
      [actor.id],
    );
    await assert.rejects(store.authenticate(issued.token), /credentials/);
    await infra.pool.query(
      "UPDATE shared_infra.agent_tokens SET expires_at=now()+interval '1 hour' WHERE id=$1",
      [actor.id],
    );
    await store.revoke(actor.id);
    await assert.rejects(store.authenticate(issued.token), /credentials/);
  } finally {
    // Only this run's exact registered resources may be retired.
    if (provisioned) await new AgentResources(infra).retire(project);
    if (issued) {
      await infra.pool.query(
        "DELETE FROM shared_infra.agent_operations WHERE token_id=$1",
        [issued.id],
      );
      await infra.pool.query(
        "DELETE FROM shared_infra.agent_tokens WHERE id=$1",
        [issued.id],
      );
    }
    await infra.close();
  }
});
