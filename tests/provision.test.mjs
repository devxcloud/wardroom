import { test } from "node:test";
import assert from "node:assert/strict";
import { Infrastructure } from "../dashboard/infra.mjs";
import { projectInput } from "../dashboard/domain.mjs";

function fixture({
  projects = [],
  owner,
  role,
  bucketExists = false,
  failCreate = false,
} = {}) {
  const calls = [];
  const client = {
    release() {
      calls.push("release");
    },
    async query(sql, args) {
      calls.push(sql);
      if (sql.includes("FROM pg_roles")) return { rows: role ? [role] : [] };
      if (sql.includes("AS owner")) return { rows: owner ? [{ owner }] : [] };
      if (sql.startsWith("SELECT 1 FROM pg_database"))
        return { rowCount: 0, rows: [] };
      if (failCreate && sql.startsWith("CREATE DATABASE"))
        throw Error("simulate interruption");
      return { rows: [], rowCount: 0 };
    },
  };
  const infra = Object.create(Infrastructure.prototype);
  infra.pool = { connect: async () => client };
  infra.projects = async () => projects;
  infra.s3 = {
    bucketExists: async () => bucketExists,
    makeBucket: async (name) => calls.push(`bucket ${name}`),
  };
  infra.withDatabase = async (db, fn) => {
    calls.push(`database ${db}`);
    return fn(client);
  };
  return { infra, calls };
}
const input = { name: "sample", password: "long-project-password" };
test("provisions both databases and buckets without changing ownership", async () => {
  const { infra, calls } = fixture();
  const p = await infra.provision(input);
  assert.equal(p.status, "ready");
  assert.ok(calls.includes("bucket sample-test"));
  assert.ok(calls.includes("database sample_test"));
  assert.equal(calls.filter((x) => x.startsWith("CREATE ROLE")).length, 1);
  assert.ok(calls.some((x) => /CREATE ROLE .* CREATEDB/.test(x)));
  assert.ok(!calls.some((x) => /ALTER ROLE|ALTER DATABASE/.test(x)));
  assert.ok(calls.some((x) => x.includes("pg_advisory_unlock")));
  assert.equal(calls.at(-1), "release");
});
test("resource conflicts are rejected before writes", async () => {
  for (const setup of [
    { owner: "another" },
    { role: { rolname: "sample", rolsuper: false } },
    { bucketExists: true },
    { projects: [projectInput({ name: "another", database: "sample" })] },
    { projects: [projectInput({ name: "sample" })], owner: "another" },
    { projects: [projectInput({ name: "sample" })], role: { rolsuper: true } },
  ]) {
    const { infra, calls } = fixture(setup);
    await assert.rejects(infra.provision(input));
    assert.ok(!calls.some((x) => /^(CREATE|INSERT|UPDATE|ALTER)/.test(x)));
  }
});
test("partial failures are recorded and lock is released", async () => {
  const { infra, calls } = fixture({ failCreate: true });
  await assert.rejects(infra.provision(input));
  assert.ok(calls.some((x) => x.includes("status='failed'")));
  assert.ok(calls.some((x) => x.includes("pg_advisory_unlock")));
});
test("invalid passwords do not acquire database connection", async () => {
  const { infra, calls } = fixture();
  await assert.rejects(infra.provision({ ...input, password: "" }));
  assert.equal(calls.length, 0);
});
