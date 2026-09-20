import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentResources } from "../dashboard/agent/resources.mjs";

test("project owner roles may have CREATEDB and extra users remain unprivileged", async () => {
  const calls = [];
  const resources = new AgentResources({
    pool: {
      query: async (sql) => {
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
  const revoked = await resources.setCreatedb("thryx", false);
  assert.equal(revoked.createdb, false);
  assert.ok(calls.some((sql) => /ALTER ROLE .* NOCREATEDB/.test(sql)));
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

test("password-less rotate generates and stores a secret without returning it", async () => {
  const stored = {};
  const sql = [];
  const resources = new AgentResources(
    {
      pool: {
        query: async (text) => {
          sql.push(text);
          if (text.includes("FROM pg_roles"))
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
          return { rows: [], rowCount: 1 };
        },
      },
      projects: async () => [
        { name: "alpha", database: "alpha", bucket: "alpha" },
      ],
    },
    {
      secrets: {
        set: async (project, name, value) => {
          stored[`${project}:${name}`] = value;
        },
      },
    },
  );
  resources.owned = async () => ({ name: "alpha" });
  const result = await resources.rotate({ project: "alpha", user: "alpha" });
  assert.equal(result.rotated, true);
  assert.equal(result.generated, true);
  assert.equal("password" in result, false);
  assert.equal(stored["alpha:db:alpha"].length >= 12, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    new RegExp(stored["alpha:db:alpha"]),
  );
  assert.ok(sql.some((text) => /ALTER ROLE .* PASSWORD/.test(text)));
});
