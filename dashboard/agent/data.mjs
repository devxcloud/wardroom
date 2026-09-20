import { createClient } from "redis";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  GetBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { InputError } from "../domain.mjs";

export function redisKey(prefix, key) {
  if (
    typeof key !== "string" ||
    !key.length ||
    key.length > 256 ||
    /[\x00-\x1f]/.test(key)
  )
    throw new InputError("Invalid relative Redis key.");
  return prefix + key;
}
export class AgentData {
  constructor(infra, resources) {
    this.infra = infra;
    this.resources = resources;
  }
  async redis(action, { project, key, value, ttl, cursor = "0" }) {
    const p = await this.resources.project(project);
    if (p.redisPrefix !== `${project}:`)
      throw new InputError("Unexpected project Redis prefix.", 409);
    const client = createClient(this.infra.config.redis);
    client.on("error", () => {});
    const timer = setTimeout(() => {
      if (client.isOpen) client.destroy();
    }, 8000);
    try {
      await client.connect();
      const full = key === undefined ? null : redisKey(p.redisPrefix, key);
      if (action === "get") {
        const type = await client.type(full);
        const remaining = await client.ttl(full);
        if (type !== "string")
          return { key, type, ttl: remaining, value: null };
        const length = await client.strLen(full);
        return {
          key,
          type,
          ttl: remaining,
          value: await client.getRange(full, 0, 16383),
          truncated: length > 16384,
        };
      }
      if (action === "set") {
        await client.set(full, value, ttl ? { EX: ttl } : {});
        return { key, stored: true };
      }
      if (action === "delete") return { key, removed: await client.del(full) };
      if (action === "scan") {
        const result = await client.scan(cursor, {
          MATCH: `${p.redisPrefix}*`,
          COUNT: 100,
        });
        return {
          keys: result.keys
            .filter((k) => k.startsWith(p.redisPrefix))
            .slice(0, 500)
            .map((k) => k.slice(p.redisPrefix.length)),
          cursor: String(result.cursor),
          truncated: result.keys.length > 500,
        };
      }
      if (action === "clear") {
        let next = "0";
        let removed = 0;
        for (let i = 0; i < 100; i++) {
          const page = await client.scan(next, {
            MATCH: `${p.redisPrefix}*`,
            COUNT: 100,
          });
          const keys = page.keys.filter((k) => k.startsWith(p.redisPrefix));
          for (let j = 0; j < keys.length; j += 100)
            removed += await client.unlink(keys.slice(j, j + 100));
          next = String(page.cursor);
          if (next === "0") return { project, removed, complete: true };
        }
        return { project, removed, complete: false };
      }
      throw new InputError("Unknown Redis action.");
    } finally {
      clearTimeout(timer);
      if (client.isOpen) client.destroy();
    }
  }
  async objects(action, { project, bucket, key, base64, cursor }) {
    await this.resources.owned(project, "bucket", bucket);
    const send = (command) => this.infra.s3Client.send(command);
    if (action === "list") {
      const r = await send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: 100,
          ContinuationToken: cursor,
        }),
      );
      return {
        bucket,
        objects: (r.Contents || []).map((o) => ({
          key: o.Key,
          bytes: o.Size,
          modified: o.LastModified,
        })),
        cursor: r.NextContinuationToken,
        truncated: !!r.IsTruncated,
      };
    }
    if (action === "put") {
      const body = Buffer.from(base64, "base64");
      if (body.length > 32768 || body.toString("base64") !== base64)
        throw new InputError(
          "Supply canonical base64, at most 32 KiB decoded.",
        );
      await send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/octet-stream",
        }),
      );
      return { bucket, key, bytes: body.length };
    }
    if (action === "delete") {
      await send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { bucket, key, removed: true };
    }
    if (action === "get") {
      const r = await send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          Range: "bytes=0-32767",
        }),
      );
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of r.Body) {
          size += chunk.length;
          if (size > 32768)
            throw new InputError("Object response exceeded limit.");
          chunks.push(chunk);
        }
      } finally {
        r.Body.destroy?.();
      }
      const total = Number(r.ContentRange?.split("/")[1] || r.ContentLength);
      return {
        bucket,
        key,
        base64: Buffer.concat(chunks).toString("base64"),
        truncated: total > size,
        totalBytes: total,
      };
    }
    throw new InputError("Unknown storage action.");
  }
  async dropBucket({ project, bucket, purge = false }, allowBase = false) {
    const entry = await this.resources.owned(project, "bucket", bucket);
    if (entry.base && !allowBase)
      throw new InputError("Use project_retire to remove base buckets.");
    if (await this.infra.s3.bucketExists(bucket)) {
      const send = (command) => this.infra.s3Client.send(command);
      const versioning = await send(
        new GetBucketVersioningCommand({ Bucket: bucket }),
      );
      if (versioning.Status)
        throw new InputError("Versioned buckets require manual cleanup.", 409);
      if (purge) {
        for (let i = 0; i < 100; i++) {
          const page = await send(
            new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 100 }),
          );
          if (!page.Contents?.length) break;
          const result = await send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Objects: page.Contents.map((o) => ({ Key: o.Key })),
                Quiet: true,
              },
            }),
          );
          if (result.Errors?.length)
            throw new InputError("Some objects could not be removed.", 409);
        }
      }
      // S3 refuses a nonempty bucket; no hidden recursive fallback.
      await send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    await this.infra.pool.query(
      "DELETE FROM shared_infra.agent_resources WHERE kind='bucket' AND name=$1 AND project=$2",
      [bucket, project],
    );
    return { bucket, removed: true };
  }
}
