import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectSecrets } from "../dashboard/agent/secrets.mjs";

test("project secrets encrypt at rest and never store plaintext", async () => {
  const rows = new Map();
  const pool = {
    query: async (sql, args) => {
      if (sql.includes("INSERT")) {
        rows.set(`${args[0]}:${args[1]}`, {
          name: args[1],
          nonce: args[2],
          ciphertext: args[3],
        });
        return { rowCount: 1 };
      }
      if (!args[1])
        return {
          rows: [...rows.entries()]
            .filter(([key]) => key.startsWith(`${args[0]}:`))
            .map(([, row]) => row),
        };
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
  await secrets.set("alpha", "db:alpha_bot", "extra-login-pass");
  await secrets.set("alpha", "s3:access", "wrkey");
  await secrets.set("alpha", "s3:secret", "wrsecret");
  const loaded = await secrets.load("alpha");
  assert.equal(loaded.dbPassword, "stored-password-12");
  assert.equal(loaded.dbUsers.alpha, "stored-password-12");
  assert.equal(loaded.dbUsers.alpha_bot, "extra-login-pass");
  assert.equal(loaded.s3AccessKey, "wrkey");
});
