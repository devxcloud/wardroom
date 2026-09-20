import { test } from "node:test";
import assert from "node:assert/strict";
import { DockerControl } from "../dashboard/agent/broker.mjs";

test("broker permits host container and volume operations and protects the control plane", async () => {
  const redis = "a".repeat(64);
  const gateway = "b".repeat(64);
  const extra = "c".repeat(64);
  const hostBroker = "d".repeat(64);
  let project = "shared-infra";
  const calls = [];
  const request = async (method, path, _limit, body) => {
    calls.push([method, path, body]);
    if (path.startsWith("/containers/json"))
      return [
        {
          Id: redis,
          Names: ["/shared-infra-redis-1"],
          State: "running",
          Status: "Up",
          Labels: {
            "com.docker.compose.project": project,
            "com.docker.compose.service": "redis",
          },
        },
        {
          Id: gateway,
          Names: ["/shared-infra-gateway-1"],
          State: "running",
          Status: "Up",
          Labels: {
            "com.docker.compose.project": "shared-infra",
            "com.docker.compose.service": "gateway",
          },
        },
        {
          Id: extra,
          Names: ["/paperclip"],
          State: "exited",
          Status: "Exited",
          Labels: {},
        },
        {
          Id: hostBroker,
          Names: ["/shared-infra-host-broker-1"],
          State: "running",
          Status: "Up",
          Labels: {
            "com.docker.compose.project": "shared-infra",
            "com.docker.compose.service": "host-broker",
          },
        },
      ];
    if (path.endsWith("/json")) {
      const id = path.split("/")[2];
      const labels =
        id === redis
          ? {
              "com.docker.compose.project": project,
              "com.docker.compose.service": "redis",
            }
          : id === gateway
            ? {
                "com.docker.compose.project": "shared-infra",
                "com.docker.compose.service": "gateway",
              }
            : id === hostBroker
              ? {
                  "com.docker.compose.project": "shared-infra",
                  "com.docker.compose.service": "host-broker",
                }
              : {};
      const name =
        id === redis
          ? "/shared-infra-redis-1"
          : id === gateway
            ? "/shared-infra-gateway-1"
            : id === hostBroker
              ? "/shared-infra-host-broker-1"
              : "/paperclip";
      return {
        Id: id,
        Name: name,
        Config: { Labels: labels, Env: ["SECRET=private"] },
        State: { Status: id === extra ? "exited" : "running" },
      };
    }
    if (path === "/volumes")
      return {
        Volumes: [
          { Name: "shared-infra_postgres-data", Driver: "local" },
          { Name: "scratch-vol", Driver: "local" },
        ],
      };
    if (path.startsWith("/system/df"))
      return {
        Volumes: [
          {
            Name: "shared-infra_postgres-data",
            UsageData: { Size: 1024 ** 3, RefCount: 1 },
          },
          { Name: "scratch-vol", UsageData: { Size: 0, RefCount: 0 } },
        ],
      };
    if (path === "/networks")
      return [
        { Name: "bridge", Driver: "bridge", Scope: "local", Internal: false },
        {
          Name: "shared-infra_agent-control",
          Driver: "bridge",
          Scope: "local",
          Internal: true,
        },
        {
          Name: "lab-net",
          Driver: "bridge",
          Scope: "local",
          Internal: false,
          IPAM: { Config: [{ Subnet: "172.21.0.0/16" }] },
        },
      ];
    return {};
  };
  const broker = new DockerControl({ request, project: "shared-infra" });
  const listedContainers = await broker.run("list");
  assert.equal(
    listedContainers.containers.find((c) => c.service === "host-broker").class,
    "control",
  );
  await assert.rejects(broker.run("exec", { service: "redis" }), /action/);
  await broker.run("restart", { service: "redis" });
  assert.ok(
    calls.some(
      ([m, p]) => m === "POST" && p === `/containers/${redis}/restart?t=5`,
    ),
  );
  await broker.run("start", { name: "paperclip" });
  assert.ok(
    calls.some(([m, p]) => m === "POST" && p === `/containers/${extra}/start`),
  );
  await assert.rejects(
    broker.run("restart", { name: "shared-infra-gateway-1" }),
    /Control-plane/,
  );
  await assert.rejects(
    broker.run("stop", { name: "shared-infra-host-broker-1" }),
    /Control-plane/,
  );
  await assert.rejects(
    broker.run("remove", { service: "host-broker" }),
    /Control-plane/,
  );
  await assert.rejects(broker.run("remove", { service: "redis" }), /deleted/);
  await broker.run("remove", { name: "paperclip" });
  assert.ok(
    calls.some(([m, p]) => m === "DELETE" && p === `/containers/${extra}`),
  );
  const listed = await broker.run("volume_list");
  assert.equal(listed.volumes[0].protected, true);
  assert.equal(listed.volumes[0].sizeBytes, 1024 ** 3);
  assert.equal(listed.volumes[1].protected, false);
  assert.equal(listed.volumes[1].sizeBytes, 0);
  await broker.run("volume_create", { name: "scratch-vol" });
  assert.ok(calls.some(([m, p]) => m === "POST" && p === "/volumes/create"));
  await assert.rejects(
    broker.run("volume_remove", { name: "postgres-data" }),
    /data volumes/,
  );
  const nets = await broker.run("network_list");
  assert.equal(nets.networks.find((n) => n.name === "bridge").protected, true);
  assert.equal(
    nets.networks.find((n) => n.name === "shared-infra_agent-control")
      .protected,
    true,
  );
  assert.equal(nets.networks.find((n) => n.name === "lab-net").protected, false);
  assert.equal(
    nets.networks.find((n) => n.name === "lab-net").subnet,
    "172.21.0.0/16",
  );
  await broker.run("network_create", { name: "lab-net" });
  assert.ok(calls.some(([m, p]) => m === "POST" && p === "/networks/create"));
  await assert.rejects(broker.run("network_remove", { name: "bridge" }), /networks/);
  await assert.rejects(
    broker.run("network_remove", { name: "shared-infra_default" }),
    /networks/,
  );
  project = "unrelated";
  await assert.rejects(broker.run("restart", { service: "redis" }), /managed/);
});
