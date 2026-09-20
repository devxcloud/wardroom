import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import {
  randomBytes,
  createHmac,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { Infrastructure } from "./infra.mjs";
import { configFrom } from "./config.mjs";
import { InputError, connectionText } from "./domain.mjs";
import { AgentStore } from "./agent/store.mjs";
import { tokenInput, operationSchema } from "./agent/policy.mjs";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const fontDir = fileURLToPath(
  new URL("../node_modules/@fontsource-variable/", import.meta.url),
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
const hash = (text) => createHash("sha256").update(text).digest();

export function createApp(infra, config) {
  if (!config.password || config.password.length < 16)
    throw Error("DASHBOARD_PASSWORD must have at least 16 characters.");
  if (config.sessionSecret && config.sessionSecret.length < 32)
    throw Error("DASHBOARD_SESSION_SECRET must have at least 32 characters.");
  const secret = createHmac("sha256", config.sessionSecret || randomBytes(32))
    .update(config.password)
    .digest();
  const attempts = new Map();
  const signature = (value) =>
    createHmac("sha256", secret).update(value).digest("hex");
  const validSession = (req) => {
    const token = /(?:^|; )infra_session=([^;]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
    if (!token) return false;
    const [expires, nonce, sig] = token.split(".");
    const expected = signature(`${expires}.${nonce}`);
    return (
      Number(expires) > Date.now() &&
      typeof sig === "string" &&
      sig.length === expected.length &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    );
  };
  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(data));
  };
  const body = async (req, limit = 8192) => {
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (Buffer.byteLength(data) > limit)
        throw new InputError("Request is too large.", 413);
    }
    try {
      return JSON.parse(data);
    } catch {
      throw new InputError("Invalid JSON.");
    }
  };
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      if (req.method === "GET" && path === "/healthz")
        return json(res, 200, { status: "ok" });
      if (req.method === "GET" && path === "/authz") {
        if (!validSession(req))
          throw new InputError("Sign in to your infrastructure.", 401);
        res.writeHead(204);
        return res.end();
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          throw new InputError("Use application/json.", 415);
        if (
          req.headers.origin &&
          new URL(req.headers.origin).host !== req.headers.host
        )
          throw new InputError("Cross-origin requests are not allowed.", 403);
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new InputError("Cross-origin requests are not allowed.", 403);
      }
      if (path === "/api/telemetry" && req.method === "POST") {
        if (
          !config.telemetryToken ||
          config.telemetryToken.length < 32 ||
          !timingSafeEqual(
            hash(req.headers.authorization || ""),
            hash(`Bearer ${config.telemetryToken}`),
          )
        )
          throw new InputError("Invalid telemetry credentials.", 401);
        await infra.telemetry.ingest(await body(req, 262144));
        return json(res, 202, { accepted: true });
      }
      if (path === "/api/login" && req.method === "POST") {
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        for (const [key, value] of attempts)
          if (value.until < now) attempts.delete(key);
        const attempt = attempts.get(ip) || { count: 0, until: now + 60_000 };
        if (attempt.count >= 10)
          throw new InputError(
            "Too many attempts. Try again in one minute.",
            429,
          );
        const data = await body(req);
        if (
          typeof data.password !== "string" ||
          !timingSafeEqual(hash(data.password), hash(config.password))
        ) {
          attempt.count++;
          attempts.set(ip, attempt);
          throw new InputError("Incorrect dashboard password.", 401);
        }
        attempts.delete(ip);
        const maxAge =
          data.rememberDevice === true ? 30 * 24 * 60 * 60 : 12 * 60 * 60;
        const value = `${now + maxAge * 1000}.${randomBytes(16).toString("hex")}`;
        return json(
          res,
          200,
          { ok: true },
          {
            "Set-Cookie": `infra_session=${value}.${signature(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
          },
        );
      }
      if (path.startsWith("/api/")) {
        if (!validSession(req))
          throw new InputError("Sign in to your infrastructure.", 401);
        if (req.method === "POST" && path === "/api/logout")
          return json(
            res,
            200,
            { ok: true },
            {
              "Set-Cookie":
                "infra_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
            },
          );
        if (req.method === "POST" && path === "/api/projects")
          return json(res, 201, await infra.provision(await body(req)));
        if (path === "/api/agent-tokens" && req.method === "POST")
          return json(
            res,
            201,
            await infra.agents.issue(tokenInput(await body(req))),
          );
        if (path === "/api/agent-tokens/revoke" && req.method === "POST") {
          const data = await body(req);
          if (!operationSchema.safeParse(data?.id).success)
            throw new InputError("Invalid token identifier.");
          return json(res, 200, await infra.agents.revoke(data.id));
        }
        if (req.method === "POST" && path === "/api/lab/fault") {
          const data = await body(req);
          return json(
            res,
            200,
            await infra.tools.applyFault(data.target, data.preset),
          );
        }
        if (req.method !== "GET")
          throw new InputError("Method not allowed.", 405);
        if (path === "/api/overview")
          return json(res, 200, await infra.overview());
        if (path === "/api/agent-tokens")
          return json(res, 200, await infra.agents.list());
        if (path === "/api/agent-connection") {
          let ready = false;
          try {
            const check = await fetch("http://mcp:8790/healthz", {
              signal: AbortSignal.timeout(2000),
              redirect: "error",
            });
            ready = check.ok;
            await check.body?.cancel();
          } catch {}
          return json(res, 200, { url: `http://${config.host}/mcp`, ready });
        }
        if (path === "/api/system")
          return json(
            res,
            200,
            await infra.telemetry.read(url.searchParams.get("range") || "15m"),
          );
        if (path === "/api/tools")
          return json(res, 200, await infra.tools.read());
        if (path === "/api/projects")
          return json(res, 200, await infra.projects());
        if (path === "/api/databases")
          return json(res, 200, await infra.databases());
        if (path === "/api/roles") return json(res, 200, await infra.roles());
        if (path === "/api/tables")
          return json(
            res,
            200,
            await infra.tables(url.searchParams.get("database")),
          );
        if (path === "/api/rows")
          return json(
            res,
            200,
            await infra.rows(
              url.searchParams.get("database"),
              url.searchParams.get("schema"),
              url.searchParams.get("table"),
              url.searchParams.get("offset"),
            ),
          );
        if (path === "/api/buckets")
          return json(res, 200, await infra.s3.listBuckets());
        if (path === "/api/redis")
          return json(res, 200, await infra.redisInfo());
        if (path === "/api/connections") {
          const p = (await infra.projects()).find(
            (p) => p.name === url.searchParams.get("project"),
          );
          if (!p) throw new InputError("Project not found.", 404);
          return json(res, 200, { text: connectionText(p, config.host) });
        }
        throw new InputError("Endpoint not found.", 404);
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new InputError("Method not allowed.", 405);
      const root = path.startsWith("/fonts/") ? fontDir : publicDir;
      const relative = path.startsWith("/fonts/")
        ? path.slice(7)
        : path === "/"
          ? "index.html"
          : decodeURIComponent(path).slice(1);
      const file = resolve(root, relative);
      if (
        !file.startsWith(root + sep) &&
        !file.startsWith(root.endsWith(sep) ? root : root + sep)
      )
        throw new InputError("Not found.", 404);
      let content;
      try {
        content = await readFile(file);
      } catch {
        throw new InputError("Not found.", 404);
      }
      res.writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      // Database errors can include SQL/credentials. Never return or log raw errors.
      const status = error instanceof InputError ? error.status : 503;
      json(res, status, {
        error:
          error instanceof InputError
            ? error.message
            : "Service unavailable. Check connectivity and retry. Partial provisioning can be retried with the same settings.",
      });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = configFrom();
  const infra = new Infrastructure(config);
  try {
    if (!config.password || config.password.length < 16) throw Error();
    await infra.initialize();
    infra.agents = new AgentStore(infra.pool, config.sessionSecret);
    await infra.agents.initialize();
    const server = createApp(infra, config);
    server.requestTimeout = 30_000;
    server.listen(config.port, config.bind, () =>
      console.log(
        `Shared infrastructure dashboard listening on ${config.bind}:${config.port}`,
      ),
    );
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(signal, () => {
        server.close(async () => {
          await infra.close();
          process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
      });
  } catch {
    console.error(
      "Dashboard startup failed. Check PostgreSQL connectivity and DASHBOARD_PASSWORD (16+ characters).",
    );
    await infra.close();
    process.exitCode = 1;
  }
}
