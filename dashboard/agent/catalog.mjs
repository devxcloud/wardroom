import { z } from "zod";
import { InputError, connectionText } from "../domain.mjs";
import {
  authorize,
  nameSchema,
  operationSchema,
  provisioningInput,
  protectedNames,
} from "./policy.mjs";
import { AgentResources } from "./resources.mjs";
import { AgentData } from "./data.mjs";

const identifier = z.string().regex(/^[a-z][a-z0-9_]{2,62}$/);
const bucketName = z.string().regex(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/);
const password = z
  .string()
  .min(12)
  .max(256)
  .refine((s) => !s.includes("\0"));
const key = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !/[\x00-\x1f]/.test(s));
const page = { project: nameSchema };
const mutation = { ...page, operationId: operationSchema };

export function createCatalog(infra, store, { lab } = {}) {
  const resources = new AgentResources(infra);
  const data = new AgentData(infra, resources);
  const definitions = [];
  const add = (name, description, shape, handler, flags = {}) =>
    definitions.push({
      name,
      description,
      schema: z.object(shape).strict(),
      handler,
      ...flags,
    });
  const write = (name, description, shape, handler, flags = {}) =>
    add(name, description, { ...mutation, ...shape }, handler, {
      mutation: true,
      ...flags,
    });
  add(
    "project_list",
    "List projects visible to this token.",
    {},
    async (_, actor) => ({
      projects: (await infra.projects()).filter(
        (p) =>
          !protectedNames.has(p.name) &&
          (actor.scope === "admin" || actor.project === p.name),
      ),
    }),
  );
  add(
    "project_get",
    "Inspect a registered project's resources.",
    page,
    async (a) => ({
      project: await resources.project(a.project),
      resources: await resources.list(a.project),
    }),
  );
  add(
    "project_connections",
    "Connection templates. Credentials are deliberately placeholders.",
    page,
    async (a) => ({
      text: connectionText(
        await resources.project(a.project),
        infra.config.host,
      ),
    }),
  );
  write(
    "project_provision",
    "Create a project's user, dev/test PostgreSQL+vector databases and S3 buckets. Password is sensitive; use the same password when retrying partial provisioning.",
    { password },
    (a) => infra.provision(provisioningInput(a)),
  );
  write(
    "project_retire",
    "Permanently remove ALL exact registered project resources. Partial failures require inspection.",
    {},
    (a) => resources.retire(a.project),
    { destructive: true },
  );
  add("database_list", "List owned databases and sizes.", page, async (a) => {
    const names = (await resources.list(a.project))
      .filter((r) => r.kind === "database")
      .map((r) => r.name);
    return {
      databases: (await infra.databases()).filter((d) =>
        names.includes(d.name),
      ),
    };
  });
  add(
    "user_list",
    "List project database users, without passwords.",
    page,
    async (a) => {
      const names = (await resources.list(a.project))
        .filter((r) => r.kind === "user")
        .map((r) => r.name);
      return {
        users: (await infra.roles()).filter((r) => names.includes(r.name)),
      };
    },
  );
  add(
    "table_list",
    "List tables in an owned database.",
    { ...page, database: identifier },
    async (a) => {
      await resources.owned(a.project, "database", a.database);
      return { tables: await infra.tables(a.database) };
    },
  );
  add(
    "table_rows",
    "Read a bounded preview as a project login. Password is sensitive; project-defined casts never run as admin.",
    {
      ...page,
      database: identifier,
      schema: identifier,
      table: identifier,
      user: identifier,
      password,
      offset: z.number().int().min(0).max(100000).default(0),
    },
    async (a) => {
      return resources.rows(a);
    },
  );
  write(
    "database_create",
    "Create an extra database with the project owner and pgvector.",
    { database: identifier },
    (a) => resources.create(a.project, "database", a.database),
  );
  write(
    "database_drop",
    "Drop an extra registered database; refuses active connections and base databases.",
    { database: identifier },
    (a) => resources.drop(a.project, "database", a.database),
    { destructive: true },
  );
  write(
    "user_create",
    "Create an extra unprivileged project login. Password input is sensitive.",
    { user: identifier, password },
    (a) => resources.create(a.project, "user", a.user, a.password),
  );
  write(
    "user_drop",
    "Drop an extra project login. Refuses remaining dependencies.",
    { user: identifier },
    (a) => resources.drop(a.project, "user", a.user),
    { destructive: true },
  );
  write(
    "user_grant",
    "Add read or write privileges in an owned database's public schema. No role membership or admin grants.",
    {
      user: identifier,
      database: identifier,
      profile: z.enum(["read", "write"]),
    },
    (a) => resources.grant(a),
  );
  write(
    "user_password_rotate",
    "Explicitly rotate a project login password; existing applications need updating.",
    { user: identifier, password },
    (a) => resources.rotate(a),
    { destructive: true },
  );
  write(
    "sql_execute",
    "Execute SQL as a project login, NEVER as the infrastructure admin. All SQL needs destructive permission. Password and SQL may be retained by your AI client. Eight-second hard deadline; interrupted writes may be uncertain.",
    {
      database: identifier,
      user: identifier,
      password,
      sql: z.string().min(1).max(32768),
    },
    (a) => resources.sql(a),
    { destructive: true },
  );
  add(
    "redis_scan",
    "Scan one bounded page of project-relative Redis keys.",
    {
      ...page,
      cursor: z
        .string()
        .regex(/^\d{1,20}$/)
        .default("0"),
    },
    (a) => data.redis("scan", a),
  );
  add(
    "redis_get",
    "Inspect a relative key's type/TTL and bounded string value.",
    { ...page, key },
    (a) => data.redis("get", a),
  );
  write(
    "redis_set",
    "Set/overwrite a project-relative string key.",
    {
      key,
      value: z.string().max(16384),
      ttl: z.number().int().min(1).max(2592000).optional(),
    },
    (a) => data.redis("set", a),
    { overwrites: true },
  );
  write(
    "redis_delete",
    "Delete one exact project-relative key.",
    { key },
    (a) => data.redis("delete", a),
    { overwrites: true },
  );
  write(
    "redis_clear",
    "Remove the project's namespace in bounded batches; check complete before assuming empty.",
    {},
    (a) => data.redis("clear", a),
    { destructive: true },
  );
  add("bucket_list", "List registered project buckets.", page, async (a) => ({
    buckets: (await resources.list(a.project)).filter(
      (r) => r.kind === "bucket",
    ),
  }));
  write(
    "bucket_create",
    "Create an extra registered project bucket.",
    { bucket: bucketName },
    (a) => resources.create(a.project, "bucket", a.bucket),
  );
  write(
    "bucket_drop",
    "Delete an extra bucket. Empty-only by default; purge deletes objects, but refuses versioned buckets.",
    { bucket: bucketName, purge: z.boolean().default(false) },
    (a) => data.dropBucket(a),
    { destructive: true },
  );
  add(
    "object_list",
    "List a bounded page of object keys and sizes.",
    { ...page, bucket: bucketName, cursor: z.string().max(2048).optional() },
    (a) => data.objects("list", a),
  );
  add(
    "object_get",
    "Read at most 32 KiB of an object as base64; may contain sensitive application data.",
    { ...page, bucket: bucketName, key },
    (a) => data.objects("get", a),
  );
  write(
    "object_put",
    "Create/overwrite one object, at most 32 KiB decoded.",
    { bucket: bucketName, key, base64: z.string().max(43692) },
    (a) => data.objects("put", a),
    { overwrites: true },
  );
  write(
    "object_delete",
    "Delete one exact object.",
    { bucket: bucketName, key },
    (a) => data.objects("delete", a),
    { overwrites: true },
  );
  add(
    "service_health",
    "Check shared service availability without exposing other projects.",
    {},
    async () => ({ services: (await infra.overview()).services }),
  );
  add(
    "system_metrics",
    "Aggregate host utilization with freshness; project callers do not receive other containers' metadata.",
    { range: z.enum(["15m", "1h", "24h"]).default("15m") },
    async (a, actor) => {
      const result = structuredClone(await infra.telemetry.read(a.range));
      if (actor.scope !== "admin") {
        // Telemetry includes raw host inventory. Return only explicitly selected aggregate fields.
        const latest = result.sample;
        return {
          collectedAt: latest?.collectedAt,
          stale: result.stale,
          available: !!latest,
          cpu: latest?.cpu,
          memory: latest?.memory,
          storage: latest?.storage,
          io: latest?.io,
          network: latest?.network,
          history: result.history,
        };
      }
      return result;
    },
  );
  add(
    "operation_history",
    "Inspect sanitized mutation outcomes visible to this token.",
    {},
    (_, actor) => store.history(actor).then((operations) => ({ operations })),
  );
  if (lab) {
    add(
      "container_list",
      "Inspect Wardroom-managed containers, without environment secrets.",
      {},
      () => lab.containers("list"),
      { admin: true },
    );
    add(
      "container_logs",
      "Read a bounded tail of a managed service's logs; output may contain application secrets.",
      {
        service: z.string().min(1).max(48),
        lines: z.number().int().min(1).max(200).default(100),
      },
      (a) => lab.containers("logs", a),
      { admin: true },
    );
    add(
      "container_action",
      "Start, stop or restart one allowed managed service. No shell, exec, create or volume operations.",
      {
        operationId: operationSchema,
        service: z.string().min(1).max(48),
        action: z.enum(["start", "stop", "restart"]),
      },
      (a) => lab.containers(a.action, a),
      { admin: true, destructive: true, mutation: true },
    );
    add(
      "fault_apply",
      "Apply/reset an existing fixed shared test-lab fault.",
      {
        operationId: operationSchema,
        target: z.enum(["postgres", "redis", "minio"]),
        preset: z.enum([
          "latency-500",
          "latency-2000",
          "timeout",
          "disabled",
          "reset",
        ]),
      },
      (a) => infra.tools.applyFault(a.target, a.preset),
      { admin: true, destructive: true, mutation: true },
    );
    add("mock_list", "List owned WireMock mappings.", page, (a) =>
      lab.mocks("list", a),
    );
    write(
      "mock_create",
      "Create a project-owned static mock; proxying and file responses are not supported.",
      {
        method: z.enum([
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
        ]),
        path: z.string().regex(/^\/[A-Za-z0-9_\-/]{0,200}$/),
        status: z.number().int().min(200).max(599),
        body: z.string().max(16384),
      },
      (a) => lab.mocks("create", a),
    );
    write(
      "mock_delete",
      "Delete one exact project-owned mock.",
      { id: z.string().uuid() },
      (a) => lab.mocks("delete", a),
      { overwrites: true },
    );
  }
  let active = 0;
  return {
    visible(actor) {
      return definitions.filter(
        (d) =>
          (!d.admin || actor.scope === "admin") &&
          (!d.destructive || actor.destructive),
      );
    },
    visibleForApproval(actor) {
      return definitions.filter((d) => !d.admin || actor.scope === "admin");
    },
    async call(actor, name, args) {
      const d = definitions.find((d) => d.name === name);
      if (!d) throw new InputError("Unknown tool.");
      const parsed = d.schema.safeParse(args);
      if (!parsed.success)
        throw new InputError("Invalid tool arguments; check the tool schema.");
      const a = parsed.data;
      authorize(actor, a.project, d);
      if (active >= 2)
        throw new InputError(
          "Tool concurrency limit reached; retry later.",
          429,
        );
      active++;
      try {
        const target = JSON.stringify(
          Object.fromEntries(
            [
              "project",
              "database",
              "user",
              "bucket",
              "key",
              "service",
              "target",
              "id",
            ]
              .filter((k) => a[k] !== undefined)
              .map((k) => [k, a[k]]),
          ),
        );
        const result = d.mutation
          ? await store.run(actor, name, a, target, () => d.handler(a, actor))
          : await d.handler(a, actor);
        if (Buffer.byteLength(JSON.stringify(result)) > 192 * 1024)
          throw new InputError(
            "Result exceeded the response limit; use a narrower request.",
          );
        return result;
      } finally {
        active--;
      }
    },
  };
}
