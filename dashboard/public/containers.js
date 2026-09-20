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
const meter = (value, cls = "") =>
  `<svg class="usage-meter ${cls}" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${percent(value)} used"><rect width="100" height="6" rx="3" class="meter-track"/><rect width="${finite(value) ? Math.min(100, Math.max(0, value)) : 0}" height="6" rx="3" class="meter-fill ${value > 85 ? "warning" : ""}"/></svg>`;
const controlPlaneName =
  /^shared-infra-(dashboard|gateway|agent-broker|host-broker|docker-proxy)(?:-\d+)?$/;

export function mountContainers({
  main,
  api,
  icon,
  openDialog,
  toast = () => {},
}) {
  let disposed = false,
    timer,
    pending = false,
    data = null,
    error = null,
    filter = "",
    containerState = "all",
    sortKey = "cpuPercent",
    sortDirection = -1,
    volumes = { volumes: [], loaded: false },
    networks = { networks: [], loaded: false };
  const controller = new AbortController();
  const events = { signal: controller.signal };
  main.innerHTML = `<div class="page-heading system-heading"><div><h1>Containers, volumes and networks.</h1><p>Everything running on this host, including other stacks.</p></div></div><div class="system-meta"><span id="runtime-live-state" class="sample-state">Connecting to collector…</span><span id="runtime-host-meta"></span></div><div id="runtime-warning" role="status" hidden></div><div id="runtime-content"><div class="loading"><span class="spinner"></span> Reading Docker inventory…</div></div>`;

  function buildContent() {
    main.querySelector("#runtime-content").innerHTML =
      `<section class="panel container-panel"><div class="panel-heading"><div><h2>Containers <span id="container-count" class="count"></span></h2><p>Start, stop and delete from a container’s details. Control-plane services stay protected.</p></div><div class="container-controls"><label class="search">${icon("search")}<input id="filter" type="search" aria-label="Find a container" placeholder="Find a container"><kbd>/</kbd></label><select id="container-state" aria-label="Filter container state"><option value="all">All states</option><option value="running">Running</option><option value="stopped">Not running</option></select></div></div><div class="table-wrap"><table class="container-table"><thead><tr>${[
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
        )}</tr></thead><tbody id="container-rows"></tbody></table></div><div id="container-empty" class="filter-empty" hidden></div><div class="detail-foot container-foot"><span>CPU: 100% = one logical core. Memory excludes cache.</span><span>Network and block I/O are cumulative totals.</span></div></section><section class="panel volume-panel"><div class="panel-heading"><div><h2>Docker volumes <span id="volume-count" class="count"></span></h2><p>Named volumes on this host · Wardroom data volumes stay protected</p></div><form id="volume-form" class="volume-form"><label class="visually-hidden" for="volume-name">Volume name</label><input id="volume-name" name="name" required maxlength="63" pattern="[A-Za-z0-9][A-Za-z0-9_.-]*" placeholder="my-volume" autocomplete="off"><button class="button small" type="submit">Create</button></form></div><div class="table-wrap"><table><thead><tr><th>Volume</th><th>Driver</th><th>Size</th><th></th></tr></thead><tbody id="volume-rows"></tbody></table></div><div id="volume-empty" class="filter-empty" hidden></div></section><section class="panel volume-panel"><div class="panel-heading"><div><h2>Docker networks <span id="network-count" class="count"></span></h2><p>User networks on this host · built-in and Wardroom networks stay protected</p></div><form id="network-form" class="volume-form"><label class="visually-hidden" for="network-name">Network name</label><input id="network-name" name="name" required maxlength="63" pattern="[A-Za-z0-9][A-Za-z0-9_.-]*" placeholder="lab-net" autocomplete="off"><button class="button small" type="submit">Create</button></form></div><div class="table-wrap"><table><thead><tr><th>Network</th><th>Driver</th><th>Subnet</th><th></th></tr></thead><tbody id="network-rows"></tbody></table></div><div id="network-empty" class="filter-empty" hidden></div></section>`;
    main.querySelector("#filter").value = filter;
    main.querySelector("#container-state").value = containerState;
  }

  function status() {
    const el = main.querySelector("#runtime-live-state");
    if (!el) return;
    const stale =
      !data?.receivedAt ||
      Date.now() - new Date(data.receivedAt).getTime() > 35000;
    el.className = `sample-state ${error || stale ? "stale" : ""}`;
    el.textContent = error
      ? "Connection interrupted"
      : stale
        ? "Collector offline or waiting"
        : `Live · every 10 seconds · ${new Date(data.receivedAt).toLocaleTimeString()}`;
    const warning = main.querySelector("#runtime-warning");
    warning.hidden = !(error || (data?.sample && stale));
    warning.textContent =
      error ||
      "The collector has not reported in over 35 seconds. Last known values are shown.";
  }

  function containers() {
    const d = data.sample.docker,
      body = main.querySelector("#container-rows");
    if (!body) return;
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

  function renderVolumes() {
    const body = main.querySelector("#volume-rows");
    if (!body) return;
    const items = volumes.volumes || [];
    const count = main.querySelector("#volume-count");
    if (count)
      count.textContent = !volumes.loaded
        ? ""
        : volumes.error
          ? "Unavailable"
          : String(items.length);
    body.innerHTML = items
      .map(
        (v) =>
          `<tr><td><strong>${escape(v.name)}</strong>${v.protected ? ' <span class="mini-tag">protected</span>' : ""}</td><td>${escape(v.driver || "local")}</td><td class="numeric">${size(v.sizeBytes)}</td><td>${v.protected ? "" : `<button class="button small" data-volume-remove="${escape(v.name)}">Remove</button>`}</td></tr>`,
      )
      .join("");
    const empty = main.querySelector("#volume-empty");
    empty.hidden = !volumes.loaded || (items.length > 0 && !volumes.error);
    empty.textContent = volumes.error
      ? volumes.error
      : "No Docker volumes reported.";
  }

  async function loadVolumes() {
    try {
      volumes = { ...(await api("volumes")), loaded: true };
    } catch (e) {
      volumes = { volumes: [], error: e.message, loaded: true };
    }
    if (!disposed) renderVolumes();
  }

  function renderNetworks() {
    const body = main.querySelector("#network-rows");
    if (!body) return;
    const items = networks.networks || [];
    const count = main.querySelector("#network-count");
    if (count)
      count.textContent = !networks.loaded
        ? ""
        : networks.error
          ? "Unavailable"
          : String(items.length);
    body.innerHTML = items
      .map(
        (n) =>
          `<tr><td><strong>${escape(n.name)}</strong>${n.protected ? ' <span class="mini-tag">protected</span>' : ""}${n.internal ? ' <span class="mini-tag">internal</span>' : ""}</td><td>${escape(n.driver)}</td><td>${escape(n.subnet || "—")}</td><td>${n.protected ? "" : `<button class="button small" data-network-remove="${escape(n.name)}">Remove</button>`}</td></tr>`,
      )
      .join("");
    const empty = main.querySelector("#network-empty");
    empty.hidden = !networks.loaded || (items.length > 0 && !networks.error);
    empty.textContent = networks.error
      ? networks.error
      : "No Docker networks reported.";
  }

  async function loadNetworks() {
    try {
      networks = { ...(await api("networks")), loaded: true };
    } catch (e) {
      networks = { networks: [], error: e.message, loaded: true };
    }
    if (!disposed) renderNetworks();
  }

  function render() {
    status();
    if (!data?.sample) {
      main.querySelector("#runtime-content").innerHTML =
        `<section class="panel telemetry-empty"><span class="monitor-symbol">${icon("server")}</span><h2>Waiting for the first host sample.</h2><p>Install the collector from the shared-infra folder:</p><code>make telemetry</code><p>This view will update automatically when your devbox starts reporting.</p><button class="button" data-monitor="retry">Check again</button></section>`;
      return;
    }
    if (!main.querySelector("#container-rows")) {
      buildContent();
      loadVolumes();
      loadNetworks();
    }
    const s = data.sample;
    main.querySelector("#runtime-host-meta").textContent =
      `${s.host.os} · ${s.host.cores} logical cores`;
    containers();
    renderVolumes();
    renderNetworks();
  }

  async function runContainer(action, name) {
    try {
      await api("containers", {
        method: "POST",
        body: JSON.stringify({ action, name }),
      });
      toast(
        action === "remove"
          ? `Deleted ${name}.`
          : `${action.charAt(0).toUpperCase()}${action.slice(1)} sent for ${name}.`,
      );
      document.querySelector("#dialog")?.close();
      refresh();
    } catch (e) {
      toast(e.message);
    }
  }

  async function refresh() {
    if (disposed || pending) return;
    pending = true;
    try {
      const fresh = await api("system?range=15m");
      if (disposed) return;
      data = fresh;
      error = null;
      render();
    } catch (e) {
      if (!disposed) {
        error = e.message;
        status();
        if (!data)
          main.querySelector("#runtime-content").innerHTML =
            '<div class="error-panel"><h2>Docker inventory is unavailable.</h2><p>The dashboard will retry automatically.</p><button class="button" data-monitor="retry">Try again</button></div>';
      }
    } finally {
      pending = false;
      if (!disposed) {
        clearTimeout(timer);
        timer = setTimeout(refresh, 10000);
      }
    }
  }

  main.addEventListener(
    "click",
    (e) => {
      const button = e.target.closest("button");
      if (!button) return;
      if (button.dataset.monitor === "retry") refresh();
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
          (item) => item.id === button.dataset.container,
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
            )}</dl><p class="subtle">Snapshot from ${new Date(data.receivedAt).toLocaleTimeString()}. Wardroom control-plane containers cannot be stopped or deleted.</p></div><div class="dialog-footer container-actions"><button class="button" data-action="close">Done</button>${
              controlPlaneName.test(String(c.name || "").replace(/^\//, ""))
                ? ""
                : c.state === "running"
                  ? `<button class="button" data-container-action="stop" data-container-name="${escape(c.name)}">Stop</button><button class="button" data-container-action="restart" data-container-name="${escape(c.name)}">Restart</button>`
                  : `<button class="button" data-container-action="start" data-container-name="${escape(c.name)}">Start</button><button class="button danger" data-container-action="remove" data-container-name="${escape(c.name)}">Delete</button>`
            }</div>`,
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
    "submit",
    async (e) => {
      if (e.target.id === "network-form") {
        e.preventDefault();
        const field = e.target.elements.name;
        const name = field.value.trim();
        if (!name) return;
        try {
          await api("networks", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
          field.value = "";
          toast(`Created network ${name}.`);
          await loadNetworks();
        } catch (err) {
          toast(err.message);
        }
        return;
      }
      if (e.target.id !== "volume-form") return;
      e.preventDefault();
      const field = e.target.elements.name;
      const name = field.value.trim();
      if (!name) return;
      try {
        await api("volumes", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        field.value = "";
        toast(`Created volume ${name}.`);
        await loadVolumes();
      } catch (err) {
        toast(err.message);
      }
    },
    events,
  );
  document.addEventListener(
    "click",
    async (e) => {
      const button = e.target.closest("button");
      if (!button || disposed) return;
      if (button.dataset.containerAction) {
        const action = button.dataset.containerAction;
        const name = button.dataset.containerName;
        if (action === "remove" && !confirm(`Delete container ${name}?`))
          return;
        button.disabled = true;
        await runContainer(action, name);
        return;
      }
      if (button.dataset.volumeRemove) {
        const name = button.dataset.volumeRemove;
        if (!confirm(`Remove volume ${name}?`)) return;
        button.disabled = true;
        try {
          await api("volumes/remove", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
          toast(`Removed volume ${name}.`);
          await loadVolumes();
        } catch (err) {
          toast(err.message);
          button.disabled = false;
        }
        return;
      }
      if (button.dataset.networkRemove) {
        const name = button.dataset.networkRemove;
        if (!confirm(`Remove network ${name}?`)) return;
        button.disabled = true;
        try {
          await api("networks/remove", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
          toast(`Removed network ${name}.`);
          await loadNetworks();
        } catch (err) {
          toast(err.message);
          button.disabled = false;
        }
      }
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
