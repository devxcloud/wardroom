import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectInput,
  quoteIdentifier,
  quoteLiteral,
  pageOffset,
  connectionText,
} from "../dashboard/domain.mjs";

test("projects get independent valid database and bucket names", () => {
  const p = projectInput({ name: "sample_app" });
  assert.equal(p.database, "sample_app");
  assert.equal(p.testDatabase, "sample_app_test");
  assert.equal(p.bucket, "sample-app");
  assert.equal(p.testBucket, "sample-app-test");
  assert.equal(p.redisPrefix, "sample_app:");
});
test("reject reserved, invalid and overlapping resource names", () => {
  for (const input of [
    { name: "a" },
    { name: "postgres" },
    { name: "test" },
    { name: "local" },
    { name: "mail" },
    { name: "Bad" },
    { name: "sample", database: "same", testDatabase: "same" },
    { name: "sample", bucket: "bad_name" },
    { name: "sample", bucket: "ab" },
    { name: "sample", bucket: "good", testBucket: "good" },
    { name: "sample", database: "postgres" },
    { name: "sample", bucket: "a".repeat(62) },
  ])
    assert.throws(() => projectInput(input));
});
test("quote SQL identifiers and literals without interpolation escapes", () => {
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
  assert.equal(quoteLiteral("it's"), "'it''s'");
});
test("pagination is bounded", () => {
  assert.equal(pageOffset("50"), 50);
  for (const v of [-1, "DROP TABLE", "1.5", 100001])
    assert.throws(() => pageOffset(v));
});
test("connection templates contain placeholders and test isolation", () => {
  const text = connectionText(projectInput({ name: "sample" }), "100.1.2.3");
  assert.match(text, /<PROJECT_DB_PASSWORD>/);
  assert.match(text, /sample-test/);
  assert.match(text, /sample:test:/);
  assert.match(text, /MAIL_DOMAIN=sample\.test/);
  assert.doesNotMatch(text, /secret-db-pass/);
  const filled = connectionText(projectInput({ name: "sample" }), "100.1.2.3", {
    dbPassword: "secret-db-pass",
    s3AccessKey: "wrabc",
    s3SecretKey: "s3secret",
  });
  assert.match(filled, /secret-db-pass/);
  assert.match(filled, /S3_ACCESS_KEY=wrabc/);
  assert.doesNotMatch(filled, /<PROJECT_DB_PASSWORD>/);
});
