#!/usr/bin/env python3
"""Fixed, read-only host measurements. No HTTP listener or remote command API."""

import argparse
import concurrent.futures
import datetime
import json
import os
import platform
import re
import subprocess
import time
import urllib.request
from pathlib import Path


def read(path):
    return Path(path).read_text()


def rate(current, previous, elapsed):
    if previous is None or elapsed <= 0 or current < previous:
        return None
    return (current - previous) / elapsed


def cpu_counters(text):
    # guest/guest_nice already contribute to user/nice, so omit fields 9+.
    return {p[0]: list(map(int, p[1:9])) for line in text.splitlines()
            if (p := line.split()) and re.fullmatch(r"cpu\d*", p[0])}


def cpu_usage(current, previous):
    if previous is None:
        return {"percent": None, "iowaitPercent": None}
    delta = [a - b for a, b in zip(current, previous)]
    total = sum(delta)
    if total <= 0 or any(n < 0 for n in delta):
        return {"percent": None, "iowaitPercent": None}
    return {"percent": max(0, min(100, 100 * (total - delta[3] - delta[4]) / total)),
            "iowaitPercent": 100 * delta[4] / total}


def memory_info(text):
    values = {p[0].rstrip(":"): int(p[1]) * 1024 for line in text.splitlines()
              if (p := line.split()) and len(p) > 1}
    total = values["MemTotal"]
    available = min(total, values["MemAvailable"])
    return {"totalBytes": total, "availableBytes": available,
            "usedBytes": total - available, "usedPercent": 100 * (total - available) / total,
            "swapTotalBytes": values.get("SwapTotal", 0),
            "swapUsedBytes": values.get("SwapTotal", 0) - values.get("SwapFree", 0)}


def network_counters(text):
    result = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        name, data = line.split(":", 1)
        name, values = name.strip(), data.split()
        if name == "lo" or name.startswith(("veth", "br-", "docker", "virbr")):
            continue
        result[name] = {"rxBytes": int(values[0]), "txBytes": int(values[8])}
    return result


def primary_interface(routes):
    entries = [p for line in routes.splitlines()[1:]
               if len(p := line.split()) >= 8 and p[1] == "00000000" and int(p[3], 16) & 1]
    return min(entries, key=lambda p: int(p[6]))[0] if entries else None


def disk_counters(text, devices):
    result = {}
    for line in text.splitlines():
        p = line.split()
        if len(p) < 14 or p[2] not in devices:
            continue
        # Kernel diskstats sectors are always 512 bytes, including on NVMe.
        result[p[2]] = {"readBytes": int(p[5]) * 512,
                        "writeBytes": int(p[9]) * 512, "busyMs": int(p[12])}
    return result


def filesystem_info():
    result, seen = [], set()
    for line in read("/proc/self/mountinfo").splitlines():
        left, right = line.split(" - ", 1)
        fields, kind = left.split(), right.split()
        if kind[0] not in {"ext4", "ext3", "ext2", "xfs", "btrfs", "zfs", "vfat", "ntfs3"}:
            continue
        device_id = fields[2]
        if device_id in seen:
            continue
        mount = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[4])
        try:
            s = os.statvfs(mount)
        except OSError:
            continue
        total, free, available = s.f_blocks * s.f_frsize, s.f_bfree * s.f_frsize, s.f_bavail * s.f_frsize
        if not total:
            continue
        seen.add(device_id)
        result.append({"mount": mount, "device": kind[1], "fs": kind[0],
                       "totalBytes": total, "usedBytes": total - free, "availableBytes": available,
                       "reservedBytes": free - available, "usedPercent": 100 * (total - free) / total})
    return sorted(result, key=lambda x: (x["mount"] != "/", x["mount"]))[:32]


def size_bytes(value):
    match = re.fullmatch(r"\s*([\d.]+)\s*([kKMGTPE]?i?B)\s*", value)
    if not match:
        return None
    unit = match[2].upper()
    power = "BKMGTPE".index(unit[0])
    return round(float(match[1]) * (1024 if "I" in unit else 1000) ** power)


def pair(value):
    parts = value.split(" / ")
    return [size_bytes(p) for p in parts] if len(parts) == 2 else [None, None]


def docker_command(args):
    # Never take arguments from telemetry consumers; never collect env/command/secrets.
    env = {**os.environ, "DOCKER_HOST": "unix:///var/run/docker.sock"}
    env.pop("DOCKER_CONTEXT", None)
    output = subprocess.run(["/usr/bin/docker", *args], capture_output=True,
                            text=True, check=True, timeout=15, env=env)
    return [json.loads(line) for line in output.stdout.splitlines() if line]


def containers():
    template = '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}},"ports":{{json .Ports}}}'
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        listing = executor.submit(docker_command, ["ps", "--all", "--no-trunc", "--format", template])
        stats_job = executor.submit(docker_command, ["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"])
        try:
            items = listing.result()
        except (OSError, subprocess.SubprocessError, ValueError):
            return {"available": False, "statsAvailable": False, "items": [], "truncated": False}
        try:
            stats = {item["ID"]: item for item in stats_job.result()}
            stats_available = True
        except (OSError, subprocess.SubprocessError, ValueError):
            stats, stats_available = {}, False
    for item in items:
        values = stats.get(item["id"])
        item.update({"cpuPercent": None, "memoryBytes": None, "memoryLimitBytes": None,
                     "networkRxBytes": None, "networkTxBytes": None,
                     "readBytes": None, "writeBytes": None, "pids": None})
        if values:
            item["cpuPercent"] = float(values["CPUPerc"].rstrip("%"))
            item["memoryBytes"], item["memoryLimitBytes"] = pair(values["MemUsage"])
            item["networkRxBytes"], item["networkTxBytes"] = pair(values["NetIO"])
            item["readBytes"], item["writeBytes"] = pair(values["BlockIO"])
            item["pids"] = int(values["PIDs"]) if values["PIDs"].isdigit() else None
    # Prefer running containers if inventory ever exceeds the payload bound.
    items.sort(key=lambda c: (c["state"] != "running", c["name"]))
    return {"available": True, "statsAvailable": stats_available, "items": items[:128], "truncated": len(items) > 128}


class Collector:
    def __init__(self):
        self.previous = None
        self.devices = {p.name for p in Path("/sys/block").iterdir()
                        if not p.name.startswith(("loop", "dm-", "ram", "zram", "md"))}
        cpuinfo = read("/proc/cpuinfo")
        self.model = next((line.split(":", 1)[1].strip() for line in cpuinfo.splitlines()
                           if line.startswith("model name")), platform.machine())

    def sample(self):
        now = time.monotonic()
        cpu = cpu_counters(read("/proc/stat"))
        net = network_counters(read("/proc/net/dev"))
        disks = disk_counters(read("/proc/diskstats"), self.devices)
        boot = read("/proc/sys/kernel/random/boot_id").strip()
        prev = self.previous if self.previous and self.previous["boot"] == boot else None
        elapsed = now - prev["time"] if prev else 0
        old = prev or {"cpu": {}, "net": {}, "disks": {}}
        interfaces = []
        for name, values in net.items():
            before = old["net"].get(name, {})
            interfaces.append({"name": name, **values,
                               "rxBytesPerSecond": rate(values["rxBytes"], before.get("rxBytes"), elapsed),
                               "txBytesPerSecond": rate(values["txBytes"], before.get("txBytes"), elapsed)})
        disk_values = []
        for name, values in disks.items():
            before = old["disks"].get(name, {})
            busy = rate(values["busyMs"], before.get("busyMs"), elapsed)
            disk_values.append({"name": name,
                                "readBytesPerSecond": rate(values["readBytes"], before.get("readBytes"), elapsed),
                                "writeBytesPerSecond": rate(values["writeBytes"], before.get("writeBytes"), elapsed),
                                "busyPercent": min(100, busy / 10) if busy is not None else None})
        primary = primary_interface(read("/proc/net/route"))
        primary_data = next((i for i in interfaces if i["name"] == primary), {})
        def total(key):
            values = [d[key] for d in disk_values]
            return sum(values) if values and all(v is not None for v in values) else None
        result = {
            "collectedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "host": {"hostname": platform.node(), "kernel": platform.release(), "os": platform.freedesktop_os_release().get("PRETTY_NAME", "Linux"),
                     "cpuModel": self.model, "cores": len(cpu) - 1, "bootId": boot,
                     "uptimeSeconds": float(read("/proc/uptime").split()[0])},
            "cpu": {**cpu_usage(cpu["cpu"], old["cpu"].get("cpu")),
                    "load": list(map(float, read("/proc/loadavg").split()[:3])),
                    "cores": [{"name": name, "percent": cpu_usage(values, old["cpu"].get(name))["percent"]}
                              for name, values in cpu.items() if name != "cpu"]},
            "memory": memory_info(read("/proc/meminfo")),
            "storage": filesystem_info(),
            "network": {"primary": primary, "rxBytesPerSecond": primary_data.get("rxBytesPerSecond"),
                        "txBytesPerSecond": primary_data.get("txBytesPerSecond"), "interfaces": interfaces[:32]},
            "io": {"readBytesPerSecond": total("readBytesPerSecond"), "writeBytesPerSecond": total("writeBytesPerSecond"), "devices": disk_values[:32]},
            "docker": containers(),
        }
        self.previous = {"time": now, "boot": boot, "cpu": cpu, "net": net, "disks": disks}
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(read(args.config))
    if not config.get("token") or len(config["token"]) < 32:
        raise SystemExit("A telemetry token of at least 32 characters is required")
    collector = Collector()
    interval = max(5, int(config.get("interval", 10)))
    while True:
        start = time.monotonic()
        try:
            payload = json.dumps(collector.sample(), allow_nan=False).encode()
            request = urllib.request.Request(config["url"], data=payload, method="POST",
                                             headers={"Content-Type": "application/json", "Authorization": "Bearer " + config["token"]})
            # Do not forward the ingestion token through redirects/proxies.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    return None
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(request, timeout=8) as response:
                if response.status != 202:
                    raise RuntimeError("Ingestion not accepted")
        except Exception as error:
            # Exceptions/URLs can contain credentials. Log only the error class.
            print("Telemetry sample failed: " + type(error).__name__, flush=True)
        time.sleep(max(1, interval - (time.monotonic() - start)))


if __name__ == "__main__":
    main()
