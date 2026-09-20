import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectSecrets } from "../dashboard/agent/secrets.mjs";

test("project secrets encrypt at rest and never store plaintext", async () => {
  const rows = new Map();
  const pool = {
    query: async (sql, args) => {
      if (sql.includes("INSERT")) {
        rows.set(`${args[0]}:${args[1]}`, {
          nonce: args[2],
          ciphertext: args[3],
        });
        return { rowCount: 1 };
      }
      const row = rows.get(`${args[0]}:${args[1]}`);
      return { rows: row ? [row] : [] };
    },
  };
  const secrets = new ProjectSecrets(pool, "x".repeat(32));
  await secrets.set("alpha", "db:alpha", "stored-password-12");
  const stored = [...rows.values()][0];
  assert.equal(Buffer.isBuffer(stored.ciphertext), true);
  assert.doesNotMatch(stored.ciphertext.toString("utf8"), /stored-password-12/);
  assert.equal(await secrets.get("alpha", "db:alpha"), "stored-password-12");
  assert.equal(await secrets.get("alpha", "missing"), null);
});
