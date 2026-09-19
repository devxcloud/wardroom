import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("API setup generates private keys once without rotating existing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "infra-api-config-"));
  const file = join(dir, ".env");
  try {
    await writeFile(file, "RI_ENCRYPTION_KEY=existing\n", { mode: 0o600 });
    const run = () =>
      execFileSync(
        process.execPath,
        ["scripts/ensure-private-config.mjs", "--api"],
        {
          env: { ...process.env, ENV_FILE: file },
          encoding: "utf8",
        },
      );
    const output = run();
    const first = await readFile(file, "utf8");
    assert.match(first, /^DASHBOARD_SESSION_SECRET=[a-f0-9]{64}$/m);
    assert.match(first, /^HOPPSCOTCH_DB_PASSWORD=[a-f0-9]{64}$/m);
    assert.match(first, /^HOPPSCOTCH_ENCRYPTION_KEY=[a-f0-9]{32}$/m);
    assert.doesNotMatch(output, /[a-f0-9]{32}/);
    run();
    assert.equal(await readFile(file, "utf8"), first);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
