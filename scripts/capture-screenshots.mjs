import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { sample } from "../tests/telemetry-fixture.mjs";

const baseURL = process.env.DASHBOARD_URL || "http://devbox";
const capturedAt = Date.now();
const overview = {
  host: "devbox.internal",
  checkedAt: new Date(capturedAt).toISOString(),
  services: [
    { id: "postgres", status: "healthy", duration: 8, version: "18.0" },
    { id: "redis", status: "healthy", duration: 3, version: "8.0" },
    { id: "minio", status: "healthy", duration: 11, version: "2025" },
    { id: "mailpit", status: "healthy", duration: 4, version: "1.27" },
  ],
  projects: [
    { name: "atlas", description: "Search and discovery", status: "ready" },
    { name: "lumen", description: "Realtime collaboration", status: "ready" },
    { name: "orbit", description: "Developer platform", status: "ready" },
  ],
  events: [
    {
      project: "orbit",
      message: "Project provisioned",
      created_at: "2026-09-19T15:24:00Z",
    },
    {
      project: "lumen",
      message: "Project provisioned",
      created_at: "2026-09-19T14:48:00Z",
    },
  ],
};

function systemFixture() {
  const current = sample(capturedAt);
  current.host = {
    ...current.host,
    hostname: "devbox",
    cpuModel: "Intel Core i7-12700H",
    cores: 8,
    uptimeSeconds: 345620,
  };
  current.cpu = {
    ...current.cpu,
    percent: 23.7,
    iowaitPercent: 0.8,
    load: [1.2, 1.05, 0.91],
    cores: Array.from({ length: 8 }, (_, i) => ({
      name: `cpu${i}`,
      percent: 12 + ((i * 11) % 34),
    })),
  };
  current.memory = {
    totalBytes: 32 * 1024 ** 3,
    usedBytes: 13.7 * 1024 ** 3,
    availableBytes: 18.3 * 1024 ** 3,
    usedPercent: 42.8,
    swapTotalBytes: 8 * 1024 ** 3,
    swapUsedBytes: 0.4 * 1024 ** 3,
  };
  current.storage = [
    {
      mount: "/",
      device: "/dev/nvme0n1p2",
      fs: "ext4",
      totalBytes: 953 * 1024 ** 3,
      usedBytes: 347 * 1024 ** 3,
      availableBytes: 558 * 1024 ** 3,
      reservedBytes: 48 * 1024 ** 3,
      usedPercent: 36.4,
    },
  ];
  current.network = {
    primary: "eth0",
    rxBytesPerSecond: 2.4 * 1024 ** 2,
    txBytesPerSecond: 0.8 * 1024 ** 2,
    interfaces: [
      {
        name: "eth0",
        rxBytes: 813 * 1024 ** 3,
        txBytes: 247 * 1024 ** 3,
        rxBytesPerSecond: 2.4 * 1024 ** 2,
        txBytesPerSecond: 0.8 * 1024 ** 2,
      },
      {
        name: "tailscale0",
        rxBytes: 92 * 1024 ** 3,
        txBytes: 61 * 1024 ** 3,
        rxBytesPerSecond: 0.6 * 1024 ** 2,
        txBytesPerSecond: 0.3 * 1024 ** 2,
      },
    ],
  };
  current.io = {
    readBytesPerSecond: 4.2 * 1024 ** 2,
    writeBytesPerSecond: 1.7 * 1024 ** 2,
    devices: [],
  };
  current.docker.items = [
    "postgres",
    "redis",
    "minio",
    "dashboard",
    "gateway",
    "jaeger",
    "dozzle",
    "redisinsight",
  ].map((name, i) => ({
    id: `demo${i}`,
    name: `shared-infra-${name}`,
    image: `${name}:pinned`,
    state: "running",
    status: "Up 4 days (healthy)",
    ports: "private",
    cpuPercent: 0.4 + i * 0.23,
    memoryBytes: (82 + i * 27) * 1024 ** 2,
    memoryLimitBytes: 512 * 1024 ** 2,
    networkRxBytes: (12 + i * 4) * 1024 ** 2,
    networkTxBytes: (8 + i * 3) * 1024 ** 2,
    readBytes: (20 + i * 6) * 1024 ** 2,
    writeBytes: (9 + i * 2) * 1024 ** 2,
    pids: 5 + i,
  }));
  const history = Array.from({ length: 31 }, (_, i) => ({
    time: capturedAt - (30 - i) * 30000,
    cpu: 18 + Math.sin(i / 3) * 9 + (i % 7),
    memory: 40 + i * 0.09,
    diskRead: (2.2 + Math.sin(i / 2) * 1.3) * 1024 ** 2,
    diskWrite: (1.1 + Math.cos(i / 3) * 0.7) * 1024 ** 2,
    networkRx: (1.8 + Math.sin(i / 4) * 0.9) * 1024 ** 2,
    networkTx: (0.7 + Math.cos(i / 5) * 0.35) * 1024 ** 2,
  }));
  return {
    range: "15m",
    sample: current,
    receivedAt: new Date(capturedAt).toISOString(),
    stale: false,
    stepSeconds: 30,
    windowSeconds: 900,
    history,
    serverTime: new Date(capturedAt).toISOString(),
  };
}

const tools = {
  tools: [
    { id: "api", status: "healthy", detail: "API workbench is ready." },
    { id: "logs", status: "healthy", detail: "Container logs are ready." },
    { id: "redis", status: "healthy", detail: "Redis workspace is ready." },
    { id: "traces", status: "healthy", detail: "Trace explorer is ready." },
  ],
  lab: { active: true, wiremock: "healthy", toxiproxy: "healthy" },
  connections: {
    otlpGrpc: "devbox.internal:4317",
    otlpHttp: "http://devbox.internal:4318",
    postgresProxy: "devbox.internal:15434",
    redisProxy: "devbox.internal:16379",
    minioProxy: "http://devbox.internal:19100",
  },
};

async function prepare(page) {
  await page.route("**/api/overview", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(overview),
    }),
  );
  await page.route("**/api/system*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(systemFixture()),
    }),
  );
  await page.route("**/api/tools", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(tools),
    }),
  );
}

await mkdir(new URL("../docs/images/", import.meta.url), { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    timezoneId: "UTC",
    colorScheme: "light",
  });
  const page = await context.newPage();
  await prepare(page);
  await page.goto(baseURL);
  await page.getByRole("heading", { name: "Your infrastructure" }).waitFor();
  await page.screenshot({
    path: "docs/images/control-room-overview.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.locator(".resource-gauge").first().waitFor();
  await page.screenshot({
    path: "docs/images/system-monitoring.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page
    .getByRole("heading", { name: "Your developer cockpit." })
    .waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({
    path: "docs/images/developer-tools.png",
    fullPage: true,
  });
  await context.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "UTC",
    colorScheme: "light",
    deviceScaleFactor: 1,
  });
  const mobilePage = await mobile.newPage();
  await prepare(mobilePage);
  await mobilePage.goto(baseURL);
  await mobilePage
    .getByRole("heading", { name: "Your infrastructure" })
    .waitFor();
  await mobilePage.screenshot({
    path: "docs/images/mobile-control-room.png",
    fullPage: true,
  });
  await mobile.close();
} finally {
  await browser.close();
}
console.log("Wrote four sanitized dashboard screenshots to docs/images/.");
