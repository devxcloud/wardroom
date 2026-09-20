import { test } from "node:test";
import assert from "node:assert/strict";
import { AiSettings, validateConnection } from "../dashboard/ai/settings.mjs";

class SettingsPool {
  row = null;
  calls = [];
  async query(sql, values = []) {
    this.calls.push({ sql, values });
    if (/SELECT base_url/.test(sql))
      return { rows: this.row ? [this.row] : [] };
    if (/INSERT INTO shared_infra\.ai_settings/.test(sql)) {
      this.row = {
        base_url: values[0],
        model: values[1],
        api_key_encrypted: values[2],
        insecure_http: values[3],
      };
      return { rows: [] };
    }
    if (/DELETE FROM shared_infra\.ai_settings/.test(sql)) this.row = null;
    return { rows: [] };
  }
}

test("connection validation normalizes URLs and requires explicit insecure HTTP", () => {
  assert.throws(() =>
    validateConnection({
      baseUrl: "https://user:pass@example.test/v1",
      model: "sample",
    }),
  );
  assert.throws(() =>
    validateConnection({
      baseUrl: "http://inference:8000/v1",
      model: "sample",
    }),
  );
  assert.deepEqual(
    validateConnection({
      baseUrl: "http://inference:8000/v1/",
      model: " sample ",
      insecureHttp: true,
    }),
    {
      baseUrl: "http://inference:8000/v1",
      model: "sample",
      insecureHttp: true,
    },
  );
});

test("settings encrypt keys, redact public reads and preserve keys on same endpoint", async () => {
  const pool = new SettingsPool();
  const settings = new AiSettings(pool, "a".repeat(64));
  await settings.initialize();
  await settings.save({
    baseUrl: "https://provider.example/v1",
    model: "sample",
    apiKey: "private-test-key",
  });
  assert.equal((await settings.public()).hasKey, true);
  assert.doesNotMatch(
    JSON.stringify(await settings.public()),
    /private-test-key/,
  );
  assert.equal((await settings.private()).apiKey, "private-test-key");
  assert.doesNotMatch(JSON.stringify(pool.row), /private-test-key/);
  const ciphertext = pool.row.api_key_encrypted;
  await settings.save({
    baseUrl: "https://provider.example/v1",
    model: "better-model",
  });
  assert.equal(pool.row.api_key_encrypted, ciphertext);
  await settings.save({
    baseUrl: "https://different.example/v1",
    model: "better-model",
  });
  assert.equal(pool.row.api_key_encrypted, null);
});

test("settings fail closed with the wrong encryption key", async () => {
  const pool = new SettingsPool();
  const original = new AiSettings(pool, "b".repeat(64));
  await original.save({
    baseUrl: "https://provider.example/v1",
    model: "sample",
    apiKey: "private-test-key",
  });
  await assert.rejects(() => new AiSettings(pool, "c".repeat(64)).private());
});

test("connection previews use current form values without forwarding a key to a new host", async () => {
  const pool = new SettingsPool();
  const settings = new AiSettings(pool, "d".repeat(64));
  await settings.save({
    baseUrl: "https://provider.example/v1",
    model: "saved-model",
    apiKey: "saved-key",
  });
  assert.equal(
    (
      await settings.preview({
        baseUrl: "https://provider.example/v1",
        model: "edited-model",
      })
    ).apiKey,
    "saved-key",
  );
  assert.equal(
    (
      await settings.preview({
        baseUrl: "https://new.example/v1",
        model: "new-model",
      })
    ).apiKey,
    undefined,
  );
});
