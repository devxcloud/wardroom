import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { AgentDump } from "../dashboard/agent/dump.mjs";

function fakeChild({ stdoutChunks = [], code = 0 } = {}) {
  const stdin = new PassThrough();
  stdin.resume();
  const stdout = Readable.from(stdoutChunks);
  const stderr = Readable.from([]);
  let closed = false;
  const child = {
    stdin,
    stdout,
    stderr,
    kill() {},
    on(event, cb) {
      if (event !== "close") return child;
      const finish = () => {
        if (closed) return;
        closed = true;
        cb(code);
      };
      if (stdoutChunks.length) stdout.on("end", finish);
      else stdin.on("finish", finish);
      return child;
    },
  };
  return child;
}

function dumpHarness({ dumpCode = 0, restoreCode = 0, owned = [], secrets } = {}) {
  const puts = [];
  const sends = [];
  const sql = [];
  const spawned = [];
  const created = [];
  const objects = new Map();
  const dump = new AgentDump(
    {
      config: {
        pg: { host: "postgres", port: 5432, user: "postgres", password: "x" },
      },
      s3Client: {
        send: async (command) => {
          const input = command.input;
          sends.push({ name: command.constructor.name, ...input });
          if (command.constructor.name === "HeadObjectCommand") {
            if (!objects.has(input.Key)) {
              const error = new Error("NotFound");
              error.name = "NotFound";
              error.$metadata = { httpStatusCode: 404 };
              throw error;
            }
            return {};
          }
          if (command.constructor.name === "GetObjectCommand")
            return { Body: Readable.from([objects.get(input.Key) || Buffer.from("DUMP")]) };
          if (command.constructor.name === "CopyObjectCommand") {
            const sourceKey = input.CopySource.split("/")
              .slice(1)
              .map(decodeURIComponent)
              .join("/");
            objects.set(input.Key, objects.get(sourceKey));
          }
          if (command.constructor.name === "DeleteObjectCommand")
            objects.delete(input.Key);
          return {};
        },
      },
      withDatabase: async (database, fn) => {
        sql.push(database);
        return fn({
          query: async (text, args) => {
            sql.push({ text, args });
            if (String(text).includes("owned_objects"))
              return { rows: owned };
            return { rows: [] };
          },
        });
      },
    },
    {
      secrets:
        secrets === undefined
          ? {
              get: async (project, name) =>
                name === `db:${project}` ? "stored-password-12" : null,
            }
          : secrets,
      owned: async () => ({ name: "alpha" }),
      project: async () => ({
        name: "alpha",
        bucket: "alpha",
        testBucket: "alpha-test",
      }),
      list: async () => [
        { kind: "bucket", name: "alpha" },
        { kind: "bucket", name: "alpha-test" },
        ...created
          .filter((item) => item.kind === "bucket")
          .map((item) => ({ kind: "bucket", name: item.name })),
      ],
      create: async (_project, kind, name, _password, options = {}) => {
        created.push({ kind, name, attachIam: options.attachIam });
        return { kind, name };
      },
      drop: async (_project, kind, name) => {
        const index = created.findIndex(
          (item) => item.kind === kind && item.name === name,
        );
        if (index >= 0) created.splice(index, 1);
        return { kind, name, removed: true };
      },
    },
    {
      spawnProcess: (command, args, options) => {
        spawned.push({ command, args, env: options?.env });
        if (command === "pg_dump")
          return fakeChild({
            stdoutChunks: [Buffer.from("DUMP")],
            code: dumpCode,
          });
        return fakeChild({ code: restoreCode });
      },
      putObjectStream: async (_client, params) => {
        const chunks = [];
        for await (const chunk of params.Body) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        objects.set(params.Key, body);
        puts.push({
          bucket: params.Bucket,
          key: params.Key,
          body,
        });
      },
    },
  );
  return { dump, puts, sends, sql, spawned, created, objects };
}

test("database backup publishes the final key only after pg_dump exits 0", async () => {
  const { dump, puts, sends, sql, spawned, created, objects } = dumpHarness({
    owned: [
      { obj: "relation", sub: "r", schema: "app", name: "sample", extra: null },
      {
        obj: "routine",
        sub: "f",
        schema: "app",
        name: "sample_inc",
        extra: "integer",
      },
      { obj: "type", sub: "d", schema: "public", name: "sample_dom", extra: null },
    ],
  });
  const backup = await dump.backup({ project: "alpha", database: "alpha" });
  assert.deepEqual(
    created.map((item) => item.name),
    ["alpha-backups"],
  );
  assert.equal(created[0].attachIam, false);
  assert.equal(backup.bucket, "alpha-backups");
  assert.match(puts[0].key, /^backups\/\.incomplete\/alpha-.*\.dump$/);
  assert.match(backup.key, /^backups\/alpha-.*\.dump$/);
  assert.doesNotMatch(backup.key, /incomplete/);
  assert.equal(objects.has(puts[0].key), false);
  assert.equal(objects.has(backup.key), true);
  assert.equal(
    sends.find((s) => s.name === "CopyObjectCommand").Key,
    backup.key,
  );
  assert.equal(spawned[0].env.PGUSER, "postgres");
  assert.equal("DASHBOARD_PASSWORD" in spawned[0].env, false);
  const restored = await dump.restore({
    project: "alpha",
    database: "alpha_snap",
    key: backup.key,
  });
  assert.equal(restored.restored, true);
  assert.equal(restored.bucket, "alpha-backups");
  const restore = spawned.find((s) => s.command === "pg_restore");
  assert.ok(restore?.args?.includes("--no-owner"), JSON.stringify(spawned));
  assert.equal(restore.env.PGUSER, "alpha");
  assert.equal(restore.env.PGPASSWORD, "stored-password-12");
  const statements = sql.map((item) =>
    typeof item === "string" ? item : item?.text,
  );
  assert.ok(
    statements.some((text) =>
      /ALTER TABLE "app"\."sample" OWNER TO "alpha"/.test(String(text)),
    ),
  );
  assert.ok(
    statements.some((text) =>
      /ALTER FUNCTION "app"\."sample_inc"\(integer\) OWNER TO "alpha"/.test(
        String(text),
      ),
    ),
  );
});

test("a failed pg_dump leaves zero objects in the bucket", async () => {
  const { dump, objects } = dumpHarness({ dumpCode: 1 });
  await assert.rejects(
    dump.backup({ project: "alpha", database: "alpha" }),
    /pg_dump failed/,
  );
  assert.equal(objects.size, 0);
});

test("restore refuses incomplete dump keys", async () => {
  const { dump, spawned, created } = dumpHarness();
  await assert.rejects(
    dump.restore({
      project: "alpha",
      database: "alpha_snap",
      key: "backups/.incomplete/alpha.dump",
    }),
    /Incomplete dump/,
  );
  assert.equal(
    spawned.some((s) => s.command === "pg_restore"),
    false,
  );
  assert.equal(
    created.some((item) => item.name === "alpha_snap"),
    false,
  );
});

test("restore defaults to the backups bucket and does not create a database for a missing object", async () => {
  const { dump, created, sends } = dumpHarness();
  await assert.rejects(
    dump.restore({
      project: "alpha",
      database: "alpha_snap",
      key: "backups/missing.dump",
    }),
    /not found/,
  );
  assert.equal(
    created.some((item) => item.name === "alpha_snap"),
    false,
  );
  assert.equal(
    sends.some((item) => item.name === "HeadObjectCommand"),
    true,
  );
});

test("a failed pg_restore drops the extra database it created", async () => {
  const { dump, created } = dumpHarness({ restoreCode: 1 });
  const backup = await dump.backup({ project: "alpha", database: "alpha" });
  await assert.rejects(
    dump.restore({
      project: "alpha",
      database: "alpha_snap",
      key: backup.key,
    }),
    /pg_restore failed/,
  );
  assert.equal(
    created.some((item) => item.name === "alpha_snap"),
    false,
  );
});

test("restore without a stored project password does not spawn pg_restore", async () => {
  const { dump, spawned } = dumpHarness({ secrets: null });
  await assert.rejects(
    dump.restore({
      project: "alpha",
      database: "alpha_snap",
      key: "backups/alpha.dump",
    }),
    /password/,
  );
  assert.equal(
    spawned.some((s) => s.command === "pg_restore"),
    false,
  );
});
