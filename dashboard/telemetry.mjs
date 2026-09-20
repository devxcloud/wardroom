import { InputError } from "./domain.mjs";

const invalid = () => {
  throw new InputError("Invalid telemetry payload.");
};
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : invalid();
const text = (value, limit = 160) =>
  typeof value === "string" && value.length <= limit ? value : invalid();
const number = (value, max = Number.MAX_SAFE_INTEGER, nullable = false) =>
  value === null && nullable
    ? null
    : typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= max
      ? value
      : invalid();
const list = (value, max, mapper) =>
  Array.isArray(value) && value.length <= max ? value.map(mapper) : invalid();
const bool = (value) => (typeof value === "boolean" ? value : invalid());
const metric = (value) => number(value, Number.MAX_SAFE_INTEGER, true);

function normalizeSample(value, now) {
  const data = record(value),
    host = record(data.host),
    cpu = record(data.cpu),
    mem = record(data.memory);
  const network = record(data.network),
    io = record(data.io),
    docker = record(data.docker);
  const at = Date.parse(data.collectedAt);
  if (!Number.isFinite(at) || at > now + 10_000 || at < now - 120_000)
    invalid();
  const volume = (v) => ({
    mount: text(v.mount, 512),
    device: text(v.device, 256),
    fs: text(v.fs, 32),
    totalBytes: number(v.totalBytes),
    usedBytes: number(v.usedBytes),
    availableBytes: number(v.availableBytes),
    reservedBytes: number(v.reservedBytes),
    usedPercent: number(v.usedPercent, 100),
  });
  const emptyLvm = {
    available: false,
    source: "none",
    volumeGroups: [],
    physicalVolumes: [],
    logicalVolumes: [],
  };
  const parseLvm = (value) => {
    if (value == null) return emptyLvm;
    const raw = record(value);
    return {
      available: bool(raw.available),
      source: text(raw.source, 16),
      volumeGroups: list(raw.volumeGroups, 16, (g) => ({
        name: text(g.name, 128),
        sizeBytes: number(g.sizeBytes),
        freeBytes: number(g.freeBytes),
        allocatedBytes: number(g.allocatedBytes),
        pvCount: number(g.pvCount, 256),
        lvCount: number(g.lvCount, 256),
      })),
      physicalVolumes: list(raw.physicalVolumes, 32, (p) => ({
        name: text(p.name, 128),
        vg: text(p.vg, 128),
        sizeBytes: number(p.sizeBytes),
      })),
      logicalVolumes: list(raw.logicalVolumes, 32, (l) => ({
        name: text(l.name, 128),
        vg: text(l.vg, 128),
        sizeBytes: number(l.sizeBytes),
        device: text(l.device, 256),
      })),
    };
  };
  const result = {
    collectedAt: new Date(at).toISOString(),
    host: {
      hostname: text(host.hostname),
      kernel: text(host.kernel),
      os: text(host.os),
      cpuModel: text(host.cpuModel, 256),
      cores: number(host.cores, 512),
      bootId: text(host.bootId, 64),
      uptimeSeconds: number(host.uptimeSeconds),
    },
    cpu: {
      percent: number(cpu.percent, 100, true),
      iowaitPercent: number(cpu.iowaitPercent, 100, true),
      load: list(cpu.load, 3, (v) => number(v)),
      cores: list(cpu.cores, 512, (c) => ({
        name: text(c.name, 16),
        percent: number(c.percent, 100, true),
      })),
    },
    memory: {
      totalBytes: number(mem.totalBytes),
      usedBytes: number(mem.usedBytes),
      availableBytes: number(mem.availableBytes),
      usedPercent: number(mem.usedPercent, 100),
      swapTotalBytes: number(mem.swapTotalBytes),
      swapUsedBytes: number(mem.swapUsedBytes),
    },
    storage: list(data.storage, 32, (v) => volume(record(v))),
    lvm: parseLvm(data.lvm),
    network: {
      primary: network.primary === null ? null : text(network.primary, 64),
      rxBytesPerSecond: metric(network.rxBytesPerSecond),
      txBytesPerSecond: metric(network.txBytesPerSecond),
      interfaces: list(network.interfaces, 32, (i) => ({
        name: text(i.name, 64),
        rxBytes: number(i.rxBytes),
        txBytes: number(i.txBytes),
        rxBytesPerSecond: metric(i.rxBytesPerSecond),
        txBytesPerSecond: metric(i.txBytesPerSecond),
      })),
    },
    io: {
      readBytesPerSecond: metric(io.readBytesPerSecond),
      writeBytesPerSecond: metric(io.writeBytesPerSecond),
      devices: list(io.devices, 32, (d) => ({
        name: text(d.name, 64),
        readBytesPerSecond: metric(d.readBytesPerSecond),
        writeBytesPerSecond: metric(d.writeBytesPerSecond),
        busyPercent: number(d.busyPercent, 100, true),
      })),
    },
    docker: {
      available: bool(docker.available),
      statsAvailable: bool(docker.statsAvailable),
      truncated: bool(docker.truncated),
      items: list(docker.items, 128, (c) => ({
        id: text(c.id, 64),
        name: text(c.name, 256),
        image: text(c.image, 512),
        state: text(c.state, 32),
        status: text(c.status, 256),
        ports: text(c.ports, 2048),
        cpuPercent: number(c.cpuPercent, 51200, true),
        memoryBytes: metric(c.memoryBytes),
        memoryLimitBytes: metric(c.memoryLimitBytes),
        networkRxBytes: metric(c.networkRxBytes),
        networkTxBytes: metric(c.networkTxBytes),
        readBytes: metric(c.readBytes),
        writeBytes: metric(c.writeBytes),
        pids: number(c.pids, 1000000, true),
      })),
    },
  };
  if (
    !result.host.cores ||
    !result.memory.totalBytes ||
    result.memory.usedBytes > result.memory.totalBytes ||
    result.memory.availableBytes > result.memory.totalBytes
  )
    invalid();
  return result;
}

export function validateSample(value, now = Date.now()) {
  try {
    return normalizeSample(value, now);
  } catch {
    throw new InputError("Invalid telemetry payload.");
  }
}

export function summary(sample) {
  const root = sample.storage.find((v) => v.mount === "/");
  return {
    cpu: sample.cpu.percent,
    memory: sample.memory.usedPercent,
    storage: root?.usedPercent ?? null,
    diskRead: sample.io.readBytesPerSecond,
    diskWrite: sample.io.writeBytesPerSecond,
    networkRx: sample.network.rxBytesPerSecond,
    networkTx: sample.network.txBytesPerSecond,
  };
}

export const ranges = {
  "15m": { seconds: 900, step: 10 },
  "1h": { seconds: 3600, step: 30 },
  "24h": { seconds: 86400, step: 120 },
};

export class TelemetryStore {
  constructor(pool) {
    this.pool = pool;
  }
  async initialize() {
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS shared_infra.telemetry_latest (
      id integer PRIMARY KEY CHECK(id=1),collected_at timestamptz NOT NULL,received_at timestamptz NOT NULL,data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_infra.telemetry_history (
      collected_at timestamptz PRIMARY KEY,metrics jsonb NOT NULL);`);
  }
  async ingest(input) {
    const sample = validateSample(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `INSERT INTO shared_infra.telemetry_latest(id,collected_at,received_at,data)
        VALUES (1,$1,now(),$2) ON CONFLICT(id) DO UPDATE SET collected_at=EXCLUDED.collected_at,received_at=EXCLUDED.received_at,data=EXCLUDED.data
        WHERE shared_infra.telemetry_latest.collected_at<EXCLUDED.collected_at
        AND shared_infra.telemetry_latest.received_at<now()-interval '4 seconds' RETURNING id`,
        [sample.collectedAt, sample],
      );
      if (!updated.rowCount)
        throw new InputError(
          "Telemetry sample is older than the latest sample or arrived too quickly.",
          409,
        );
      await client.query(
        "INSERT INTO shared_infra.telemetry_history(collected_at,metrics) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [sample.collectedAt, summary(sample)],
      );
      await client.query(
        "DELETE FROM shared_infra.telemetry_history WHERE collected_at<now()-interval '24 hours'",
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async read(range = "15m") {
    if (!Object.hasOwn(ranges, range))
      throw new InputError("Choose 15m, 1h, or 24h.");
    const { seconds, step } = ranges[range];
    const [latest, history] = await Promise.all([
      this.pool.query(
        "SELECT data,received_at FROM shared_infra.telemetry_latest WHERE id=1",
      ),
      this.pool.query(
        `SELECT floor(extract(epoch FROM collected_at)/$1)*$1 AS time,
        avg((metrics->>'cpu')::float8) AS cpu,avg((metrics->>'memory')::float8) AS memory,
        avg((metrics->>'storage')::float8) AS storage,avg((metrics->>'diskRead')::float8) AS "diskRead",
        avg((metrics->>'diskWrite')::float8) AS "diskWrite",avg((metrics->>'networkRx')::float8) AS "networkRx",
        avg((metrics->>'networkTx')::float8) AS "networkTx"
        FROM shared_infra.telemetry_history WHERE collected_at>=now()-($2 * interval '1 second')
        GROUP BY 1 ORDER BY 1 LIMIT 721`,
        [step, seconds],
      ),
    ]);
    const current = latest.rows[0];
    return {
      sample: current?.data ?? null,
      receivedAt: current?.received_at ?? null,
      stale:
        !current ||
        Date.now() - new Date(current.received_at).getTime() > 35000,
      intervalSeconds: 10,
      range,
      stepSeconds: step,
      windowSeconds: seconds,
      history: history.rows.map((row) => ({
        ...row,
        time: Number(row.time) * 1000,
      })),
      serverTime: new Date().toISOString(),
    };
  }
}
