import { configFrom } from "./config.mjs";
import { Infrastructure } from "./infra.mjs";
import { InputError, connectionText } from "./domain.mjs";
import { ProjectSecrets } from "./agent/secrets.mjs";
import { MinioIam } from "./agent/minio-iam.mjs";

const config = configFrom();
const infra = new Infrastructure(config);
try {
  const [command, name] = process.argv.slice(2);
  await infra.initialize();
  if (config.sessionSecret) {
    infra.secrets = new ProjectSecrets(infra.pool, config.sessionSecret);
    infra.iam = new MinioIam(config.s3);
  }
  if (command === "provision") {
    const project = await infra.provision({
      name,
      password: process.env.PROJECT_DB_PASSWORD,
      database: process.env.PROJECT_DB_NAME,
      testDatabase: process.env.PROJECT_TEST_DB_NAME,
      bucket: process.env.PROJECT_S3_BUCKET,
      testBucket: process.env.PROJECT_TEST_S3_BUCKET,
    });
    console.log(
      `Project '${project.name}' is ready.\n${connectionText(project, infra.config.host)}`,
    );
  } else if (command === "connections") {
    const project = (await infra.projects()).find((p) => p.name === name);
    if (!project) throw new InputError("Project not found.");
    console.log(connectionText(project, infra.config.host));
  } else if (command === "smoke") {
    const overview = await infra.overview();
    for (const s of overview.services) {
      console.log(`${s.id}: ${s.status}`);
      if (s.status !== "healthy") process.exitCode = 1;
    }
    for (const p of overview.projects.filter((p) => p.status === "ready")) {
      for (const db of [p.database, p.testDatabase]) {
        await infra.withDatabase(db, (c) =>
          c.query("SELECT '[1,2,3]'::vector <-> '[1,2,3]'::vector"),
        );
        console.log(`${db}: vector operation passed`);
      }
      for (const bucket of [p.bucket, p.testBucket])
        if (!(await infra.s3.bucketExists(bucket)))
          throw new InputError(`Missing bucket: ${bucket}`);
    }
    if (!overview.projects.some((p) => p.status === "ready"))
      console.log(
        "No ready projects registered; project-level checks skipped.",
      );
  } else
    throw new InputError(
      "Use provision <project>, connections <project>, or smoke.",
    );
} catch (error) {
  console.error(
    error instanceof InputError
      ? error.message
      : "Infrastructure operation failed. Check service connectivity; retry partial provisioning with the same settings.",
  );
  process.exitCode = 1;
} finally {
  await infra.close();
}
