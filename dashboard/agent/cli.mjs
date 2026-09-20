import { parseArgs } from "node:util";
import { Infrastructure } from "../infra.mjs";
import { configFrom } from "../config.mjs";
import { AgentStore } from "./store.mjs";
import { safeError } from "./policy.mjs";
import { InputError } from "../domain.mjs";
import { z } from "zod";

const infra = new Infrastructure(configFrom());
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      admin: { type: "boolean" },
      destructive: { type: "boolean" },
      label: { type: "string" },
      days: { type: "string" },
      id: { type: "string" },
      "token-id": { type: "string" },
    },
  });
  const store = new AgentStore(
    infra.pool,
    process.env.DASHBOARD_SESSION_SECRET,
  );
  await store.initialize();
  let result;
  if (positionals[0] === "issue")
    result = await store.issue({
      scope: values.admin ? "admin" : "project",
      project: values.project,
      label: values.label || "coding agent",
      destructive: !!values.destructive,
      days: values.days === undefined ? 30 : Number(values.days),
    });
  else if (positionals[0] === "list") result = await store.list();
  else if (positionals[0] === "revoke")
    result = await store.revoke(z.uuid().parse(values.id));
  else if (positionals[0] === "history")
    result = await store.history({ scope: "admin", id: null });
  else if (positionals[0] === "acknowledge")
    result = await store.acknowledge(
      z.uuid().parse(values["token-id"]),
      z.uuid().parse(values.id),
    );
  else throw new InputError("Use issue, list, revoke, history or acknowledge.");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? "Invalid identifier or command arguments."
      : safeError(error),
  );
  process.exitCode = 1;
} finally {
  await infra.close();
}
