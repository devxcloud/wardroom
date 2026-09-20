import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

const args = process.argv.slice(2);
const index = args.indexOf("--output");
let file;
try {
  if (index !== -1) {
    const path = args[index + 1];
    if (!path || path.startsWith("--"))
      throw Error("--output requires a private file path.");
    args.splice(index, 2);
    file = await open(path, "wx", 0o600);
  }
  const child = spawn(
    "bash",
    [
      "scripts/compose.sh",
      "exec",
      "-T",
      "dashboard",
      "node",
      "dashboard/agent/cli.mjs",
      ...args,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const completion = new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", resolve);
  });
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.length > 262144) {
      child.kill();
      throw Error("Unexpected CLI output size.");
    }
  }
  const code = await completion;
  if (code !== 0)
    throw Error("Agent token command failed; no token was written.");
  if (file) {
    const credentials = JSON.parse(output);
    await file.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
    console.log(
      "Private agent credentials written. Keep this file outside version control.",
    );
  } else process.stdout.write(output);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await file?.close();
}
