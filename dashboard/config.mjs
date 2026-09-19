export function configFrom(env = process.env) {
  const host = env.SHARED_INFRA_HOST || "127.0.0.1";
  return {
    host,
    port: Number(env.PORT || 8787),
    bind: env.DASHBOARD_BIND || "127.0.0.1",
    password: env.DASHBOARD_PASSWORD,
    telemetryToken: env.TELEMETRY_TOKEN,
    pg: {
      host: env.PGHOST || host,
      port: Number(env.PGPORT || 5434),
      user: env.POSTGRES_ADMIN_USER,
      password: env.POSTGRES_ADMIN_PASSWORD,
      database: "postgres",
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      application_name: "shared-infra",
      max: 5,
    },
    redis: {
      url: `redis://${env.REDIS_HOST || host}:${env.REDIS_PORT || 6379}`,
      password: env.REDIS_PASSWORD,
      socket: { connectTimeout: 4000, reconnectStrategy: false },
    },
    s3: {
      endPoint: env.MINIO_HOST || host,
      port: Number(env.MINIO_PORT || 9100),
      useSSL: false,
      accessKey: env.MINIO_ROOT_USER,
      secretKey: env.MINIO_ROOT_PASSWORD,
    },
    mailpit: env.MAILPIT_URL || `http://${host}:8125`,
  };
}
