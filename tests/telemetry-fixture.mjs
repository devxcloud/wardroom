export function sample(now = Date.now()) {
  return {
    collectedAt: new Date(now).toISOString(),
    host: {
      hostname: "devbox",
      kernel: "Linux",
      os: "Ubuntu",
      cpuModel: "Test CPU",
      cores: 4,
      bootId: "boot-test",
      uptimeSeconds: 3600,
    },
    cpu: {
      percent: 12,
      iowaitPercent: 2,
      load: [0.1, 0.2, 0.3],
      cores: [{ name: "cpu0", percent: 12 }],
    },
    memory: {
      totalBytes: 1000,
      usedBytes: 400,
      availableBytes: 600,
      usedPercent: 40,
      swapTotalBytes: 100,
      swapUsedBytes: 0,
    },
    storage: [
      {
        mount: "/",
        device: "/dev/test",
        fs: "ext4",
        totalBytes: 10000,
        usedBytes: 6000,
        availableBytes: 3500,
        reservedBytes: 500,
        usedPercent: 60,
      },
    ],
    network: {
      primary: "eth0",
      rxBytesPerSecond: 100,
      txBytesPerSecond: 200,
      interfaces: [
        {
          name: "eth0",
          rxBytes: 1000,
          txBytes: 2000,
          rxBytesPerSecond: 100,
          txBytesPerSecond: 200,
        },
      ],
    },
    io: {
      readBytesPerSecond: 10,
      writeBytesPerSecond: 20,
      devices: [
        {
          name: "nvme0n1",
          readBytesPerSecond: 10,
          writeBytesPerSecond: 20,
          busyPercent: 1,
        },
      ],
    },
    docker: {
      available: true,
      statsAvailable: true,
      truncated: false,
      items: [
        {
          id: "abc123",
          name: "postgres",
          image: "postgres:18",
          state: "running",
          status: "Up 1 hour (healthy)",
          ports: "5434->5432",
          cpuPercent: 1,
          memoryBytes: 100,
          memoryLimitBytes: 500,
          networkRxBytes: 1000,
          networkTxBytes: 2000,
          readBytes: 100,
          writeBytes: 200,
          pids: 5,
        },
      ],
    },
  };
}
