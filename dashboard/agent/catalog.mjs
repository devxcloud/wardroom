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
import { ProjectSecrets } from "./secrets.mjs";
import { AgentMail, mailDomain } from "./mail.mjs";
import { MinioIam } from "./minio-iam.mjs";
import { AgentDump } from "./dump.mjs";
import { assertReadOnlySql } from "./sql-read.mjs";

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
  const secrets = store?.secret
    ? new ProjectSecrets(infra.pool, store.secret)
    : infra.secrets;
  const iam =
    infra.iam || (infra.config?.s3 ? new MinioIam(infra.config.s3) : null);
  const resources = new AgentResources(infra, { secrets, iam });
  const data = new AgentData(infra, resources);
  const mail = new AgentMail(infra.config?.mailpit);
  const dump = new AgentDump(infra, resources);
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
    async (a) => {
      const stored = secrets ? await secrets.load(a.project) : {};
      return {
        project: await resources.project(a.project),
        resources: await resources.list(a.project),
        secrets: {
          database: Boolean(stored.dbPassword),
          s3: Boolean(stored.s3AccessKey && stored.s3SecretKey),
        },
      };
    },
  );
  add(
    "project_connections",
    "Connection templates. Pass includeSecrets on a destructive project token to fill the stored database password and MinIO service-account keys. Redis stays a placeholder (shared). The browser connections endpoint never returns secrets.",
    { ...page, includeSecrets: z.boolean().default(false) },
    async (a, actor) => {
      if (a.includeSecrets && actor.destructive !== true)
        throw new InputError(
          "Token does not allow destructive operations.",
          403,
        );
      const stored =
        a.includeSecrets && secrets ? await secrets.load(a.project) : {};
      return {
        text: connectionText(
          await resources.project(a.project),
          infra.config.host,
          stored,
        ),
        mailDomain: mailDomain(a.project),
        secrets: {
          database: Boolean(stored.dbPassword),
          s3: Boolean(stored.s3AccessKey && stored.s3SecretKey),
        },
      };
    },
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
  add(
    "database_list",
    "List databases owned by this project, including extra test databases the project login created.",
    page,
    async (a) => {
      const names = (await resources.list(a.project))
        .filter((r) => r.kind === "database")
        .map((r) => r.name);
      return {
        databases: (await infra.databases())
          .filter((d) => d.owner === a.project || names.includes(d.name))
          .map((d) => ({
            ...d,
            ageSeconds: d.createdAt
              ? Math.max(
                  0,
                  Math.floor((Date.now() - new Date(d.createdAt)) / 1000),
                )
              : null,
          })),
      };
    },
  );
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
      password: password.optional(),
      offset: z.number().int().min(0).max(100000).default(0),
    },
    async (a) => {
      return resources.rows(a);
    },
  );
  write(
    "database_create",
    "Create an extra registered database owned by the project, with pgvector. The project login can also CREATE DATABASE itself after user_createdb.",
    { database: identifier },
    (a) => resources.create(a.project, "database", a.database),
  );
  write(
    "database_drop",
    "Drop an extra database owned by the project, registered or created by the project login. Refuses active connections and base databases.",
    { database: identifier },
    (a) => resources.drop(a.project, "database", a.database),
    { destructive: true },
  );
  write(
    "database_backup",
    "pg_dump custom-format backup of an owned database. Defaults to the project's {bucket}-backups bucket (created if missing), not the live application bucket. Default key backups/{database}-{timestamp}.dump.",
    {
      database: identifier,
      bucket: bucketName.optional(),
    },
    (a) => dump.backup(a),
  );
  write(
    "database_restore",
    "Restore a custom-format dump object into a new extra database. Objects are reassigned to the project login so the app can read them. Refuses existing names. Destructive.",
    {
      database: identifier,
      bucket: bucketName.optional(),
      key,
    },
    (a) => dump.restore(a),
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
    "user_createdb",
    "Grant CREATEDB to the project owner login so it can create extra test databases. Does not grant superuser or CREATEROLE. Do not ask for admin SQL passwords.",
    {},
    (a) => resources.setCreatedb(a.project, true),
  );
  write(
    "user_set_createdb",
    "Grant or revoke CREATEDB on the project owner login. Extra logins stay without CREATEDB. Does not grant superuser or CREATEROLE.",
    { enabled: z.boolean() },
    (a) => resources.setCreatedb(a.project, a.enabled),
  );
  write(
    "user_password_rotate",
    "Rotate a project login password. Omit password to generate one server-side, store it, and return nothing — read it once with project_connections includeSecrets on a destructive token. Passing a password is recorded by the AI client.",
    { user: identifier, password: password.optional() },
    (a) => resources.rotate(a),
    { destructive: true },
  );
  write(
    "sql_execute",
    "Execute SQL as a project login, NEVER as the infrastructure admin. All SQL needs destructive permission. Password and SQL may be retained by your AI client. Eight-second hard deadline; interrupted writes may be uncertain.",
    {
      database: identifier,
      user: identifier,
      password: password.optional(),
      sql: z.string().min(1).max(32768),
    },
    (a) => resources.sql(a),
    { destructive: true },
  );
  add(
    "sql_query",
    "Read-only SQL as a project login in a READ ONLY transaction. SELECT/WITH/EXPLAIN/SHOW only, one statement, 100-row/128KiB cap, 8s deadline. Password may be omitted after a successful login or provision stored it. Does not require a destructive token.",
    {
      ...page,
      database: identifier,
      user: identifier,
      password: password.optional(),
      sql: z.string().min(1).max(32768),
    },
    (a) => {
      assertReadOnlySql(a.sql);
      return resources.sql(a, true);
    },
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
  write(
    "s3_credentials_rotate",
    "Mint or replace the project's MinIO service account. Policy is limited to owned buckets. Applications using previous keys must be updated. Root MinIO credentials are not returned.",
    {},
    async (a) => {
      if (!iam || !secrets)
        throw new InputError("MinIO identity is not configured.", 503);
      await iam.rotate(
        a.project,
        await resources.appBuckets(a.project),
        secrets,
      );
      return { project: a.project, rotated: true };
    },
    { destructive: true },
  );
  add(
    "mail_list",
    "List captured Mailpit messages whose From or To/Cc/Bcc domain is exactly {project}.test or {project}.local. Shared inbox; other projects' mail is hidden.",
    {
      ...page,
      query: z.string().max(300).optional(),
      start: z.number().int().min(0).max(100000).default(0),
    },
    (a) => mail.list(a),
  );
  add(
    "mail_search",
    "Search Mailpit then keep only messages in this project's mail domain.",
    { ...page, query: z.string().min(1).max(300) },
    (a) => mail.list(a),
  );
  add(
    "mail_get",
    "Read one captured message, including a 32 KiB text/html body. Must belong to this project's mail domain.",
    { ...page, id: z.string().min(1).max(128) },
    (a) => mail.get(a),
  );
  write(
    "mail_delete",
    "Delete one captured message after verifying it belongs to this project's mail domain. Never wipes the shared inbox.",
    { id: z.string().min(1).max(128) },
    (a) => mail.remove(a),
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
    "Host CPU, memory, mounted filesystems, LVM volume groups, I/O and network, with freshness. storage[].availableBytes is filesystem free on a mounted volume; lvm.volumeGroups[].freeBytes is unallocated LVM space and is usually much larger. Project callers do not receive other containers' metadata.",
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
          lvm: latest?.lvm,
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
      "List containers on the host, without environment secrets. class=control cannot be stopped; class=wardroom cannot be deleted.",
      {},
      () => lab.containers("list"),
      { admin: true },
    );
    add(
      "container_logs",
      "Read a bounded tail of a container's logs; output may contain application secrets. Pass service for a Wardroom Compose service or name for any container.",
      {
        service: z.string().min(1).max(64).optional(),
        name: z.string().min(1).max(128).optional(),
        lines: z.number().int().min(1).max(200).default(100),
      },
      (a) => lab.containers("logs", a),
      { admin: true },
    );
    add(
      "container_action",
      "Start, stop, restart, or remove a container by Compose service or container name. Control-plane containers cannot be stopped or removed. Wardroom service containers cannot be deleted. No shell or exec.",
      {
        operationId: operationSchema,
        service: z.string().min(1).max(64).optional(),
        name: z.string().min(1).max(128).optional(),
        action: z.enum(["start", "stop", "restart", "remove"]),
      },
      (a) => lab.containers(a.action, a),
      { admin: true, destructive: true, mutation: true },
    );
    add(
      "volume_list",
      "List Docker volumes on the host, including disk usage when available. Wardroom data volumes are marked protected.",
      {},
      () => lab.containers("volume_list"),
      { admin: true },
    );
    add(
      "volume_create",
      "Create a named Docker volume. Does not attach it to a container.",
      {
        operationId: operationSchema,
        name: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
      },
      (a) => lab.containers("volume_create", a),
      { admin: true, mutation: true },
    );
    add(
      "lvm_list",
      "List host LVM volume groups and logical volumes with unallocated VG space. Filesystem free on a mount is not VG free. Use lvm_extend to grow a logical volume.",
      {},
      () => lab.host("list"),
      { admin: true },
    );
    add(
      "lvm_extend",
      "Grow a host LVM logical volume to an absolute sizeGiB (GiB, 1024^3) and expand its ext4/xfs filesystem. Never shrinks. Example: vg=ubuntu-vg lv=ubuntu-lv sizeGiB=200. Requires unallocated VG space from lvm_list.",
      {
        operationId: operationSchema,
        vg: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,126}$/),
        lv: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,126}$/),
        sizeGiB: z.number().int().min(1).max(65536),
      },
      (a) => lab.host("extend", a),
      { admin: true, destructive: true, mutation: true },
    );
    add(
      "volume_remove",
      "Remove an unused Docker volume. Refuses Wardroom data volumes and volumes still mounted by a container.",
      {
        operationId: operationSchema,
        name: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
      },
      (a) => lab.containers("volume_remove", a),
      { admin: true, destructive: true, mutation: true },
    );
    add(
      "network_list",
      "List Docker networks on the host. Built-in and Wardroom compose networks are marked protected.",
      {},
      () => lab.containers("network_list"),
      { admin: true },
    );
    add(
      "network_create",
      "Create a user bridge network. Does not attach containers.",
      {
        operationId: operationSchema,
        name: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
      },
      (a) => lab.containers("network_create", a),
      { admin: true, mutation: true },
    );
    add(
      "network_remove",
      "Remove an unused Docker network. Refuses bridge/host/none and Wardroom compose networks.",
      {
        operationId: operationSchema,
        name: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
      },
      (a) => lab.containers("network_remove", a),
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
              "name",
              "action",
              "vg",
              "lv",
              "sizeGiB",
              "enabled",
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
