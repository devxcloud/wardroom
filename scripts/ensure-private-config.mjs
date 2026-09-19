import { appendFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const file = process.env.ENV_FILE || new URL("../.env", import.meta.url);
let content;
try {
  content = await readFile(file, "utf8");
} catch (error) {
  if (error.code === "ENOENT") process.exit(0);
  throw error;
}

const keys = { RI_ENCRYPTION_KEY: () => randomBytes(32).toString("base64url") };
if (process.argv.includes("--api")) {
  keys.HOPPSCOTCH_DB_PASSWORD = () => randomBytes(32).toString("hex");
  keys.HOPPSCOTCH_ENCRYPTION_KEY = () => randomBytes(16).toString("hex");
}
for (const [key, generate] of Object.entries(keys)) {
  if (new RegExp(`^${key}=.+$`, "m").test(content)) continue;
  if (new RegExp(`^${key}=`, "m").test(content)) {
    throw new Error(`${key} is empty; remove its empty line to generate it.`);
  }
  const separator = content.length && !content.endsWith("\n") ? "\n" : "";
  await appendFile(file, `${separator}${key}=${generate()}\n`, { mode: 0o600 });
  content = await readFile(file, "utf8");
  console.log(`Generated missing ${key} in private .env.`);
}
