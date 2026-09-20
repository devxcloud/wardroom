import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptAdmin,
  decryptAdmin,
  accessKeyFor,
  bucketPolicy,
  MinioIam,
} from "../dashboard/agent/minio-iam.mjs";

test("MinIO admin payload round-trips and access keys stay in bounds", async () => {
  const payload = Buffer.from(JSON.stringify({ status: "enabled", secretKey: "x".repeat(32) }));
  const password = "minio-root-password-value";
  const encrypted = await encryptAdmin(payload, password);
  assert.equal(encrypted.subarray(32, 33)[0], 0);
  assert.deepEqual(await decryptAdmin(encrypted, password), payload);
  const key = accessKeyFor("sample_app");
  assert.match(key, /^wr[a-f0-9]{16}$/);
  const policy = bucketPolicy(["sample-app", "sample-app-test"]);
  assert.ok(
    policy.Statement[0].Resource.includes("arn:aws:s3:::sample-app-test/*"),
  );
});

test("ensure mints a user, canned policy and attachment", async () => {
  const calls = [];
  const stored = {};
  const iam = new MinioIam(
    { endPoint: "minio", port: 9000, accessKey: "root", secretKey: "root-secret" },
    {
      fetch: async (url, options) => {
        calls.push(`${options.method} ${url.pathname}`);
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
      },
    },
  );
  await iam.ensure(
    "alpha",
    ["alpha", "alpha-test"],
    {
      get: async (_project, name) => stored[name] || null,
      set: async (_project, name, value) => {
        stored[name] = value;
      },
    },
  );
  assert.deepEqual(calls, [
    "PUT /minio/admin/v3/add-user",
    "PUT /minio/admin/v3/add-canned-policy",
    "PUT /minio/admin/v3/set-user-or-group-policy",
  ]);
  assert.equal(stored["s3:access"], accessKeyFor("alpha"));
  assert.equal(typeof stored["s3:secret"], "string");
  assert.ok(stored["s3:secret"].length >= 16);
});
