import { mountSystem } from "./system.js";
import { mountTools } from "./tools.js";

let disposeSystem = () => {};
const root = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const state = {
  view: "overview",
  overview: null,
  db: null,
  table: null,
  tab: "databases",
  offset: 0,
  query: "",
  sequence: 0,
};
const paths = {
  overview: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z",
  database:
    "M20 6c0 2-4 4-8 4S4 8 4 6s4-4 8-4 8 2 8 4Zm0 0v12c0 2-4 4-8 4s-8-2-8-4V6m0 6c0 2 4 4 8 4s8-2 8-4",
  projects: "M3 7h7l2-3h9v16H3V7Z",
  storage: "m12 2 10 5-10 5L2 7l10-5Zm-10 5v10l10 5 10-5V7M12 12v10",
  operations:
    "m9 3-1 4-4 1v8l4 1 1 4h6l1-4 4-1V8l-4-1-1-4H9Zm3 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6",
  arrow: "m7 17 10-10M7 7h10v10",
  chevron: "m9 5 7 7-7 7",
  plus: "M12 5v14M5 12h14",
  search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  copy: "M9 9h12v12H9zM15 9V3H3v12h6",
  refresh: "M20 7a9 9 0 1 0 1 8M20 2v6h-6",
  check: "m5 12 4 4L20 5",
  close: "m6 6 12 12M6 18 18 6",
  mail: "M3 5h18v14H3zM3 5l9 8 9-8",
  redis: "m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5",
  server: "M4 3h16v7H4zm0 11h16v7H4zM7 6h1m-1 11h1",
  lock: "M5 10h14v11H5zm3 0V6a4 4 0 0 1 8 0v4",
  logout: "M9 4H3v16h6m4-13 5 5-5 5m-6-5h15",
  table: "M3 4h18v16H3zM3 10h18M9 4v16",
  users:
    "M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8m9-7a4 4 0 0 1 0 8m2 3a4 4 0 0 1 2 4v3",
  terminal: "m4 6 6 6-6 6m9 0h7",
  back: "M20 12H4m7-7-7 7 7 7",
  clock: "M12 8v5l3 2m7-3a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  globe:
    "M2 12h20M12 2c7 6 7 14 0 20-7-6-7-14 0-20Zm10 10a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
};
const icon = (name, cls = "") =>
  `<svg class="icon ${cls}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] || paths.server}"/></svg>`;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const bytes = (n) => {
  if (!n) return "0 B";
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB"][i]}`;
};
const date = (v) =>
  new Date(v).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const badge = (status) =>
  `<span class="badge ${status === "healthy" || status === "ready" ? "good" : status === "failed" || status === "unreachable" ? "bad" : "neutral"}"><span></span>${esc(status)}</span>`;
const services = {
  postgres: {
    name: "PostgreSQL",
    desc: "Relational + vector",
    icon: "database",
    port: 5434,
    color: "blue",
  },
  redis: {
    name: "Redis",
    desc: "Cache + queues",
    icon: "redis",
    port: 6379,
    color: "red",
  },
  minio: {
    name: "MinIO",
    desc: "Object storage",
    icon: "storage",
    port: 9100,
    color: "purple",
  },
  mailpit: {
    name: "Mailpit",
    desc: "Development mail",
    icon: "mail",
    port: 1125,
    color: "teal",
  },
};
let toastTimer;
function toast(message) {
  const t = document.querySelector("#toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}
async function api(path, options = {}) {
  const r = await fetch(`/api/${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith("login")) login();
    throw Error(data.error || "Request failed.");
  }
  return data;
}
function login() {
  disposeSystem();
  state.sequence++;
  root.innerHTML = `<main class="login"><section class="login-art"><a class="brand" href="/"><img src="/mark.svg" alt="">Wardroom</a><div><div class="login-network">${icon("server")}<div class="orbit">${icon("database")}${icon("redis")}${icon("storage")}${icon("mail")}</div></div><h1>One home for<br>everything underneath.</h1><p>Your databases, storage and services.<br>Running together. Out of your way.</p></div><span class="login-foot">Shared infrastructure <span>Built for your team</span></span></section><section class="login-form"><div class="login-inner"><span class="lock-tile">${icon("lock")}</span><h2>Your workspace is ready.</h2><p>Sign in to explore and manage your shared infrastructure.</p><form id="login-form"><label for="password">Dashboard password</label><input id="password" name="password" type="password" autocomplete="current-password" required placeholder="Enter your dashboard password"><p class="form-error" role="alert"></p><button class="button primary" type="submit">Open workspace ${icon("arrow")}</button></form><div class="private-note">${icon("globe")} Private workspace on your Tailnet</div></div></section></main>`;
  document
    .querySelector("#login-form")
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = e.target.querySelector("button");
      button.disabled = true;
      button.textContent = "Signing in…";
      try {
        await api("login", {
          method: "POST",
          body: JSON.stringify({
            password: new FormData(e.target).get("password"),
          }),
        });
        await boot();
      } catch (error) {
        e.target.querySelector(".form-error").textContent = error.message;
        button.disabled = false;
        button.innerHTML = `Open workspace ${icon("arrow")}`;
      }
    });
}
function shell() {
  const names = {
    overview: "Overview",
    system: "System",
    tools: "Tools",
    database: "PostgreSQL",
    projects: "Projects",
    storage: "Storage",
    operations: "Operations",
  };
  root.innerHTML = `<div class="app-shell"><aside class="sidebar"><a class="brand" href="#overview"><img src="/mark.svg" alt="">Wardroom</a><div class="workspace-switch">${icon("server")}<div>Development<span>Shared host · Tailnet</span></div><span class="online-dot"></span></div><nav aria-label="Main navigation">${Object.entries(
    names,
  )
    .map(
      ([key, name]) =>
        `<button data-nav="${key}" class="nav-item ${state.view === key ? "active" : ""}" ${state.view === key ? 'aria-current="page"' : ""}>${icon(key)}<span>${name}</span>${key === "projects" ? `<small>${state.overview?.projects.length ?? 0}</small>` : ""}</button>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-bottom"><div class="host-note"><span class="online-dot"></span>Connected through Tailscale<code>${esc(state.overview?.host || "devbox")}</code></div><button class="nav-item" data-action="logout">${icon("logout")} Sign out</button></div></aside><div class="workspace"><header class="topbar"><span class="breadcrumbs">Workspace ${icon("chevron")} <strong>${names[state.view]}</strong></span><div class="topbar-right"><span class="env-tag">Development</span><button class="icon-button" data-action="refresh" aria-label="Refresh data" title="Refresh data">${icon("refresh")}</button><button class="avatar" data-action="logout" title="Sign out" aria-label="Sign out">S</button></div></header><main id="main" tabindex="-1"></main><footer class="footer"><span>${icon("lock")} Private infrastructure. Shared possibilities.</span><span id="updated">Live infrastructure data</span></footer></div></div>`;
}
function heading(title, subtitle, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
function empty(title, message) {
  return `<div class="empty">${icon("database")}<h3>${title}</h3><p>${message}</p></div>`;
}
function search(placeholder) {
  return `<label class="search">${icon("search")}<input type="search" id="filter" aria-label="${placeholder}" placeholder="${placeholder}" value="${esc(state.query)}"><kbd>/</kbd></label>`;
}
function overview() {
  const o = state.overview,
    healthy = o.services.filter((s) => s.status === "healthy").length;
  const main = document.querySelector("#main");
  main.innerHTML =
    heading(
      "A little less infrastructure.<br>A lot more building.",
      "Your shared development environment, all in one place.",
      `<button class="button primary" data-action="new-project">${icon("plus")} New project</button>`,
    ) +
    `<section class="topology panel" aria-label="Live service map"><div class="panel-heading"><div><h2>Your infrastructure</h2><p>One host. Four services. Room for your next idea.</p></div>${badge(healthy === 4 ? "healthy" : "attention needed")}</div><div class="service-map"><div class="host-node"><div class="host-cube">${icon("server")}</div><div><strong>Devbox</strong><span>${esc(o.host)}</span></div><span class="host-caption">Shared development host</span></div><div class="map-trunk"></div><div class="map-branches">${o.services
      .map((s) => {
        const m = services[s.id];
        return `<button class="service-node ${m.color}" data-service="${s.id}"><div class="node-top"><span class="service-symbol">${icon(m.icon)}</span><span class="status-dot ${s.status === "healthy" ? "" : "offline"}" title="${s.status}"></span></div><strong>${m.name}</strong><span>${m.desc}</span><div class="node-meta"><code>:${m.port}</code>${icon("arrow")}</div></button>`;
      })
      .join(
        "",
      )}</div></div><div class="map-caption"><span>${icon("globe")} Available across your Tailnet</span><span>${healthy} of 4 services reachable</span></div></section><div class="overview-bottom"><section class="panel"><div class="panel-heading"><div><h2>Projects at home here <span class="count">${o.projects.length}</span></h2><p>Separate resources. Shared foundations.</p></div><button class="text-button" data-nav="projects">View all ${icon("chevron")}</button></div>${o.projects.length ? `<div class="project-list">${o.projects.map((p) => `<button class="project-row" data-connection="${esc(p.name)}"><span class="project-avatar">${esc(p.name.slice(0, 2))}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.description || `${p.database} · ${p.bucket}`)}</small></span>${badge(p.status)}${icon("chevron")}</button>`).join("")}</div>` : empty("Make room for your first project", "Create a project to provision its databases and storage.")}</section><section class="panel pulse-panel"><div class="panel-heading"><div><h2>Service pulse</h2><p>Checked from the control room</p></div>${icon("clock")}</div><div class="pulse-list">${o.services.map((s) => `<div><span class="tiny-symbol ${services[s.id].color}">${icon(services[s.id].icon)}</span><strong>${services[s.id].name}</strong><span>${s.status === "healthy" ? `${s.duration} ms` : "Unreachable"}</span><span class="status-dot ${s.status === "healthy" ? "" : "offline"}"></span></div>`).join("")}</div></section></div><section class="activity"><h2>Recent activity</h2>${o.events.length ? o.events.map((e) => `<div>${icon("check")}<strong>${esc(e.project)}</strong><span>${esc(e.message)}</span><time>${date(e.created_at)}</time></div>`).join("") : "<p>Provisioning activity will appear here when you create a project.</p>"}</section>`;
}
async function projects() {
  const items = await api("projects");
  if (state.view !== "projects") return;
  document.querySelector("#main").innerHTML =
    heading(
      "Space for every project.",
      "A shared registry keeps databases, buckets and key prefixes from colliding.",
      `<button class="button primary" data-action="new-project">${icon("plus")} New project</button>`,
    ) +
    `<section class="panel"><div class="panel-heading">${search("Find a project")}<span class="subtle">${items.length} registered</span></div><div class="table-wrap"><table><thead><tr><th>Project</th><th>Databases</th><th>Storage</th><th>Redis prefix</th><th>Status</th><th></th></tr></thead><tbody>${items.map((p) => `<tr data-filter="${esc(p.name)}"><td><strong>${esc(p.name)}</strong><small>${esc(p.description)}</small></td><td><code>${esc(p.database)}</code><small>${esc(p.testDatabase)} <span class="mini-tag">test</span></small></td><td><code>${esc(p.bucket)}</code><small>${esc(p.testBucket)}</small></td><td><code>${esc(p.redisPrefix)}</code></td><td>${badge(p.status)}</td><td><button class="button small" data-connection="${esc(p.name)}">Connect ${icon("arrow")}</button>${p.status !== "ready" ? ` <button class="text-button" data-retry="${esc(p.name)}">Complete setup</button>` : ""}</td></tr>`).join("")}</tbody></table></div><div class="filter-empty" hidden>No matching projects.</div></section><div class="info-note">${icon("lock")} Credentials are never stored in this registry. Existing project passwords are preserved on retry.</div>`;
  bindFilter();
}
async function database() {
  const main = document.querySelector("#main");
  if (state.db) {
    await databaseDetail();
    return;
  }
  const [dbs, roles] = await Promise.all([api("databases"), api("roles")]);
  if (state.view !== "database" || state.db) return;
  main.innerHTML =
    heading(
      "A clear view of your data.",
      "Explore databases and roles on your shared PostgreSQL server.",
      `<span class="read-only">${icon("lock")} Read-only explorer</span>`,
    ) +
    `<div class="tabs" role="tablist"><button role="tab" aria-selected="${state.tab === "databases"}" class="${state.tab === "databases" ? "selected" : ""}" data-tab="databases">${icon("database")} Databases <span>${dbs.length}</span></button><button role="tab" aria-selected="${state.tab === "roles"}" class="${state.tab === "roles" ? "selected" : ""}" data-tab="roles">${icon("users")} Roles <span>${roles.length}</span></button></div><section class="panel"><div class="panel-heading">${search(state.tab === "roles" ? "Find a role" : "Find a database")}<span class="subtle">PostgreSQL ${esc(state.overview?.services.find((s) => s.id === "postgres")?.version || "")}</span></div><div class="table-wrap">${state.tab === "roles" ? `<table><thead><tr><th>Role</th><th>Login</th><th>Privileges</th><th>Connection limit</th></tr></thead><tbody>${roles.map((r) => `<tr data-filter="${esc(r.name)}"><td><span class="inline-icon">${icon("users")}<strong>${esc(r.name)}</strong></span></td><td>${r.login ? "Enabled" : "Disabled"}</td><td>${r.superuser ? '<span class="mini-tag">Superuser</span>' : r.createDb ? "Create databases" : r.createRole ? "Create roles" : "Project role"}</td><td>${r.connectionLimit < 0 ? "Unlimited" : r.connectionLimit}</td></tr>`).join("")}</tbody></table>` : `<table><thead><tr><th>Database</th><th>Owner</th><th>Size</th><th>Connections</th><th>Encoding</th><th></th></tr></thead><tbody>${dbs.map((db) => `<tr data-filter="${esc(db.name)}"><td><button class="table-link" data-db="${esc(db.name)}">${icon("database")} ${esc(db.name)}</button></td><td>${esc(db.owner)}</td><td class="numeric">${bytes(db.bytes)}</td><td>${db.connections}</td><td><code>${esc(db.encoding)}</code></td><td><button class="icon-button" data-db="${esc(db.name)}" aria-label="Explore ${esc(db.name)}">${icon("chevron")}</button></td></tr>`).join("")}</tbody></table>`}</div><div class="filter-empty" hidden>No matches. Try a different name.</div></section>`;
  bindFilter();
}
async function databaseDetail() {
  const db = state.db;
  const tables = await api(`tables?database=${encodeURIComponent(db)}`);
  if (state.db !== db) return;
  const main = document.querySelector("#main");
  main.innerHTML =
    `<button class="back-link" data-action="back-db">${icon("back")} All databases</button>` +
    heading(
      esc(db),
      `${tables.length} tables · Schema and record explorer`,
      `<span class="read-only">${icon("lock")} Read-only</span>`,
    ) +
    `<section class="explorer panel"><aside class="table-sidebar"><div class="table-sidebar-head">${search("Find a table")}</div><div class="table-tree">${tables.map((t) => `<button data-table="${esc(t.name)}" data-schema="${esc(t.schema)}" data-filter="${esc(`${t.schema}.${t.name}`)}" class="${state.table?.name === t.name && state.table?.schema === t.schema ? "selected" : ""}">${icon("table")}<span>${esc(t.name)}<small>${esc(t.schema)}</small></span></button>`).join("")}</div>${tables.length ? "" : '<p class="subtle padded">No tables yet. Run your project migrations to get started.</p>'}</aside><div class="table-content" id="records">${empty("Your data, in focus.", "Select a table to browse its columns and records.")}</div></section>`;
  bindFilter();
  if (state.table) await records();
}
async function records() {
  const { db, table, offset } = state;
  const target = document.querySelector("#records");
  if (!target || !table) return;
  target.innerHTML =
    '<div class="loading"><span class="spinner"></span> Loading records…</div>';
  try {
    const data = await api(
      `rows?${new URLSearchParams({ database: db, schema: table.schema, table: table.name, offset })}`,
    );
    if (
      state.db !== db ||
      state.table?.name !== table.name ||
      state.table?.schema !== table.schema ||
      state.offset !== offset
    )
      return;
    target.innerHTML = `<div class="records-header"><div><strong>${esc(table.schema)}<span> / </span>${esc(table.name)}</strong><small>${data.columns.length} columns · Values previewed up to 2,000 characters</small></div><span class="mini-tag">50 per page</span></div><div class="record-scroll"><table class="records-table"><thead><tr>${data.columns.map((c) => `<th>${esc(c.name)}<small>${esc(c.type)} ${c.required ? "· required" : ""}</small></th>`).join("")}</tr></thead><tbody>${data.rows.map((row) => `<tr>${data.columns.map((c) => `<td>${row[c.name] === null ? '<span class="null">null</span>' : esc(row[c.name])}</td>`).join("")}</tr>`).join("")}</tbody></table>${data.rows.length ? "" : empty("This table is empty.", "Records will appear here when your application adds them.")}</div><div class="pagination"><span>${data.rows.length ? `${offset + 1}–${offset + data.rows.length}` : "0"} records shown</span><div><button class="button small" data-page="${Math.max(0, offset - 50)}" ${offset === 0 ? "disabled" : ""}>Previous</button><button class="button small" data-page="${offset + 50}" ${!data.hasMore ? "disabled" : ""}>Next</button></div></div>`;
  } catch (e) {
    target.innerHTML = `<div class="error-panel" role="alert"><h3>Couldn’t load this table.</h3><p>${esc(e.message)}</p><button class="button" data-action="retry-records">Try again</button></div>`;
  }
}
async function storage() {
  const buckets = await api("buckets");
  if (state.view !== "storage") return;
  document.querySelector("#main").innerHTML =
    heading(
      "A place for every object.",
      "Project buckets on your shared, S3-compatible storage.",
      `<a class="button" href="http://${esc(state.overview.host)}:9101" target="_blank" rel="noopener">Open MinIO ${icon("arrow")}</a>`,
    ) +
    `<section class="panel"><div class="panel-heading">${search("Find a bucket")}<span class="subtle">${buckets.length} buckets</span></div><div class="table-wrap"><table><thead><tr><th>Bucket</th><th>Created</th><th>Endpoint</th></tr></thead><tbody>${buckets.map((b) => `<tr data-filter="${esc(b.name)}"><td><span class="inline-icon">${icon("storage")}<strong>${esc(b.name)}</strong></span></td><td>${date(b.creationDate)}</td><td><code>http://${esc(state.overview.host)}:9100/${esc(b.name)}</code></td></tr>`).join("")}</tbody></table></div><div class="filter-empty" hidden>No matching buckets.</div></section><div class="info-note">${icon("storage")} Create a project to provision development and test buckets. Use MinIO to browse and upload objects.</div>`;
  bindFilter();
}
function operations() {
  document.querySelector("#main").innerHTML =
    heading(
      "Keep everything running.",
      "Operational tools live in your shared-infra folder. Run these from your workstation.",
    ) +
    `<section class="panel operation-panel"><div class="panel-heading"><div><h2>The command desk</h2><p><code>shared-infra/</code></p></div>${icon("terminal")}</div>${[
      [
        "make doctor",
        "Check the context, Tailnet ports, disk space and service health.",
      ],
      [
        "make up",
        "Build and start the stack on your devbox, then wait for healthy services.",
      ],
      [
        "make smoke",
        "Check service connectivity and vector operations for ready projects.",
      ],
      [
        "make backup DB=example",
        "Save a PostgreSQL logical backup to the local backups folder.",
      ],
      [
        "make connections PROJECT=example",
        "Print connection settings with credential placeholders.",
      ],
      ["make ps", "Inspect running services and published ports."],
      ["make logs", "Follow service logs."],
    ]
      .map(
        ([cmd, desc]) =>
          `<div class="command-row"><span class="command-icon">${icon("terminal")}</span><div><code>${cmd}</code><p>${desc}</p></div><button class="icon-button" data-copy="${cmd}" aria-label="Copy ${cmd}">${icon("copy")}</button></div>`,
      )
      .join(
        "",
      )}</section><div class="overview-bottom"><section class="panel note-panel"><h2>Shared servers. Separate test runs.</h2><p>Use a unique project name for each parallel test run, such as <code>example_run_42</code>. Provisioning gives it independent databases, buckets and a Redis prefix.</p><p>Use prefixes for Redis keys. Avoid global flush commands on shared Redis.</p></section><section class="panel note-panel"><h2>Designed to stay private.</h2><p>Services bind to the Tailscale address. This dashboard connects directly to services and has no access to the Docker socket.</p><p>Database browsing is read-only. Project creation is recorded in the shared registry.</p></section></div>`;
}
function bindFilter() {
  const input = document.querySelector("#filter");
  if (!input) return;
  const filter = () => {
    state.query = input.value;
    let visible = 0;
    document.querySelectorAll("[data-filter]").forEach((el) => {
      el.hidden = !el.dataset.filter
        .toLowerCase()
        .includes(input.value.toLowerCase());
      if (!el.hidden) visible++;
    });
    const empty = document.querySelector(".filter-empty");
    if (empty) empty.hidden = visible > 0;
  };
  input.addEventListener("input", filter);
  filter();
}
async function render() {
  disposeSystem();
  disposeSystem = () => {};
  const seq = ++state.sequence;
  shell();
  document.querySelector("#main").innerHTML =
    '<div class="loading"><span class="spinner"></span> Reading your infrastructure…</div>';
  try {
    if (state.view === "overview") overview();
    else if (state.view === "system")
      disposeSystem = mountSystem({
        main: document.querySelector("#main"),
        api,
        icon,
        openDialog,
      });
    else if (state.view === "tools")
      await mountTools({ main: document.querySelector("#main"), api, icon });
    else if (state.view === "database") await database();
    else if (state.view === "projects") await projects();
    else if (state.view === "storage") await storage();
    else operations();
    if (seq === state.sequence) {
      const updated = document.querySelector("#updated");
      if (updated)
        updated.textContent = `Checked ${date(state.overview.checkedAt)}`;
    }
  } catch (e) {
    if (seq === state.sequence && document.querySelector("#main"))
      document.querySelector("#main").innerHTML =
        `<div class="error-panel" role="alert"><h2>Connection interrupted.</h2><p>${esc(e.message)}</p><button class="button" data-action="refresh">${icon("refresh")} Try again</button></div>`;
  }
}
async function navigate(view) {
  state.view = view;
  state.query = "";
  state.db = null;
  state.table = null;
  state.offset = 0;
  history.replaceState(null, "", `#${view}`);
  await render();
}
function openDialog(content) {
  dialog.innerHTML = content;
  dialog.showModal();
  dialog.querySelector("input:not([readonly])")?.focus();
}
function closeDialog() {
  dialog.close();
  dialog.innerHTML = "";
}
async function connections(name) {
  openDialog(
    '<div class="loading"><span class="spinner"></span> Loading connection settings…</div>',
  );
  try {
    const { text } = await api(
      `connections?project=${encodeURIComponent(name)}`,
    );
    dialog.innerHTML = `<div class="dialog-heading"><div><h2>Connect ${esc(name)}</h2><p>Copy these into your project’s local environment file.</p></div><button class="icon-button" data-action="close" aria-label="Close">${icon("close")}</button></div><div class="dialog-body"><div class="info-note">${icon("lock")} Replace credential placeholders. URL-encode passwords used in connection URLs.</div><pre class="connection-code">${esc(text)}</pre></div><div class="dialog-footer"><button class="button" data-action="close">Done</button><button class="button primary" id="copy-settings">${icon("copy")} Copy settings</button></div>`;
    document
      .querySelector("#copy-settings")
      .addEventListener("click", () => copy(text));
  } catch (e) {
    closeDialog();
    toast(e.message);
  }
}
async function newProject(existing) {
  const p = existing || {};
  openDialog(
    `<form id="project-form"><div class="dialog-heading"><div><h2>${existing ? "Complete project setup" : "Make room for your next idea."}</h2><p>${existing ? "Use the project’s existing database password." : "One project. Everything it needs to get started."}</p></div><button type="button" class="icon-button" data-action="close" aria-label="Close">${icon("close")}</button></div><div class="dialog-body"><label for="project-name">Project name</label><input id="project-name" name="name" value="${esc(p.name || "")}" ${existing ? "readonly" : ""} pattern="[a-z][a-z0-9_]{2,47}" minlength="3" maxlength="48" required placeholder="e.g. orbit"><small class="field-help">Lowercase letters, numbers and underscores. At least 3 characters.</small><label for="project-description">Description <span>optional</span></label><input id="project-description" name="description" value="${esc(p.description || "")}" maxlength="160" placeholder="What are you building?"><label for="project-password">Database password</label><input id="project-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required placeholder="At least 12 characters"><small class="field-help">Save this in your project’s local .env. We don’t store it in the registry.</small><div class="resource-preview"><strong>Included with this project</strong><div>${icon("database")} Development + test databases with pgvector</div><div>${icon("storage")} Separate development + test buckets</div><div>${icon("redis")} A unique Redis key prefix</div></div><p class="form-error" role="alert"></p></div><div class="dialog-footer"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" type="submit">${icon("plus")} ${existing ? "Complete setup" : "Create project"}</button></div></form>`,
  );
  if (existing) {
    const passwordInput = document.querySelector("#project-password");
    passwordInput.minLength = 1;
    passwordInput.placeholder = "Existing project password";
  }
  document
    .querySelector("#project-form")
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const button = form.querySelector("[type=submit]");
      button.disabled = true;
      button.textContent = "Provisioning resources…";
      try {
        const data = { ...p, ...Object.fromEntries(new FormData(form)) };
        const project = await api("projects", {
          method: "POST",
          body: JSON.stringify(data),
        });
        closeDialog();
        toast(`${project.name} is ready.`);
        state.overview = await api("overview");
        await navigate("projects");
        await connections(project.name);
      } catch (error) {
        form.querySelector(".form-error").textContent = error.message;
        button.disabled = false;
        button.textContent = "Retry provisioning";
      }
    });
}
async function copy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext)
      await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement("textarea");
      field.value = text;
      field.className = "clipboard-field";
      (dialog.open ? dialog : document.body).append(field);
      field.select();
      const success = document.execCommand("copy");
      field.remove();
      if (!success) throw Error();
    }
    toast("Copied to clipboard.");
  } catch {
    toast("Copy unavailable. Select the text and copy it manually.");
  }
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest("button,[data-nav]");
  if (!el || el.disabled) return;
  try {
    if (el.dataset.nav) await navigate(el.dataset.nav);
    else if (el.dataset.db) {
      state.db = el.dataset.db;
      state.table = null;
      state.query = "";
      await render();
    } else if (el.dataset.tab) {
      state.tab = el.dataset.tab;
      state.query = "";
      await render();
    } else if (el.dataset.table) {
      state.table = { name: el.dataset.table, schema: el.dataset.schema };
      state.offset = 0;
      document
        .querySelectorAll("[data-table]")
        .forEach((b) => b.classList.toggle("selected", b === el));
      await records();
    } else if (el.dataset.page !== undefined) {
      state.offset = Number(el.dataset.page);
      await records();
    } else if (el.dataset.connection) await connections(el.dataset.connection);
    else if (el.dataset.retry)
      await newProject(
        (await api("projects")).find((p) => p.name === el.dataset.retry),
      );
    else if (el.dataset.copy) await copy(el.dataset.copy);
    else if (el.dataset.faultTarget) {
      const target = el.dataset.faultTarget;
      const select = document.querySelector(`[data-fault-select="${target}"]`);
      el.disabled = true;
      await api("lab/fault", {
        method: "POST",
        body: JSON.stringify({ target, preset: select.value }),
      });
      el.disabled = false;
      toast(`${target} fault profile updated.`);
    } else if (el.dataset.service) {
      const id = el.dataset.service;
      if (id === "postgres") await navigate("database");
      else if (id === "minio") await navigate("storage");
      else if (id === "mailpit")
        window.open(`http://${state.overview.host}:8125`, "_blank", "noopener");
      else {
        const info = await api("redis");
        openDialog(
          `<div class="dialog-heading"><div><h2>Redis</h2><p>Your shared cache and queue server.</p></div><button class="icon-button" data-action="close" aria-label="Close">${icon("close")}</button></div><div class="dialog-body redis-details">${Object.entries(
            info,
          )
            .map(
              ([k, v]) =>
                `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`,
            )
            .join(
              "",
            )}</div><div class="dialog-footer"><button class="button" data-action="close">Done</button></div>`,
        );
      }
    } else if (el.dataset.action === "close") closeDialog();
    else if (el.dataset.action === "new-project") await newProject();
    else if (el.dataset.action === "back-db") {
      state.db = null;
      state.table = null;
      state.query = "";
      await render();
    } else if (el.dataset.action === "retry-records") await records();
    else if (el.dataset.action === "refresh") {
      el.disabled = true;
      state.overview = await api("overview");
      await render();
      toast("Infrastructure refreshed.");
    } else if (el.dataset.action === "logout") {
      await api("logout", { method: "POST", body: "{}" });
      login();
    }
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) &&
    !dialog.open
  ) {
    const filter = document.querySelector("#filter");
    if (filter) {
      e.preventDefault();
      filter.focus();
    }
  }
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      closeDialog();
  }
});
async function boot() {
  try {
    state.overview = await api("overview");
    const view = location.hash.slice(1);
    if (
      [
        "overview",
        "system",
        "tools",
        "database",
        "projects",
        "storage",
        "operations",
      ].includes(view)
    )
      state.view = view;
    await render();
  } catch (error) {
    if (!document.querySelector(".login"))
      root.innerHTML = `<div class="error-panel"><h2>Workspace unavailable.</h2><p>${esc(error.message)}</p><button class="button" data-action="refresh">Try again</button></div>`;
  }
}
await boot();
