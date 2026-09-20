import { Infrastructure } from "../infra.mjs";
import { configFrom } from "../config.mjs";
import { AgentStore } from "./store.mjs";
import { AgentResources } from "./resources.mjs";
import { AgentLab } from "./lab.mjs";
import { createCatalog } from "./catalog.mjs";
import { createMcpApp } from "./mcp.mjs";
import { ProjectSecrets } from "./secrets.mjs";
import { MinioIam } from "./minio-iam.mjs";

const config = configFrom();
config.pg.max = 12;
const infra = new Infrastructure(config);
try {
  await infra.initialize();
  const store = new AgentStore(infra.pool, config.sessionSecret);
  await store.initialize();
  infra.secrets = new ProjectSecrets(infra.pool, config.sessionSecret);
  infra.iam = new MinioIam(config.s3);
  for (const name of infra.createdbGrants || [])
    await store.recordSystem(
      "user_set_createdb",
      JSON.stringify({ project: name, user: name }),
      { project: name, user: name, createdb: true },
    );
  const lab = new AgentLab(infra, new AgentResources(infra, { secrets: infra.secrets, iam: infra.iam }));
  const catalog = createCatalog(infra, store, { lab });
  const app = createMcpApp({
    catalog,
    store,
    hosts: (process.env.MCP_ALLOWED_HOSTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  app.listen(8790, "0.0.0.0", () =>
    console.log("Wardroom MCP ready on internal port 8790."),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      const deadline = setTimeout(() => process.exit(1), 10000);
      deadline.unref();
      app.close(async () => {
        await infra.close();
        process.exit(0);
      });
    });
} catch {
  console.error(
    "MCP startup failed. Check database connectivity and private MCP configuration.",
  );
  await infra.close();
  process.exitCode = 1;
}
