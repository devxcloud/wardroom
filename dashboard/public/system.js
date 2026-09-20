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

export function mountSystem({ main, api, icon, openDialog, toast = () => {} }) {
  let disposed = false,
    timer,
    pending = false,
    paused = false,
    range = "15m",
    data = null,
    error = null;
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
        )}</div><div class="system-detail-grid"><section class="panel"><div class="panel-heading"><div><h2>Across the cores</h2><p id="core-caption"></p></div><span class="monitor-symbol">${icon("server")}</span></div><div id="system-cores" class="core-grid"></div><div id="system-load" class="detail-foot"></div></section><section class="panel"><div class="panel-heading"><div><h2>Filesystem capacity</h2><p>Mounted filesystems · not volume-group free space</p></div>${icon("storage")}</div><div id="system-disks" class="filesystem-list"></div></section></div><section class="panel lvm-panel" id="system-lvm-panel" hidden><div class="panel-heading"><div><h2>LVM volume groups</h2><p>Unallocated extents · separate from filesystem free space</p></div>${icon("storage")}</div><div id="system-lvm" class="filesystem-list"></div></section><section class="panel interface-panel"><div class="panel-heading"><div><h2>Network interfaces</h2><p>Physical and Tailnet traffic shown separately</p></div>${icon("globe")}</div><div class="table-wrap"><table><thead><tr><th>Interface</th><th>Receive / s</th><th>Transmit / s</th><th>Total received</th><th>Total sent</th></tr></thead><tbody id="system-interfaces"></tbody></table></div></section>`;
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
    const groups = s.lvm?.available ? s.lvm.volumeGroups : [];
    const lvmPanel = main.querySelector("#system-lvm-panel");
    lvmPanel.hidden = !groups.length;
    const lvmRoot = main.querySelector("#system-lvm");
    const drafts = {};
    lvmRoot.querySelectorAll("form.lvm-grow").forEach((form) => {
      const input = form.elements.sizeGiB;
      if (!input) return;
      drafts[`${form.dataset.vg}/${form.dataset.lv}`] = {
        value: input.value,
        focused: document.activeElement === input,
      };
    });
    lvmRoot.innerHTML = groups
      .map((g) => {
        const allocated = g.sizeBytes
          ? Math.max(0, Math.min(100, (100 * g.allocatedBytes) / g.sizeBytes))
          : 0;
        const pvs = (s.lvm.physicalVolumes || [])
          .filter((p) => p.vg === g.name)
          .map((p) => p.name)
          .join(", ");
        const lvs = (s.lvm.logicalVolumes || []).filter((l) => l.vg === g.name);
        return `<div class="filesystem-row"><div><strong>${escape(g.name)}</strong><span>${size(g.freeBytes)} unallocated</span></div><svg class="filesystem-meter" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${escape(g.name)} ${percent(allocated)} allocated"><rect width="100" height="8" rx="4" class="meter-track"/><rect width="${allocated}" height="8" rx="4" class="meter-fill ${allocated > 85 ? "warning" : ""}"/></svg><div><small>${g.pvCount} PV${g.pvCount === 1 ? "" : "s"}${pvs ? ` · ${escape(pvs)}` : ""} · ${g.lvCount} LV${g.lvCount === 1 ? "" : "s"}</small><small>${size(g.allocatedBytes)} allocated / ${size(g.sizeBytes)}</small></div>${
          lvs.length
            ? `<ul class="lvm-lvs">${lvs
                .map(
                  (l) =>
                    `<li><span>${escape(l.name)}</span><small>${escape(l.device)}</small><strong>${size(l.sizeBytes)}</strong><form class="lvm-grow" data-vg="${escape(g.name)}" data-lv="${escape(l.name)}"><label class="visually-hidden" for="lvm-${escape(g.name)}-${escape(l.name)}">New size in GiB</label><input id="lvm-${escape(g.name)}-${escape(l.name)}" name="sizeGiB" type="number" min="${Math.ceil(l.sizeBytes / 1024 ** 3) + 1}" step="1" required placeholder="GiB"><button class="button small" type="submit">Grow</button></form></li>`,
                )
                .join("")}</ul>`
            : ""
        }</div>`;
      })
      .join("");
    lvmRoot.querySelectorAll("form.lvm-grow").forEach((form) => {
      const draft = drafts[`${form.dataset.vg}/${form.dataset.lv}`];
      if (!draft) return;
      const input = form.elements.sizeGiB;
      input.value = draft.value;
      if (draft.focused) input.focus();
    });
    main.querySelector("#system-interfaces").innerHTML = s.network.interfaces
      .map(
        (i) =>
          `<tr><td><strong>${escape(i.name)}</strong> ${i.name === s.network.primary ? '<span class="mini-tag">primary</span>' : ""}</td><td class="numeric">${speed(i.rxBytesPerSecond)}</td><td class="numeric">${speed(i.txBytesPerSecond)}</td><td class="numeric">${size(i.rxBytes)}</td><td class="numeric">${size(i.txBytes)}</td></tr>`,
      )
      .join("");
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
    },
    events,
  );
  main.addEventListener(
    "submit",
    async (e) => {
      if (!e.target.classList.contains("lvm-grow")) return;
      e.preventDefault();
      const vg = e.target.dataset.vg;
      const lv = e.target.dataset.lv;
      const sizeGiB = Number(e.target.elements.sizeGiB.value);
      if (!vg || !lv || !Number.isInteger(sizeGiB)) return;
      if (!confirm(`Grow ${lv} to ${sizeGiB} GiB? This cannot shrink.`)) return;
      const button = e.target.querySelector("button");
      button.disabled = true;
      try {
        await api("lvm/extend", {
          method: "POST",
          body: JSON.stringify({ vg, lv, sizeGiB }),
        });
        toast(`Grew ${lv} to ${sizeGiB} GiB.`);
        refresh();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
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
