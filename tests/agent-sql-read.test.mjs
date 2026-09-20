import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReadOnlySql } from "../dashboard/agent/sql-read.mjs";
import { createCatalog } from "../dashboard/agent/catalog.mjs";

test("sql_query accepts a single read-only statement and rejects writes", () => {
  assertReadOnlySql("SELECT 1");
  assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x");
  assertReadOnlySql("EXPLAIN SELECT 1");
  assert.throws(() => assertReadOnlySql("INSERT INTO t VALUES (1)"), /read-only/);
  assert.throws(() => assertReadOnlySql("SELECT 1; DROP TABLE t"), /single/);
  assert.throws(() => assertReadOnlySql("SELECT 1; SELECT 2"), /single/);
});

test("sql_query is visible without destructive access and execute is not", async () => {
  const catalog = createCatalog(
    { projects: async () => [{ name: "alpha" }] },
    {},
  );
  const actor = { scope: "project", project: "alpha", destructive: false };
  const names = catalog.visible(actor).map((d) => d.name);
  assert.ok(names.includes("sql_query"));
  assert.ok(!names.includes("sql_execute"));
  await assert.rejects(
    catalog.call(actor, "sql_query", {
      project: "alpha",
      database: "alpha",
      user: "alpha",
      sql: "DELETE FROM t",
    }),
    /read-only/,
  );
});

test("project_connections secrets stay off until a destructive token asks", async () => {
  const catalog = createCatalog(
    {
      config: { host: "devbox" },
      secrets: {
        load: async () => ({
          dbPassword: "stored-password-12",
          s3AccessKey: "wrkey",
          s3SecretKey: "wrsecret",
        }),
      },
      projects: async () => [
        {
          name: "alpha",
          database: "alpha",
          testDatabase: "alpha_test",
          bucket: "alpha",
          testBucket: "alpha-test",
          redisPrefix: "alpha:",
        },
      ],
    },
    {},
  );
  const safe = await catalog.call(
    { scope: "project", project: "alpha", destructive: false },
    "project_connections",
    { project: "alpha" },
  );
  assert.match(safe.text, /<PROJECT_DB_PASSWORD>/);
  assert.equal(safe.secrets.database, false);
  await assert.rejects(
    catalog.call(
      { scope: "project", project: "alpha", destructive: false },
      "project_connections",
      { project: "alpha", includeSecrets: true },
    ),
    /destructive/,
  );
  const filled = await catalog.call(
    { scope: "project", project: "alpha", destructive: true },
    "project_connections",
    { project: "alpha", includeSecrets: true },
  );
  assert.match(filled.text, /stored-password-12/);
  assert.match(filled.text, /S3_ACCESS_KEY=wrkey/);
  assert.equal(filled.secrets.database, true);
  assert.equal(filled.secrets.s3, true);
  await assert.rejects(
    catalog.call(
      { scope: "project", project: "alpha", destructive: true, source: "chat" },
      "project_connections",
      { project: "alpha", includeSecrets: true },
    ),
    /Chat cannot return live connection secrets/,
  );
});
