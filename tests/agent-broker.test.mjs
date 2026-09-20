import { test } from "node:test";
import assert from "node:assert/strict";
import { DockerControl } from "../dashboard/agent/broker.mjs";
test("broker permits only managed, allowlisted container operations and rechecks identity", async () => {
  const id = "a".repeat(64);
  let project = "shared-infra";
  const calls = [];
  const request = async (method, path) => {
    calls.push([method, path]);
    if (path.startsWith("/containers/json"))
      return [
        {
          Id: id,
          Labels: {
            "com.docker.compose.project": project,
            "com.docker.compose.service": "redis",
          },
        },
      ];
    if (path.endsWith("/json"))
      return {
        Id: id,
        Config: {
          Labels: {
            "com.docker.compose.project": project,
            "com.docker.compose.service": "redis",
          },
          Env: ["SECRET=private"],
        },
        State: { Status: "running" },
      };
    return {};
  };
  const broker = new DockerControl({ request, project: "shared-infra" });
  await assert.rejects(
    broker.run("restart", { service: "gateway" }),
    /service/,
  );
  await assert.rejects(broker.run("exec", { service: "redis" }), /action/);
  await broker.run("restart", { service: "redis" });
  assert.ok(
    calls.some(
      ([m, p]) => m === "POST" && p === `/containers/${id}/restart?t=5`,
    ),
  );
  project = "unrelated";
  await assert.rejects(broker.run("restart", { service: "redis" }), /managed/);
});
