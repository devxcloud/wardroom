import { loadEnvFile } from "node:process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { DeleteBucketCommand } from "@aws-sdk/client-s3";
import { Infrastructure } from "../dashboard/infra.mjs";
import { configFrom } from "../dashboard/config.mjs";
import { quoteIdentifier as qi } from "../dashboard/domain.mjs";

loadEnvFile(".env");
const infra = new Infrastructure(configFrom());
const name = `infra_check_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const databases = [name, `${name}_test`];
const buckets = [
  name.replaceAll("_", "-"),
  `${name.replaceAll("_", "-")}-test`,
];
try {
  await infra.initialize();
  const project = await infra.provision({ name, password });
  assert.equal(project.status, "ready");
  await infra.provision({ name, password });
  await assert.rejects(
    infra.provision({ name, password: "incorrect-password" }),
    /does not match/,
  );
  await assert.rejects(
    infra.provision({ name: `${name}_other`, password, database: name }),
    /already belong/,
  );
  await assert.rejects(
    infra.provision({ name, password, database: `${name}_different` }),
    /reassigned/,
  );
  for (const database of databases)
    await infra.withDatabase(database, async (c) => {
      const result = await c.query(
        "SELECT '[1,2,3]'::vector <-> '[1,2,3]'::vector AS distance",
      );
      assert.equal(result.rows[0].distance, 0);
    });
  await infra.withDatabase(
    name,
    (c) =>
      c.query(
        'CREATE TABLE "odd table" (id integer PRIMARY KEY, "quoted column" text); INSERT INTO "odd table" SELECT n,\'example\' FROM generate_series(1,55) n',
      ),
    false,
  );
  const rows = await infra.rows(name, "public", "odd table", 0);
  assert.equal(rows.rows.length, 50);
  assert.equal(rows.hasMore, true);
  assert.equal(rows.rows[0].id, "1");
  assert.equal(rows.rows[1].id, "2");
  const next = await infra.rows(name, "public", "odd table", 50);
  assert.equal(next.rows.length, 5);
  assert.equal(next.hasMore, false);
  assert.equal(next.rows[0].id, "51");
  await assert.rejects(
    infra.rows(name, "pg_catalog", "pg_authid", 0),
    /not found/,
  );
  await assert.rejects(
    infra.rows(name, "public", "odd table; DROP DATABASE postgres;", 0),
    /not found/,
  );
  await assert.rejects(
    infra.withDatabase(name, (c) =>
      c.query("CREATE TABLE forbidden(id integer)"),
    ),
    /read-only/,
  );
  const overview = await infra.overview();
  assert.equal(
    overview.services.filter((s) => s.status === "healthy").length,
    4,
  );
  console.log(
    "Live integration passed: provisioning, retry, collision rejection, vector, pagination, read-only browsing, and service health.",
  );
} finally {
  // These exact random resources are created only by this test run.
  for (const db of databases)
    await infra.pool.query(`DROP DATABASE IF EXISTS ${qi(db)}`);
  await infra.pool.query(`DROP ROLE IF EXISTS ${qi(name)}`);
  for (const bucket of buckets)
    if (await infra.s3.bucketExists(bucket))
      await infra.s3Client.send(new DeleteBucketCommand({ Bucket: bucket }));
  await infra.pool.query("DELETE FROM shared_infra.events WHERE project=$1", [
    name,
  ]);
  await infra.pool.query("DELETE FROM shared_infra.projects WHERE name=$1", [
    name,
  ]);
  await infra.close();
  console.log(
    "Removed only this run’s temporary databases, role, empty buckets, and registry entries.",
  );
}
