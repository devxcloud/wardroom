import http from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { InputError } from "../domain.mjs";

const lvmName = /^[A-Za-z0-9][A-Za-z0-9+_.-]{0,126}$/;
const hash = (s) => createHash("sha256").update(s).digest();
const GiB = 1024 ** 3;

export function mapperPath(vg, lv) {
  const enc = (value) => value.replaceAll("-", "--");
  return `/dev/mapper/${enc(vg)}-${enc(lv)}`;
}

export function runCommand(argv, { spawnImpl = spawn, timeout = 60000 } = {}) {
  if (!Array.isArray(argv) || !argv.length)
    throw new InputError("Invalid host command.");
  return new Promise((resolve, reject) => {
    const child = spawnImpl(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new InputError("Host storage command timed out.", 504));
    }, timeout);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 256 * 1024) child.kill("SIGKILL");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) child.kill("SIGKILL");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          new InputError(
            (stderr || stdout).replace(/\s+/g, " ").trim().slice(0, 280) ||
              "Host storage command failed.",
            409,
          ),
        );
      resolve({ stdout, stderr });
    });
  });
}

export async function nsenter(argv, options = {}) {
  return runCommand(
    ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "--", ...argv],
    options,
  );
}

function rows(report, key) {
  try {
    const parsed = JSON.parse(report);
    return parsed.report?.[0]?.[key] || [];
  } catch {
    throw new InputError("Invalid LVM report.");
  }
}

function bytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    throw new InputError("Invalid LVM size.");
  return n;
}

export class HostControl {
  constructor({ run = nsenter } = {}) {
    this.run = run;
  }
  async list() {
    const [vgs, lvs] = await Promise.all([
      this.run([
        "/usr/sbin/vgs",
        "--reportformat",
        "json",
        "--units",
        "b",
        "--nosuffix",
        "-o",
        "vg_name,vg_size,vg_free,pv_count,lv_count",
      ]),
      this.run([
        "/usr/sbin/lvs",
        "--reportformat",
        "json",
        "--units",
        "b",
        "--nosuffix",
        "-o",
        "lv_name,vg_name,lv_size,lv_path",
      ]),
    ]);
    const volumeGroups = rows(vgs.stdout, "vg").map((g) => ({
      name: g.vg_name,
      sizeBytes: bytes(g.vg_size),
      freeBytes: bytes(g.vg_free),
      allocatedBytes: bytes(g.vg_size) - bytes(g.vg_free),
      pvCount: Number(g.pv_count) || 0,
      lvCount: Number(g.lv_count) || 0,
    }));
    const logicalVolumes = rows(lvs.stdout, "lv").map((l) => ({
      name: l.lv_name,
      vg: l.vg_name,
      sizeBytes: bytes(l.lv_size),
      device: l.lv_path || mapperPath(l.vg_name, l.lv_name),
    }));
    return {
      available: volumeGroups.length > 0,
      source: "lvm",
      volumeGroups,
      logicalVolumes,
    };
  }
  async filesystem(device) {
    try {
      const result = await this.run([
        "/usr/bin/findmnt",
        "-n",
        "-o",
        "FSTYPE,TARGET",
        "-S",
        device,
      ]);
      const [fstype, ...rest] = result.stdout.trim().split(/\s+/);
      return fstype
        ? { fstype, target: rest.join(" ") || null }
        : { fstype: null, target: null };
    } catch {
      return { fstype: null, target: null };
    }
  }
  async extend({ vg, lv, sizeGiB }) {
    if (!lvmName.test(vg) || !lvmName.test(lv))
      throw new InputError("Invalid volume name.");
    if (!Number.isInteger(sizeGiB) || sizeGiB < 1 || sizeGiB > 65536)
      throw new InputError("sizeGiB must be a whole number of GiB from 1 to 65536.");
    const current = await this.list();
    const group = current.volumeGroups.find((item) => item.name === vg);
    const volume = current.logicalVolumes.find(
      (item) => item.vg === vg && item.name === lv,
    );
    if (!group || !volume) throw new InputError("Logical volume not found.");
    const target = sizeGiB * GiB;
    if (target < volume.sizeBytes)
      throw new InputError(
        `New size must be larger than the current logical volume (${Math.round(volume.sizeBytes / GiB)} GiB).`,
      );
    if (target > volume.sizeBytes + group.freeBytes)
      throw new InputError("Not enough unallocated space in the volume group.");
    if (target > volume.sizeBytes)
      await this.run(
        ["/usr/sbin/lvextend", "-L", `${sizeGiB}g`, `${vg}/${lv}`],
        { timeout: 60000 },
      );
    const fs = await this.filesystem(volume.device);
    if (fs.fstype === "ext4" || fs.fstype === "ext3" || fs.fstype === "ext2")
      await this.run(["/usr/sbin/resize2fs", volume.device], { timeout: 120000 });
    else if (fs.fstype === "xfs" && fs.target)
      await this.run(["/usr/sbin/xfs_growfs", fs.target], { timeout: 120000 });
    else
      throw new InputError(
        fs.fstype
          ? `Cannot grow filesystem type ${fs.fstype} from Wardroom; grow it on the host after lvextend.`
          : "Logical volume size is set but no mounted ext or xfs filesystem was found; grow the filesystem on the host before retrying.",
      );
    return {
      vg,
      lv,
      sizeGiB,
      device: volume.device,
      filesystem: fs.fstype,
      grown: true,
    };
  }
  async runAction(action, args) {
    if (action === "list") return this.list();
    if (action === "extend") return this.extend(args);
    throw new InputError("Unknown host storage action.");
  }
}

export function createHostBroker({
  secret,
  control = new HostControl(),
} = {}) {
  if (!secret || secret.length < 32)
    throw Error("AGENT_BROKER_SECRET must contain at least 32 characters.");
  const schema = z
    .object({
      action: z.enum(["list", "extend"]),
      vg: z.string().regex(lvmName).optional(),
      lv: z.string().regex(lvmName).optional(),
      sizeGiB: z.number().int().min(1).max(65536).optional(),
    })
    .strict();
  return http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/healthz" && req.method === "GET")
      return reply(200, { status: "ok" });
    if (req.url !== "/control" || req.method !== "POST")
      return reply(404, { error: "Not found." });
    if (
      !timingSafeEqual(
        hash(req.headers.authorization || ""),
        hash(`Bearer ${secret}`),
      )
    )
      return reply(401, { error: "Unauthorized." });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 2048)
          return reply(413, { error: "Request too large." });
      }
      const parsed = schema.safeParse(JSON.parse(body));
      if (!parsed.success)
        return reply(400, { error: "Invalid host storage request." });
      reply(200, await control.runAction(parsed.data.action, parsed.data));
    } catch (error) {
      if (error instanceof InputError)
        return reply(error.status || 409, { error: error.message });
      reply(409, {
        error:
          "Host storage operation failed; inspect the volume before retrying.",
      });
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createHostBroker({
    secret: process.env.AGENT_BROKER_SECRET,
  });
  server.requestTimeout = 130000;
  server.headersTimeout = 10000;
  server.listen(8792, "0.0.0.0");
}
