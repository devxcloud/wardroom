import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentResources } from "../dashboard/agent/resources.mjs";

test("project owner roles may have CREATEDB and extra users remain unprivileged", async () => {
  const calls = [];
  const resources = new AgentResources({
    pool: {
      query: async (sql, args) => {
        calls.push(sql);
        if (sql.includes("FROM pg_roles"))
          return {
            rows: [
              {
                rolsuper: false,
                rolcreatedb: true,
                rolcreaterole: false,
                rolreplication: false,
                rolbypassrls: false,
                memberships: false,
              },
            ],
          };
        return { rows: [], rowCount: 0 };
      },
    },
    projects: async () => [{ name: "thryx", database: "thryx" }],
  });
  await resources.role("thryx");
  const granted = await resources.grantCreatedb("thryx");
  assert.equal(granted.createdb, true);
  assert.ok(calls.some((sql) => /ALTER ROLE .* CREATEDB/.test(sql)));
  await assert.rejects(
    resources.role.call(
      {
        pool: {
          query: async () => ({
            rows: [
              {
                rolsuper: true,
                rolcreatedb: true,
                rolcreaterole: false,
                rolreplication: false,
                rolbypassrls: false,
                memberships: false,
              },
            ],
          }),
        },
      },
      "postgres",
    ),
    /unsafe/,
  );
});
