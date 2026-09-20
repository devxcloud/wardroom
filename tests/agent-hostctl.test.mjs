import { test } from "node:test";
import assert from "node:assert/strict";
import { HostControl, mapperPath } from "../dashboard/agent/hostctl.mjs";

const vgs = JSON.stringify({
  report: [
    {
      vg: [
        {
          vg_name: "ubuntu-vg",
          vg_size: String(950 * 1024 ** 3),
          vg_free: String(850 * 1024 ** 3),
          pv_count: "1",
          lv_count: "1",
        },
      ],
    },
  ],
});
const lvs = JSON.stringify({
  report: [
    {
      lv: [
        {
          lv_name: "ubuntu-lv",
          vg_name: "ubuntu-vg",
          lv_size: String(100 * 1024 ** 3),
          lv_path: "/dev/ubuntu-vg/ubuntu-lv",
        },
      ],
    },
  ],
});

test("LVM extend grows then resizes ext4 and refuses shrink or overcommit", async () => {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    if (argv[0].endsWith("vgs")) return { stdout: vgs };
    if (argv[0].endsWith("lvs")) return { stdout: lvs };
    if (argv[0].endsWith("findmnt")) return { stdout: "ext4 /\n" };
    return { stdout: "" };
  };
  const host = new HostControl({ run });
  assert.equal(mapperPath("ubuntu-vg", "ubuntu-lv"), "/dev/mapper/ubuntu--vg-ubuntu--lv");
  await assert.rejects(
    host.extend({ vg: "ubuntu-vg", lv: "ubuntu-lv", sizeGiB: 50 }),
    /larger/,
  );
  await assert.rejects(
    host.extend({ vg: "ubuntu-vg", lv: "ubuntu-lv", sizeGiB: 2000 }),
    /unallocated/,
  );
  const result = await host.extend({
    vg: "ubuntu-vg",
    lv: "ubuntu-lv",
    sizeGiB: 200,
  });
  assert.equal(result.grown, true);
  assert.equal(result.filesystem, "ext4");
  assert.ok(
    calls.some(
      (argv) =>
        argv[0] === "/usr/sbin/lvextend" &&
        argv.includes("200g") &&
        argv.includes("ubuntu-vg/ubuntu-lv"),
    ),
  );
  assert.ok(calls.some((argv) => argv[0] === "/usr/sbin/resize2fs"));
  assert.ok(!calls.some((argv) => argv.some((a) => String(a).includes(";"))));
});
