import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSample,
  summary,
  TelemetryStore,
} from "../dashboard/telemetry.mjs";
import { createApp } from "../dashboard/server.mjs";
import { sample } from "./telemetry-fixture.mjs";

test("telemetry allowlists fields and distinguishes unknown values from zero", () => {
  const data = sample();
  data.secret = "not-for-browser";
  data.docker.items[0].env = "secret";
  data.cpu.percent = null;
  data.io.readBytesPerSecond = 0;
  data.lvm.volumeGroups[0].secret = "not-for-browser";
  const clean = validateSample(data);
  assert.equal(clean.secret, undefined);
  assert.equal(clean.docker.items[0].env, undefined);
  assert.equal(clean.cpu.percent, null);
  assert.equal(summary(clean).diskRead, 0);
  assert.equal(clean.lvm.volumeGroups[0].freeBytes, 85000);
  assert.equal(clean.lvm.volumeGroups[0].secret, undefined);
  delete data.lvm;
  assert.equal(validateSample(data).lvm.available, false);
});
test("reject malformed, unbounded, stale and future telemetry", () => {
  for (const change of [
    (s) => {
      s.memory.usedPercent = 101;
    },
    (s) => {
      s.cpu.cores = [null];
    },
    (s) => {
      s.docker.items = Array(129).fill(s.docker.items[0]);
    },
    (s) => {
      s.collectedAt = new Date(Date.now() - 121000).toISOString();
    },
    (s) => {
      s.collectedAt = new Date(Date.now() + 20000).toISOString();
    },
    (s) => {
      s.io.readBytesPerSecond = -1;
    },
    (s) => {
      s.lvm = {
        available: true,
        source: "sysfs",
        volumeGroups: [null],
        physicalVolumes: [],
        logicalVolumes: [],
      };
    },
  ]) {
    const s = sample();
    change(s);
    assert.throws(
      () => validateSample(s),
      (e) => e.status === 400,
    );
  }
  for (const value of [null, [], {}, "bad"])
    assert.throws(
      () => validateSample(value),
      (e) => e.status === 400,
    );
});
test("history range is fixed, bounded, and reports stale samples", async () => {
  const queries = [];
  const store = new TelemetryStore({
    query: async (sql, args) => {
      queries.push({ sql, args });
      return {
        rows: sql.includes("SELECT data")
          ? [{ data: sample(), received_at: new Date(Date.now() - 40000) }]
          : [{ time: "100", cpu: 1 }],
      };
    },
  });
  const data = await store.read("24h");
  assert.equal(data.stale, true);
  assert.equal(data.history[0].time, 100000);
  assert.equal(data.stepSeconds, 120);
  assert.equal(data.windowSeconds, 86400);
  assert.match(queries[1].sql, /LIMIT 721/);
  assert.deepEqual(queries[1].args, [120, 86400]);
  await assert.rejects(store.read("2years"), (e) => e.status === 400);
});
test("telemetry ingestion has separate authentication from dashboard viewing", async (t) => {
  let ingested = 0;
  const token = "test-telemetry-token-of-32-characters";
  const app = createApp(
    {
      telemetry: {
        ingest: async (input) => {
          validateSample(input);
          ingested++;
        },
        read: async () => ({ sample: sample() }),
      },
    },
    { password: "test-dashboard-password", telemetryToken: token },
  );
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { "Content-Type": "application/json" };
  assert.equal(
    (
      await fetch(`${base}/api/telemetry`, {
        method: "POST",
        headers,
        body: JSON.stringify(sample()),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/system`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/telemetry`, {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body: JSON.stringify(sample()),
      })
    ).status,
    202,
  );
  assert.equal(ingested, 1);
  assert.equal(
    (
      await fetch(`${base}/api/telemetry`, {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body: "x".repeat(262145),
      })
    ).status,
    413,
  );
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ password: "test-dashboard-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await fetch(`${base}/api/system`, { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/telemetry`, {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        body: JSON.stringify(sample()),
      })
    ).status,
    401,
  );
});
