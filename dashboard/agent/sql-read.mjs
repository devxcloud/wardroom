import { InputError } from "../domain.mjs";

export function assertReadOnlySql(sql) {
  const stripped = String(sql || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (!stripped) throw new InputError("SQL is empty.");
  if (/;\s*\S/.test(stripped))
    throw new InputError("sql_query accepts a single statement.");
  if (!/^(with|select|explain|show|values|table)\b/i.test(stripped))
    throw new InputError(
      "sql_query only accepts read-only statements (SELECT, WITH, EXPLAIN, SHOW).",
    );
  return stripped;
}
