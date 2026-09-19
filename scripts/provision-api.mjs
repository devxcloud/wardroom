import { execFileSync } from "node:child_process";
import { Infrastructure } from "../dashboard/infra.mjs";
import { configFrom } from "../dashboard/config.mjs";

// Verify the same remote context contract before making database changes.
execFileSync("bash", ["scripts/compose.sh", "config", "--quiet"], {
  stdio: "inherit",
});
const password = process.env.HOPPSCOTCH_DB_PASSWORD;
const key = process.env.HOPPSCOTCH_ENCRYPTION_KEY;
if (
  !/^[a-f0-9]{64}$/.test(password || "") ||
  !/^[a-f0-9]{32}$/.test(key || "")
) {
  throw new Error("API credentials must be generated with make api-up.");
}
const host = process.env.HOPPSCOTCH_HOST || "devbox";
if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) {
  throw new Error(
    "HOPPSCOTCH_HOST must be a hostname or IPv4 address, without scheme or port.",
  );
}
const infra = new Infrastructure(configFrom());
try {
  await infra.initialize();
  await infra.provision({ name: "hoppscotch", password });
  console.log(
    "Hoppscotch project resources are ready; existing credentials preserved.",
  );
} catch {
  console.error(
    "Hoppscotch provisioning failed. Check connectivity and project ownership; credentials were not printed.",
  );
  process.exitCode = 1;
} finally {
  await infra.close();
}
