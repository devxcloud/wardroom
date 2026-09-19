import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadProjectSeeds } from "../dashboard/infra.mjs";

test("a public checkout starts without a private project recipe", async () => {
  const missing = new URL(
    "fixtures/projects.local.missing.json",
    import.meta.url,
  );
  assert.deepEqual(await loadProjectSeeds(missing), []);
});

test("the committed project recipe is generic and valid JSON", async () => {
  const source = new URL("../projects.example.json", import.meta.url);
  const projects = JSON.parse(await readFile(source, "utf8"));
  assert.deepEqual(
    projects.map(({ name }) => name),
    ["example"],
  );
});
