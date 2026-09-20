import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorize,
  tokenInput,
  fingerprint,
  safeError,
  projectName,
} from "../dashboard/agent/policy.mjs";

test("project tokens cannot escape scope or opt themselves into destructive/admin tools", () => {
  const actor = { scope: "project", project: "alpha", destructive: false };
  authorize(actor, "alpha");
  assert.throws(() => authorize(actor, "beta"), /scope/);
  assert.throws(() => authorize(actor, "alpha", { admin: true }), /admin/);
  assert.throws(
    () => authorize(actor, "alpha", { destructive: true }),
    /destructive/,
  );
  assert.throws(
    () =>
      authorize({ scope: "admin", destructive: false }, "alpha", {
        destructive: true,
      }),
    /destructive/,
  );
  authorize({ scope: "admin", destructive: true }, "alpha", {
    destructive: true,
  });
});
test("token input is strict, bounded, and excludes control-plane projects", () => {
  assert.deepEqual(tokenInput({ label: "coding agent", project: "alpha" }), {
    label: "coding agent",
    project: "alpha",
    scope: "project",
    destructive: false,
    days: 30,
  });
  for (const project of [
    "postgres",
    "hoppscotch",
    "shared_infra",
    "test",
    "local",
    "mail",
    "abc*",
    "alpha:test",
  ])
    assert.throws(() => projectName(project));
  for (const input of [
    { label: "x", scope: "admin", project: "alpha" },
    { label: "x", project: "alpha", days: -1 },
    { label: "x", project: "alpha", days: 91 },
    { label: "x", project: "alpha", destructive: "true" },
    { label: "x", project: "alpha", root: true },
  ])
    assert.throws(() => tokenInput(input));
  assert.equal(
    tokenInput({ label: "durable", project: "alpha", days: 0 }).days,
    0,
  );
});
test("operation fingerprints are canonical and sensitive arguments are never exposed in errors", () => {
  assert.equal(
    fingerprint("secret", { b: 2, a: 1 }),
    fingerprint("secret", { a: 1, b: 2 }),
  );
  assert.notEqual(
    fingerprint("secret", { password: "one" }),
    fingerprint("secret", { password: "two" }),
  );
  assert.doesNotMatch(
    safeError(new Error("SQL failed PASSWORD 'private-value'")),
    /private-value/,
  );
});
