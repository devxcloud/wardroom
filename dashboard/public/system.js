const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const percent = (v) => (finite(v) ? `${v.toFixed(1)}%` : "—");
const size = (v) => {
  if (!finite(v)) return "—";
  if (v === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(4, Math.max(0, Math.floor(Math.log(v) / Math.log(1024))));
  return `${(v / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};
const speed = (v) => (finite(v) ? `${size(v)}/s` : "—");
const clock = (v) =>
  new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const duration = (seconds) => {
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600);
  return days
    ? `${days}d ${hours}h`
    : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
};
const gauge = (label, value, detail, note, color) =>
  `<article class="resource-gauge panel"><div><h2>${label}</h2><strong>${detail}</strong><p>${note}</p></div><svg viewBox="0 0 120 100" role="img" aria-label="${label}: ${percent(value)}"><path class="gauge-track" d="M 20 80 A 48 48 0 1 1 100 80" pathLength="100"/><path class="gauge-value ${value > 85 ? "warning" : color}" d="M 20 80 A 48 48 0 1 1 100 80" pathLength="100" stroke-dasharray="${finite(value) ? Math.max(0, Math.min(100, value)) : 0} 100"/><text x="60" y="62" text-anchor="middle">${percent(value)}</text><text class="gauge-caption" x="60" y="79" text-anchor="middle">in use</text></svg></article>`;
const meter = (value, cls = "") =>
  `<svg class="usage-meter ${cls}" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${percent(value)} used"><rect width="100" height="6" rx="3" class="meter-track"/><rect width="${finite(value) ? Math.min(100, Math.max(0, value)) : 0}" height="6" rx="3" class="meter-fill ${value > 85 ? "warning" : ""}"/></svg>`;
const chartConfig = {
  cpu: {
    title: "CPU utilization",
    subtitle: "Whole host · excludes I/O wait",
    keys: ["cpu"],
    labels: ["CPU"],
    unit: percent,
    max: 100,
  },
  memory: {
    title: "Memory pressure",
    subtitle: "Used memory · excludes reclaimable cache",
    keys: ["memory"],
    labels: ["Memory"],
    unit: percent,
    max: 100,
  },
  io: {
    title: "Disk throughput",
    subtitle: "Physical devices · no partition double-counting",
    keys: ["diskRead", "diskWrite"],
    labels: ["Read", "Write"],
    unit: speed,
  },
  network: {
    title: "Network throughput",
    subtitle: "Primary interface",
    keys: ["networkRx", "networkTx"],
    labels: ["Receive", "Transmit"],
    unit: speed,
  },
};

function niceMax(value) {
  if (value <= 0) return 1024;
  const scale = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].find((n) => n * scale >= value) * scale;
}

export function chartMarkup(key, data) {
  const c = chartConfig[key],
    history = data.history;
  const end = new Date(data.serverTime).getTime(),
    start = end - data.windowSeconds * 1000;
  const max =
    c.max ||
    niceMax(
      Math.max(
        0,
        ...history.flatMap((p) => c.keys.map((k) => (finite(p[k]) ? p[k] : 0))),
      ),
    );
  const x = (t) => 50 + ((t - start) / (end - start)) * 500;
  const y = (v) => 158 - (v / max) * 130;
  let content = "";
  for (const factor of [0, 0.5, 1]) {
    const yy = y(max * factor);
    content += `<line class="chart-grid" x1="50" y1="${yy}" x2="550" y2="${yy}"/><text class="chart-axis" x="42" y="${yy + 3}" text-anchor="end">${escape(c.max ? `${max * factor}%` : size(max * factor))}</text>`;
  }
  c.keys.forEach((metric, index) => {
    let segment = [],
      segments = [],
      previous;
    for (const point of history) {
      if (!finite(point[metric]) || point.time < start) {
        if (segment.length) segments.push(segment);
        segment = [];
        previous = null;
        continue;
      }
      if (previous && point.time - previous.time > data.stepSeconds * 2500) {
        if (segment.length) segments.push(segment);
        segment = [];
      }
      segment.push([x(point.time), y(point[metric])]);
      previous = point;
    }
    if (segment.length) segments.push(segment);
    for (const points of segments) {
      const line = points
        .map(
          ([xx, yy], i) => `${i ? "L" : "M"}${xx.toFixed(2)},${yy.toFixed(2)}`,
        )
        .join(" ");
      if (c.keys.length === 1 && points.length > 1)
        content += `<path class="chart-area series-${index}" d="${line} L${points.at(-1)[0]},158 L${points[0][0]},158 Z"/>`;
      content += `<path class="chart-line series-${index}" d="${line}"/>`;
      if (points.length === 1)
        content += `<circle class="chart-dot series-${index}" cx="${points[0][0]}" cy="${points[0][1]}" r="2.5"/>`;
    }
  });
  for (const t of [start, (start + end) / 2, end])
    content += `<text class="chart-axis" x="${x(t)}" y="180" text-anchor="${t === start ? "start" : t === end ? "end" : "middle"}">${clock(t)}</text>`;
  const last = history.at(-1);
  return `<div class="monitor-chart-heading"><div><h2>${c.title}</h2><p>${key === "network" ? `${escape(data.sample?.network.primary || "No default route")} · excludes duplicate Tailnet traffic` : c.subtitle}</p></div><div class="chart-legend">${c.keys.map((k, i) => `<span><i class="legend-dot series-${i}"></i>${c.labels[i]} <strong>${c.unit(last?.[k])}</strong></span>`).join("")}</div></div><div class="chart-body"><svg class="time-chart" data-chart="${key}" viewBox="0 0 568 195" tabindex="0" role="img" aria-label="${c.title} over ${data.range}. Use left and right arrows to inspect samples.">${content}</svg><div class="chart-tooltip" data-tooltip="${key}" hidden></div></div>${!history.some((p) => c.keys.some((k) => finite(p[k]))) ? '<p class="chart-warming">Waiting for a second sample to calculate rates.</p>' : ""}`;
}

export function mountSystem({ main, api, icon, openDialog }) {
  let disposed = false,
    timer,
    pending = false,
    paused = false,
    range = "15m",
    data = null,
    error = null;
  let filter = "",
    containerState = "all",
    sortKey = "cpuPercent",
    sortDirection = -1;
  const controller = new AbortController();
  const events = { signal: controller.signal };
  main.innerHTML = `<div class="page-heading system-heading"><div><h1>Inside your devbox.</h1><p id="system-host-description">A live view of the machine behind your projects.</p></div><div class="system-controls"><div class="range-picker" role="group" aria-label="Chart time range">${["15m", "1h", "24h"].map((r) => `<button data-range="${r}" aria-pressed="${r === range}">${r}</button>`).join("")}</div><button class="button" data-monitor="pause" aria-pressed="false">${icon("clock")} Pause</button></div></div><div class="system-meta"><span id="system-live-state" class="sample-state">Connecting to collector…</span><span id="system-host-meta"></span></div><div id="system-warning" role="status" hidden></div><div id="system-content"><div class="loading"><span class="spinner"></span> Reading host telemetry…</div></div>`;

  function buildContent() {
    main.querySelector("#system-content").innerHTML =
      `<div id="system-gauges" class="system-gauges"></div><div class="system-charts">${Object.keys(
        chartConfig,
      )
        .map(
          (k) =>
            `<section class="panel monitor-chart" id="chart-${k}"></section>`,
        )
        .join(
          "",
        )}</div><div class="system-detail-grid"><section class="panel"><div class="panel-heading"><div><h2>Across the cores</h2><p id="core-caption"></p></div><span class="monitor-symbol">${icon("server")}</span></div><div id="system-cores" class="core-grid"></div><div id="system-load" class="detail-foot"></div></section><section class="panel"><div class="panel-heading"><div><h2>Filesystem capacity</h2><p>Mounted disks · used, reserved, available</p></div>${icon("storage")}</div><div id="system-disks" class="filesystem-list"></div></section></div><section class="panel interface-panel"><div class="panel-heading"><div><h2>Network interfaces</h2><p>Physical and Tailnet traffic shown separately</p></div>${icon("globe")}</div><div class="table-wrap"><table><thead><tr><th>Interface</th><th>Receive / s</th><th>Transmit / s</th><th>Total received</th><th>Total sent</th></tr></thead><tbody id="system-interfaces"></tbody></table></div></section><section class="panel container-panel"><div class="panel-heading"><div><h2>Containers <span id="container-count" class="count"></span></h2><p>Everything on your devbox, including other stacks</p></div><div class="container-controls"><label class="search">${icon("search")}<input id="filter" type="search" aria-label="Find a container" placeholder="Find a container"><kbd>/</kbd></label><select id="container-state" aria-label="Filter container state"><option value="all">All states</option><option value="running">Running</option><option value="stopped">Not running</option></select></div></div><div class="table-wrap"><table class="container-table"><thead><tr>${[
        ["name", "Container"],
        ["state", "State"],
        ["cpuPercent", "CPU"],
        ["memoryBytes", "Memory"],
        ["networkRxBytes", "Network I/O"],
        ["readBytes", "Block I/O"],
        ["pids", "PIDs"],
      ]
        .map(
          ([k, label]) =>
            `<th data-sort-heading="${k}"><button data-sort="${k}">${label}<span aria-hidden="true"></span></button></th>`,
        )
        .join(
          "",
        )}</tr></thead><tbody id="container-rows"></tbody></table></div><div id="container-empty" class="filter-empty" hidden></div><div class="detail-foot container-foot"><span>CPU: 100% = one logical core. Memory excludes cache.</span><span>Network & block I/O are cumulative totals.</span></div></section>`;
    main.querySelector("#filter").value = filter;
    main.querySelector("#container-state").value = containerState;
  }

  function status() {
    const el = main.querySelector("#system-live-state");
    if (!el) return;
    const stale =
      !data?.receivedAt ||
      Date.now() - new Date(data.receivedAt).getTime() > 35000;
    el.className = `sample-state ${error || stale ? "stale" : ""}`;
    el.textContent = paused
      ? "Paused · showing the last sample"
      : error
        ? "Connection interrupted"
        : stale
          ? "Collector offline or waiting"
          : `Live · every 10 seconds · ${new Date(data.receivedAt).toLocaleTimeString()}`;
    const warning = main.querySelector("#system-warning");
    warning.hidden = !(error || (data?.sample && stale && !paused));
    warning.textContent =
      error ||
      "The collector has not reported in over 35 seconds. Last known values are shown; check the telemetry service on your devbox.";
  }

  function containers() {
    const d = data.sample.docker,
      body = main.querySelector("#container-rows");
    const items = d.items
      .filter(
        (c) =>
          `${c.name} ${c.image}`.toLowerCase().includes(filter.toLowerCase()) &&
          (containerState === "all" ||
            (containerState === "running"
              ? c.state === "running"
              : c.state !== "running")),
      )
      .sort((a, b) => {
        if (a[sortKey] === null) return b[sortKey] === null ? 0 : 1;
        if (b[sortKey] === null) return -1;
        return (
          sortDirection *
          (typeof a[sortKey] === "string"
            ? a[sortKey].localeCompare(b[sortKey])
            : a[sortKey] - b[sortKey])
        );
      });
    const running = d.items.filter((c) => c.state === "running").length;
    main.querySelector("#container-count").textContent = d.available
      ? `${running} running / ${d.items.length} total`
      : "Unavailable";
    body.innerHTML = items
      .map(
        (c) =>
          `<tr><td><button class="container-name" data-container="${escape(c.id)}">${icon("server")}<strong>${escape(c.name)}</strong></button><small title="${escape(c.image)}">${escape(c.image)}</small></td><td><span class="container-state ${c.state === "running" ? "running" : ""}"><i></i>${escape(c.state)}</span><small>${escape(c.status)}</small></td><td><span class="resource-number">${percent(c.cpuPercent)}</span>${meter(finite(c.cpuPercent) ? c.cpuPercent / data.sample.host.cores : null, "cpu-meter")}</td><td><span class="resource-number">${size(c.memoryBytes)}</span>${meter(c.memoryLimitBytes ? (c.memoryBytes / c.memoryLimitBytes) * 100 : null)}<small>of ${size(c.memoryLimitBytes)}</small></td><td><span class="io-number">↓ ${size(c.networkRxBytes)}</span><small>↑ ${size(c.networkTxBytes)}</small></td><td><span class="io-number">R ${size(c.readBytes)}</span><small>W ${size(c.writeBytes)}</small></td><td class="numeric">${c.pids ?? "—"}</td></tr>`,
      )
      .join("");
    const empty = main.querySelector("#container-empty");
    empty.hidden = items.length > 0;
    empty.textContent = !d.available
      ? "Docker inventory is unavailable. Host metrics are still being collected."
      : filter || containerState !== "all"
        ? "No containers match these filters."
        : "No containers on this host.";
    main.querySelectorAll("[data-sort-heading]").forEach((th) => {
      const active = th.dataset.sortHeading === sortKey;
      th.setAttribute(
        "aria-sort",
        active ? (sortDirection === 1 ? "ascending" : "descending") : "none",
      );
      th.querySelector("span").textContent = active
        ? sortDirection === 1
          ? " ↑"
          : " ↓"
        : "";
    });
    if (d.available && !d.statsAvailable) {
      empty.hidden = false;
      empty.textContent =
        "Docker inventory is available, but resource statistics could not be collected. Missing values are shown as —.";
    }
    if (d.truncated) {
      empty.hidden = false;
      empty.textContent =
        "Showing the first 128 containers; running containers are prioritized.";
    }
  }

  function render() {
    status();
    if (!data?.sample) {
      main.querySelector("#system-content").innerHTML =
        `<section class="panel telemetry-empty"><span class="monitor-symbol">${icon("server")}</span><h2>Waiting for the first host sample.</h2><p>Install the collector from the shared-infra folder:</p><code>make telemetry</code><p>This view will update automatically when your devbox starts reporting.</p><button class="button" data-monitor="retry">Check again</button></section>`;
      return;
    }
    if (!main.querySelector("#system-gauges")) buildContent();
    const s = data.sample,
      root = s.storage.find((v) => v.mount === "/");
    main.querySelector("#system-host-description").textContent =
      `${s.host.cpuModel} · ${s.host.cores} logical cores`;
    main.querySelector("#system-host-meta").textContent =
      `${s.host.os} · Up ${duration(s.host.uptimeSeconds)}`;
    main.querySelector("#system-gauges").innerHTML =
      gauge(
        "Processor",
        s.cpu.percent,
        `${s.host.cores} logical cores`,
        `I/O wait ${percent(s.cpu.iowaitPercent)}`,
        "cobalt",
      ) +
      gauge(
        "Memory",
        s.memory.usedPercent,
        `${size(s.memory.usedBytes)} of ${size(s.memory.totalBytes)}`,
        `${size(s.memory.availableBytes)} available`,
        "teal",
      ) +
      gauge(
        "Root filesystem",
        root?.usedPercent,
        root
          ? `${size(root.usedBytes)} of ${size(root.totalBytes)}`
          : "Not reported",
        root
          ? `${size(root.availableBytes)} available on /`
          : "No root filesystem sample",
        "violet",
      );
    const focused = document.activeElement?.dataset.chart;
    for (const key of Object.keys(chartConfig))
      main.querySelector(`#chart-${key}`).innerHTML = chartMarkup(key, data);
    if (focused)
      main
        .querySelector(`[data-chart="${focused}"]`)
        ?.focus({ preventScroll: true });
    main.querySelector("#core-caption").textContent =
      `${s.host.cores} logical cores · whole-host CPU ${percent(s.cpu.percent)}`;
    main.querySelector("#system-cores").innerHTML = s.cpu.cores
      .map(
        (c) =>
          `<div class="core-cell"><span>${escape(c.name)}</span>${meter(c.percent)}<strong>${percent(c.percent)}</strong></div>`,
      )
      .join("");
    main.querySelector("#system-load").innerHTML =
      `<span>Load average <strong>${s.cpu.load.map((n) => n.toFixed(2)).join(" / ")}</strong> <small>1 / 5 / 15 min</small></span><span>Swap ${size(s.memory.swapUsedBytes)} / ${size(s.memory.swapTotalBytes)}</span>`;
    main.querySelector("#system-disks").innerHTML =
      s.storage
        .map(
          (v) =>
            `<div class="filesystem-row"><div><strong>${escape(v.mount)}</strong><span>${size(v.availableBytes)} available</span></div><svg class="filesystem-meter" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${escape(v.mount)} ${percent(v.usedPercent)} used"><rect width="100" height="8" rx="4" class="meter-track"/><rect width="${v.usedPercent}" height="8" rx="4" class="meter-fill ${v.usedPercent > 85 ? "warning" : ""}"/><rect x="${v.usedPercent}" width="${(v.reservedBytes / v.totalBytes) * 100}" height="8" class="meter-reserved"/></svg><div><small>${escape(v.device)} · ${escape(v.fs)}</small><small>${size(v.usedBytes)} / ${size(v.totalBytes)}</small></div></div>`,
        )
        .join("") ||
      '<p class="padded subtle">No supported mounted filesystems reported.</p>';
    main.querySelector("#system-interfaces").innerHTML = s.network.interfaces
      .map(
        (i) =>
          `<tr><td><strong>${escape(i.name)}</strong> ${i.name === s.network.primary ? '<span class="mini-tag">primary</span>' : ""}</td><td class="numeric">${speed(i.rxBytesPerSecond)}</td><td class="numeric">${speed(i.txBytesPerSecond)}</td><td class="numeric">${size(i.rxBytes)}</td><td class="numeric">${size(i.txBytes)}</td></tr>`,
      )
      .join("");
    containers();
  }

  async function refresh() {
    if (disposed || pending || paused) return;
    pending = true;
    const requestedRange = range;
    try {
      const fresh = await api(`system?range=${range}`);
      if (disposed || paused || requestedRange !== range) return;
      data = fresh;
      error = null;
      render();
    } catch (e) {
      if (!disposed) {
        error = e.message;
        status();
        if (!data)
          main.querySelector("#system-content").innerHTML =
            '<div class="error-panel"><h2>Host metrics are unavailable.</h2><p>The dashboard will retry automatically.</p><button class="button" data-monitor="retry">Try again</button></div>';
      }
    } finally {
      pending = false;
      if (!disposed) {
        clearTimeout(timer);
        timer = setTimeout(refresh, requestedRange !== range ? 0 : 10000);
      }
    }
  }

  function inspectChart(svg, index) {
    if (!data?.history.length) return;
    const key = svg.dataset.chart,
      c = chartConfig[key],
      i = Math.max(0, Math.min(data.history.length - 1, index));
    svg.dataset.index = i;
    const p = data.history[i],
      tooltip = main.querySelector(`[data-tooltip="${key}"]`);
    tooltip.hidden = false;
    tooltip.innerHTML = `<time>${new Date(p.time).toLocaleTimeString()}</time>${c.keys.map((k, j) => `<span>${c.labels[j]} <strong>${c.unit(p[k])}</strong></span>`).join("")}`;
  }

  main.addEventListener(
    "click",
    (e) => {
      const button = e.target.closest("button");
      if (!button) return;
      if (button.dataset.range) {
        range = button.dataset.range;
        main
          .querySelectorAll("[data-range]")
          .forEach((b) => b.setAttribute("aria-pressed", b === button));
        paused = false;
        main.querySelector('[data-monitor="pause"]').textContent = "Pause";
        main
          .querySelector('[data-monitor="pause"]')
          .setAttribute("aria-pressed", "false");
        refresh();
      }
      if (button.dataset.monitor === "pause") {
        paused = !paused;
        button.setAttribute("aria-pressed", String(paused));
        button.textContent = paused ? "Resume live" : "Pause";
        status();
        if (!paused) refresh();
      }
      if (button.dataset.monitor === "retry") {
        paused = false;
        refresh();
      }
      if (button.dataset.sort) {
        sortDirection =
          sortKey === button.dataset.sort
            ? -sortDirection
            : ["name", "state"].includes(button.dataset.sort)
              ? 1
              : -1;
        sortKey = button.dataset.sort;
        containers();
      }
      if (button.dataset.container) {
        const c = data.sample.docker.items.find(
          (c) => c.id === button.dataset.container,
        );
        if (!c) return;
        openDialog(
          `<div class="dialog-heading"><div><h2>${escape(c.name)}</h2><p>${escape(c.status)}</p></div><button class="icon-button" data-action="close" aria-label="Close">${icon("close")}</button></div><div class="dialog-body container-details"><dl>${[
            ["Image", c.image],
            ["Container ID", c.id],
            ["Published ports", c.ports || "No published ports"],
            ["CPU", `${percent(c.cpuPercent)} (100% = one core)`],
            ["Memory", `${size(c.memoryBytes)} / ${size(c.memoryLimitBytes)}`],
            [
              "Received / sent",
              `${size(c.networkRxBytes)} / ${size(c.networkTxBytes)}`,
            ],
            [
              "Block read / write",
              `${size(c.readBytes)} / ${size(c.writeBytes)}`,
            ],
            ["Processes / threads", c.pids ?? "—"],
          ]
            .map(([k, v]) => `<dt>${k}</dt><dd>${escape(v)}</dd>`)
            .join(
              "",
            )}</dl><p class="subtle">Snapshot from ${new Date(data.receivedAt).toLocaleTimeString()}. Container controls remain in the CLI.</p></div><div class="dialog-footer"><button class="button" data-action="close">Done</button></div>`,
        );
      }
    },
    events,
  );
  main.addEventListener(
    "input",
    (e) => {
      if (e.target.id === "filter") {
        filter = e.target.value;
        containers();
      }
    },
    events,
  );
  main.addEventListener(
    "change",
    (e) => {
      if (e.target.id === "container-state") {
        containerState = e.target.value;
        containers();
      }
    },
    events,
  );
  main.addEventListener(
    "pointermove",
    (e) => {
      const svg = e.target.closest("[data-chart]");
      if (!svg || !data?.history.length) return;
      const r = svg.getBoundingClientRect(),
        ratio = (((e.clientX - r.left) / r.width) * 568 - 50) / 500;
      const t =
        new Date(data.serverTime).getTime() -
        data.windowSeconds * 1000 * (1 - ratio);
      let closest = 0;
      data.history.forEach((p, i) => {
        if (Math.abs(p.time - t) < Math.abs(data.history[closest].time - t))
          closest = i;
      });
      inspectChart(svg, closest);
    },
    events,
  );
  main.addEventListener(
    "pointerout",
    (e) => {
      const svg = e.target.closest("[data-chart]");
      if (svg && !svg.contains(e.relatedTarget))
        main.querySelector(`[data-tooltip="${svg.dataset.chart}"]`).hidden =
          true;
    },
    events,
  );
  main.addEventListener(
    "keydown",
    (e) => {
      const svg = e.target.closest("[data-chart]");
      if (!svg || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
        return;
      e.preventDefault();
      const i = Number(svg.dataset.index ?? data.history.length - 1);
      inspectChart(
        svg,
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? data.history.length - 1
            : i + (e.key === "ArrowRight" ? 1 : -1),
      );
    },
    events,
  );
  const freshness = setInterval(status, 1000);
  refresh();
  return () => {
    disposed = true;
    controller.abort();
    clearTimeout(timer);
    clearInterval(freshness);
  };
}
