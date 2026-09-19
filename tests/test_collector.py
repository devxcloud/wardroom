import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("collector", Path(__file__).parent.parent / "telemetry/collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTests(unittest.TestCase):
    def test_cpu_does_not_double_count_guest_or_iowait(self):
        current = collector.cpu_counters("cpu 20 0 10 60 10 0 0 0 9 0\ncpu0 20 0 10 60 10 0 0 0 9 0")
        usage = collector.cpu_usage(current["cpu"], [0] * 8)
        self.assertEqual(usage["percent"], 30)
        self.assertEqual(usage["iowaitPercent"], 10)
        self.assertIsNone(collector.cpu_usage(current["cpu"], None)["percent"])

    def test_counter_reset_and_first_sample_are_gaps(self):
        self.assertEqual(collector.rate(200, 100, 10), 10)
        self.assertIsNone(collector.rate(100, 200, 10))
        self.assertIsNone(collector.rate(200, None, 10))
        self.assertIsNone(collector.rate(200, 100, 0))

    def test_memory_uses_available_not_free(self):
        m = collector.memory_info("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 750 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB")
        self.assertEqual(m["usedPercent"], 25)
        self.assertEqual(m["usedBytes"], 250 * 1024)
        self.assertEqual(m["swapUsedBytes"], 50 * 1024)

    def test_disk_accounting_excludes_partitions_and_lvm(self):
        text = "259 0 nvme0n1 1 0 20 0 2 0 30 0 0 40 0\n253 0 dm-0 1 0 20 0 2 0 30 0 0 40 0\n259 1 nvme0n1p1 1 0 20 0 2 0 30 0 0 40 0"
        d = collector.disk_counters(text, {"nvme0n1"})
        self.assertEqual(list(d), ["nvme0n1"])
        self.assertEqual(d["nvme0n1"]["readBytes"], 20 * 512)
        self.assertEqual(d["nvme0n1"]["writeBytes"], 30 * 512)
        self.assertEqual(d["nvme0n1"]["busyMs"], 40)

    def test_network_keeps_tailnet_separate_and_filters_docker(self):
        row = "100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0"
        n = collector.network_counters("\n".join(f"{name}: {row}" for name in ["lo", "docker0", "veth123", "br-abc", "wlan0", "tailscale0"]))
        self.assertEqual(set(n), {"wlan0", "tailscale0"})
        self.assertEqual(n["wlan0"]["txBytes"], 200)
        routes = "Iface Destination Gateway Flags RefCnt Use Metric Mask\nwlan0 00000000 0 0003 0 0 600 0\neth0 00000000 0 0003 0 0 100 0"
        self.assertEqual(collector.primary_interface(routes), "eth0")

    def test_docker_units(self):
        self.assertEqual(collector.size_bytes("1.5MiB"), 1572864)
        self.assertEqual(collector.size_bytes("2MB"), 2000000)
        self.assertEqual(collector.size_bytes("0B"), 0)
        self.assertIsNone(collector.size_bytes("N/A"))
        self.assertEqual(collector.pair("1KiB / 2GiB"), [1024, 2147483648])


if __name__ == "__main__":
    unittest.main()
