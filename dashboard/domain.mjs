export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export const quoteIdentifier = (value) =>
  `"${String(value).replaceAll('"', '""')}"`;
export const quoteLiteral = (value) =>
  `'${String(value).replaceAll("'", "''")}'`;

export function projectInput(input) {
  const name = String(input.name || "");
  if (!/^[a-z][a-z0-9_]{2,47}$/.test(name))
    throw new InputError(
      "Use 3–48 lowercase letters, numbers or underscores; start with a letter.",
    );
  if (
    [
      "postgres",
      "template0",
      "template1",
      "shared_infra",
      "test",
      "local",
      "mail",
    ].includes(name)
  )
    throw new InputError("This project name is reserved.");
  const database = input.database || name;
  const testDatabase = input.testDatabase || `${name}_test`;
  for (const db of [database, testDatabase]) {
    if (
      !/^[a-z][a-z0-9_]{2,62}$/.test(db) ||
      ["postgres", "template0", "template1"].includes(db)
    )
      throw new InputError("Invalid or reserved database name.");
  }
  if (database === testDatabase)
    throw new InputError("Development and test databases must be different.");
  const bucket = input.bucket || name.replaceAll("_", "-");
  const testBucket = input.testBucket || `${bucket}-test`;
  for (const b of [bucket, testBucket]) {
    if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(b) || /--/.test(b))
      throw new InputError(
        "Buckets must be 3–63 lowercase letters, numbers or hyphens.",
      );
  }
  if (bucket === testBucket)
    throw new InputError("Development and test buckets must be different.");
  const description = String(input.description || "").slice(0, 160);
  return {
    name,
    database,
    testDatabase,
    bucket,
    testBucket,
    redisPrefix: `${name}:`,
    description,
  };
}

export function connectionText(project, host, secrets = {}) {
  const dbPassword = secrets.dbPassword
    ? encodeURIComponent(secrets.dbPassword)
    : "<PROJECT_DB_PASSWORD>";
  const s3Access = secrets.s3AccessKey || "<MINIO_ROOT_USER>";
  const s3Secret = secrets.s3SecretKey || "<MINIO_ROOT_PASSWORD>";
  return `# ${project.name} • shared development infrastructure
# Replace remaining placeholders with your local credentials.
DATABASE_URL=postgres://${encodeURIComponent(project.name)}:${dbPassword}@${host}:5434/${project.database}
TEST_DATABASE_URL=postgres://${encodeURIComponent(project.name)}:${dbPassword}@${host}:5434/${project.testDatabase}
REDIS_URL=redis://:<REDIS_PASSWORD>@${host}:6379/0
REDIS_KEY_PREFIX=${project.redisPrefix}
TEST_REDIS_KEY_PREFIX=${project.redisPrefix}test:
S3_ENDPOINT=http://${host}:9100
S3_BUCKET=${project.bucket}
S3_TEST_BUCKET=${project.testBucket}
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY=${s3Access}
S3_SECRET_KEY=${s3Secret}
SMTP_HOST=${host}
SMTP_PORT=1125
MAIL_DOMAIN=${project.name}.test`;
}

export function pageOffset(value) {
  const offset = Number(value || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
    throw new InputError("Invalid page offset.");
  return offset;
}
