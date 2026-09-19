const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const catalog = {
  api: {
    eyebrow: "BUILD & TEST",
    name: "API workbench",
    copy: "Shape requests, explore responses and keep your API collections together.",
    href: "/api",
    action: "Open Hoppscotch",
    className: "api",
  },
  logs: {
    eyebrow: "OBSERVE",
    name: "Live logs",
    copy: "Follow every container without reaching for a terminal.",
    href: "/logs/",
    action: "Open live logs",
    className: "logs",
  },
  redis: {
    eyebrow: "INSPECT",
    name: "Redis workspace",
    copy: "Browse keys, run commands and understand memory at a glance.",
    href: "/redis/",
    action: "Explore Redis",
    className: "redis",
  },
  traces: {
    eyebrow: "TRACE",
    name: "Request journeys",
    copy: "Send OTLP spans here and see where every millisecond went.",
    href: "/jaeger/",
    action: "Explore traces",
    className: "traces",
  },
};

const stateLabel = (status) =>
  status === "healthy"
    ? "Ready"
    : status === "inactive"
      ? "Parked"
      : "Needs attention";

export function toolsMarkup(data, icon) {
  const tools = data.tools
    .map((tool, index) => {
      const item = catalog[tool.id];
      return `<article class="tool-card tool-${item.className}" style="--order:${index}"><div class="tool-orbit"><span></span><i></i></div><div class="tool-card-top"><span class="tool-index">0${index + 1}</span><span class="tool-state ${escape(tool.status)}"><i></i>${stateLabel(tool.status)}</span></div><span class="tool-eyebrow">${item.eyebrow}</span><h2>${item.name}</h2><p>${item.copy}</p><small>${escape(tool.detail)}</small><a class="tool-launch" href="${item.href}" target="_blank" rel="noopener">${item.action} ${icon("arrow")}</a></article>`;
    })
    .join("");
  const connections = [
    ["OTLP / gRPC", data.connections.otlpGrpc],
    ["OTLP / HTTP", data.connections.otlpHttp],
  ];
  const proxies = [
    ["PostgreSQL", data.connections.postgresProxy],
    ["Redis", data.connections.redisProxy],
    ["MinIO", data.connections.minioProxy],
  ];
  const faultControls = proxies
    .map(
      ([label, value], index) =>
        `<div class="fault-row"><div><strong>${label}</strong><code>${escape(value)}</code></div><select aria-label="${label} fault preset" data-fault-select="${["postgres", "redis", "minio"][index]}"><option value="reset">Healthy</option><option value="latency-500">Delay 500 ms</option><option value="latency-2000">Delay 2 seconds</option><option value="timeout">Timeout</option><option value="disabled">Connection refused</option></select><button class="button small" data-fault-target="${["postgres", "redis", "minio"][index]}">Apply</button></div>`,
    )
    .join("");
  const rows = (items) =>
    items
      .map(
        ([label, value]) =>
          `<div class="connection-row"><span>${label}</span><code>${escape(value)}</code><button class="icon-button" data-copy="${escape(value)}" aria-label="Copy ${label}">${icon("copy")}</button></div>`,
      )
      .join("");
  return `<div class="tools-hero"><div><span class="tool-kicker">THE WORKBENCH</span><h1>Your developer cockpit.</h1><p>Logs, keys and traces—already connected to the machine doing the work.</p></div><div class="signal-mark" aria-hidden="true"><span>SHARED</span><strong>∞</strong><small>WARDROOM</small></div></div><section class="tool-grid" aria-label="Developer tools">${tools}</section><section class="tool-lower"><div class="panel otlp-panel"><div class="panel-heading"><div><span class="tool-kicker">INSTRUMENT</span><h2>Send traces from anything.</h2><p>Point any OpenTelemetry SDK at your devbox. Jaeger keeps development traces in memory.</p></div><span class="pulse-beacon"><i></i></span></div>${rows(connections)}<div class="code-strip"><code>OTEL_EXPORTER_OTLP_ENDPOINT=${escape(data.connections.otlpHttp)}</code><button class="button small" data-copy="OTEL_EXPORTER_OTLP_ENDPOINT=${escape(data.connections.otlpHttp)}">Copy env</button></div></div><div class="panel lab-panel ${data.lab.active ? "active" : "parked"}"><div class="lab-heading"><div><span class="tool-kicker">BREAK THINGS SAFELY</span><h2>${data.lab.active ? "Test lab is live" : "Test lab is parked"}</h2></div><span class="lab-switch"><i></i>${data.lab.active ? "ON" : "OFF"}</span></div><p>Mock third-party APIs and inject latency or outages between your app and shared services.</p><div class="lab-services"><span><i class="${escape(data.lab.wiremock)}"></i>WireMock</span><span><i class="${escape(data.lab.toxiproxy)}"></i>Toxiproxy</span></div>${data.lab.active ? `<div class="fault-list">${faultControls}</div><a class="button" href="/mock/__admin/" target="_blank" rel="noopener">Open mock API ${icon("arrow")}</a>` : `<div class="lab-command"><span>Start only when you need it</span><code>make lab-up</code><button class="icon-button" data-copy="make lab-up" aria-label="Copy make lab-up">${icon("copy")}</button></div>`}</div></section>`;
}

export async function mountTools({ main, api, icon }) {
  main.innerHTML =
    '<div class="loading"><span class="spinner"></span> Preparing your workbench…</div>';
  const data = await api("tools");
  main.innerHTML = toolsMarkup(data, icon);
}
