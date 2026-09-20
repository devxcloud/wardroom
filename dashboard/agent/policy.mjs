import { createHmac } from "node:crypto";
import { z } from "zod";
import { InputError, projectInput } from "../domain.mjs";

export const nameSchema = z.string().regex(/^[a-z][a-z0-9_]{2,47}$/);
export const operationSchema = z.string().uuid();
export const protectedNames = new Set([
  "postgres",
  "template0",
  "template1",
  "shared_infra",
  "hoppscotch",
  "test",
  "local",
  "mail",
]);
export function projectName(name) {
  if (!nameSchema.safeParse(name).success || protectedNames.has(name))
    throw new InputError("Invalid or protected project name.");
  return name;
}
export function tokenInput(input) {
  const result = z
    .object({
      label: z.string().trim().min(1).max(80),
      scope: z.enum(["project", "admin"]).default("project"),
      project: nameSchema.optional(),
      destructive: z.boolean().default(false),
      days: z.number().int().min(0).max(90).default(30),
    })
    .strict()
    .safeParse(input);
  if (!result.success) throw new InputError("Invalid token options.");
  const value = result.data;
  if (value.scope === "project") projectName(value.project);
  else if (value.project !== undefined)
    throw new InputError("Admin tokens cannot specify a project.");
  return value;
}
export function authorize(
  actor,
  project,
  { admin = false, destructive = false } = {},
) {
  if (!actor || !["project", "admin"].includes(actor.scope))
    throw new InputError("Invalid agent credentials.", 401);
  if (admin && actor.scope !== "admin")
    throw new InputError("This tool requires admin scope.", 403);
  if (project !== undefined) {
    projectName(project);
    if (actor.scope !== "admin" && actor.project !== project)
      throw new InputError("Project is outside token scope.", 403);
  }
  if (destructive && actor.destructive !== true)
    throw new InputError("Token does not allow destructive operations.", 403);
}
export function provisioningInput(args) {
  projectName(args.project);
  return { ...projectInput({ name: args.project }), password: args.password };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const fingerprint = (secret, value) =>
  createHmac("sha256", secret)
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function safeError(error) {
  return error instanceof InputError
    ? error.message
    : "Infrastructure operation failed. Inspect its operation status before retrying.";
}
