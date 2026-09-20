import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
loadEnvFile(resolve(root, ".env"));
const endpoint = process.env.DOCKER_ENDPOINT;
const context = process.env.DOCKER_CONTEXT || "wardroom";
let parsed;
try {
  parsed = new URL(endpoint || "");
} catch {
  parsed = null;
}
if (
  !parsed ||
  parsed.protocol !== "ssh:" ||
  !parsed.username ||
  !parsed.hostname
)
  throw Error("DOCKER_ENDPOINT must be an ssh://user@host URL.");
const actual = execFileSync(
  "docker",
  ["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"],
  { encoding: "utf8" },
).trim();
if (actual !== endpoint)
  throw Error("Configured Docker context endpoint mismatch.");
if (!process.env.TELEMETRY_TOKEN || process.env.TELEMETRY_TOKEN.length < 32)
  throw Error("Set TELEMETRY_TOKEN (32+ characters) in .env.");
if (!/^[A-Za-z0-9.-]+$/.test(process.env.SHARED_INFRA_HOST || ""))
  throw Error("Invalid SHARED_INFRA_HOST.");
const sshTarget = `${decodeURIComponent(parsed.username)}@${parsed.hostname}`;
const sshPort = parsed.port;
const ssh = (command) => {
  const args = ["-o", "ConnectTimeout=10"];
  if (sshPort) args.push("-p", sshPort);
  args.push(sshTarget, command);
  execFileSync("ssh", args, { stdio: "inherit" });
};
ssh(
  "install -d -m 700 .local/lib/shared-infra-telemetry .config/shared-infra-telemetry; mkdir -p .config/systemd/user",
);
execFileSync(
  "scp",
  [
    ...(sshPort ? ["-P", sshPort] : []),
    resolve(root, "telemetry/collector.py"),
    `${sshTarget}:.local/lib/shared-infra-telemetry/collector.py`,
  ],
  { stdio: "inherit" },
);
execFileSync(
  "scp",
  [
    ...(sshPort ? ["-P", sshPort] : []),
    resolve(root, "telemetry/shared-infra-telemetry.service"),
    `${sshTarget}:.config/systemd/user/shared-infra-telemetry.service`,
  ],
  { stdio: "inherit" },
);
const temporary = mkdtempSync(resolve(tmpdir(), "shared-infra-telemetry-"));
const configFile = resolve(temporary, "config.json");
try {
  writeFileSync(
    configFile,
    JSON.stringify({
      url: `http://${process.env.SHARED_INFRA_HOST}:8787/api/telemetry`,
      token: process.env.TELEMETRY_TOKEN,
      interval: 10,
    }) + "\n",
    { mode: 0o600 },
  );
  execFileSync(
    "scp",
    [
      ...(sshPort ? ["-P", sshPort] : []),
      configFile,
      `${sshTarget}:.config/shared-infra-telemetry/config.json`,
    ],
    { stdio: "inherit" },
  );
  ssh("chmod 600 .config/shared-infra-telemetry/config.json");
} finally {
  unlinkSync(configFile);
  rmdirSync(temporary);
}
ssh(
  "systemctl --user daemon-reload && systemctl --user enable shared-infra-telemetry.service && systemctl --user restart shared-infra-telemetry.service",
);
try {
  ssh('loginctl enable-linger "$USER"');
  console.log(
    "Telemetry installed; user service will run at boot and after logout.",
  );
} catch {
  console.log(
    "Telemetry is running for this login session. Boot persistence requires an administrator to run: loginctl enable-linger " +
      decodeURIComponent(parsed.username),
  );
  process.exitCode = 2;
}
ssh("systemctl --user is-active shared-infra-telemetry.service");
