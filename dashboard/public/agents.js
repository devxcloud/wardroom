const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const tokenCommand = "export WARDROOM_MCP_TOKEN='YOUR_TOKEN'";
const downloadCommand =
  'export WARDROOM_MCP_TOKEN="$(node -p \'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token\' /path/to/wardroom-token.json)"';

export function clientInstall(client, url) {
  const setup = clientSetup(client, url);
  if (client === "claude") {
    const entry = JSON.parse(setup.code).mcpServers.wardroom;
    return {
      command: `claude mcp add-json --scope user wardroom ${quote(JSON.stringify(entry))}`,
      config: setup.code,
      destination:
        "Merge into .mcp.json, or use the install command for user scope.",
    };
  }
  if (client === "codex")
    return {
      command: setup.code,
      config: `[mcp_servers.wardroom]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "WARDROOM_MCP_TOKEN"`,
      destination: "Manual config: ~/.codex/config.toml",
    };
  if (client === "grok")
    return {
      command: setup.code,
      config: setup.code,
      destination:
        "Use the CLI to write ~/.grok/config.toml. The command below is the supported setup method.",
    };
  return {
    command: setup.code,
    config: setup.code,
    destination: "Enter these values in your client's MCP settings.",
  };
}

export function clientSetup(client, url) {
  const endpoint = quote(url);
  if (client === "codex")
    return {
      code: `codex mcp add wardroom --url ${endpoint} --bearer-token-env-var WARDROOM_MCP_TOKEN`,
      note: "Run in your terminal. Codex reads WARDROOM_MCP_TOKEN from its launch environment; restart the client after configuration.",
    };
  if (client === "claude")
    return {
      code: JSON.stringify(
        {
          mcpServers: {
            wardroom: {
              type: "http",
              url,
              headers: { Authorization: "Bearer ${WARDROOM_MCP_TOKEN}" },
            },
          },
        },
        null,
        2,
      ),
      note: "Merge into your project's .mcp.json. Claude Code expands the environment variable when it starts. Use /mcp to check the connection.",
    };
  if (client === "grok")
    return {
      code: `grok mcp add --scope user --transport http wardroom ${endpoint} --header "Authorization: Bearer $WARDROOM_MCP_TOKEN"`,
      note: "Run in your terminal. This stores the resolved token in private ~/.grok/config.toml (and briefly passes it as a process argument). Never use project scope with this command. Verify with grok mcp doctor.",
    };
  return {
    code: `Transport: Streamable HTTP\nURL: ${url}\nAuthorization: Bearer <your Wardroom token>`,
    note: "Use your client's private secret field for the token. Environment-variable syntax differs by client. No OAuth or model-provider API key is required. Your client must be able to reach this devbox.",
  };
}

async function copy(text) {
  if (navigator.clipboard && window.isSecureContext)
    return navigator.clipboard.writeText(text);
  const input = document.createElement("textarea");
  input.value = text;
  input.className = "agent-copy-buffer";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied)
    throw Error(
      "Copy is unavailable here. Select the text and copy it manually.",
    );
}

export async function mountAgents(host, api) {
  host.innerHTML = '<p role="status">Loading agent access…</p>';
  let tokens, connection;
  try {
    [tokens, connection] = await Promise.all([
      api("agent-tokens"),
      api("agent-connection"),
    ]);
  } catch {
    host.innerHTML =
      '<h2>AI &amp; MCP</h2><p>Agent settings could not load.</p><button class="button" data-retry>Retry agent settings</button>';
    host.querySelector("[data-retry]").onclick = () => mountAgents(host, api);
    return;
  }
  if (!host.isConnected) return;
  host.innerHTML = `<header class="agent-page-toolbar"><div><h2>MCP access</h2><p>One endpoint. Access scoped by your token.</p></div><div class="agent-toolbar-actions"><span class="badge">${connection.ready ? "MCP service running" : "MCP service offline"}</span><button class="button primary" data-new-token aria-expanded="false" aria-controls="agent-form">New token</button></div></header>
    ${connection.ready ? "" : '<p class="agent-notice">Start MCP on the devbox with <code>make mcp-up</code>. You can create tokens now; clients can connect once it is running.</p>'}
    <div class="agent-layout"><div class="agent-access">
    <form id="agent-form" hidden><h3>Create an agent token</h3><label>Token label<input name="label" required maxlength="80" placeholder="e.g. My coding agent" autocomplete="off"></label>
    <div class="agent-fields"><label>Access scope<select name="scope"><option value="project">One project</option><option value="admin">Admin · shared infrastructure</option></select></label><label>Expires after<select name="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label></div>
    <label data-project-field>Project name<input name="project" required pattern="[a-z][a-z0-9_]{2,47}" placeholder="myapp" autocomplete="off"><small>Existing or new project; 3–48 lowercase letters, numbers or underscores.</small></label>
    <p data-admin-warning class="agent-notice" hidden>Admin scope can manage every project and inspect shared containers. Issue only to an agent you trust.</p>
    <label class="agent-check"><input type="checkbox" name="destructive"><span>Allow destructive operations<small>Enables SQL, resource deletion, password rotation and, for admins, container actions.</small></span></label>
    <p class="agent-help">Without this option, agents can still provision resources and write individual Redis keys and objects.</p>
    <div class="agent-actions"><button class="button primary" type="submit">Create token</button><button class="button" type="button" data-cancel-token>Cancel</button></div></form>
    <div class="agent-secret" hidden tabindex="-1"><h3>Save your token now</h3><p>It will not be shown again. Keep it out of Git, chat and screenshots.</p><label>New agent token<input readonly autocomplete="off" spellcheck="false"></label><div class="agent-actions"><button class="button" data-secret-copy>Copy token</button><button class="button" data-download>Download token</button><button class="button primary" data-dismiss>I saved it</button></div></div></div>
    <section class="agent-setup" aria-labelledby="agent-connect-heading"><h3 id="agent-connect-heading">MCP endpoint</h3><div class="agent-command"><code>${esc(connection.url)}</code><button class="button small" data-endpoint-copy>Copy endpoint</button></div>
    <div class="agent-tabs" role="tablist" aria-label="AI client">${[
      ["claude", "Claude Code"],
      ["codex", "Codex"],
      ["grok", "Grok Build"],
      ["other", "Other"],
    ]
      .map(
        ([key, label]) =>
          `<button type="button" role="tab" id="client-${key}" data-client="${key}" aria-controls="agent-client-panel" aria-selected="${key === "codex"}" tabindex="${key === "codex" ? "0" : "-1"}">${label}</button>`,
      )
      .join("")}</div>
    <div role="tabpanel" id="agent-client-panel" aria-labelledby="client-codex"><div class="agent-config-heading"><div><h3>Client setup</h3><p id="agent-config-location" class="agent-help"></p></div><div class="agent-actions"><button class="button small" data-config-copy>Copy config</button><button class="button small" data-show-config aria-expanded="false" aria-controls="agent-config">Show config</button></div></div>
    <pre class="agent-code" id="agent-config" tabindex="0" hidden></pre>
    <div class="agent-command"><code id="agent-snippet"></code><button class="button small" data-setup-copy>Copy command</button></div>
    <div class="agent-command"><code>${esc(tokenCommand)}</code><button class="button small" data-env-copy>Copy token setup</button></div>
    <p class="agent-help">Set the token first, then run the install command. Replace YOUR_TOKEN privately; shell history may retain it.</p><details class="agent-details"><summary>Load a downloaded token without typing the secret</summary><div class="agent-command"><code>${esc(downloadCommand)}</code><button class="button small" data-download-command>Copy file command</button></div><p class="agent-help">Replace the file path. Keep the token file outside Git and restart your client with this environment.</p></details><p id="agent-client-note" class="agent-help"></p></div>
    <p class="agent-transport">Use your Tailnet connection. LAN HTTP exposes tokens; never publish this dev gateway.</p></section></div>
    <p class="agent-feedback" role="status" aria-live="polite"></p><section class="agent-tokens" aria-labelledby="agent-tokens-heading"><div class="agent-heading"><h3 id="agent-tokens-heading">Access tokens</h3><div class="agent-actions"><label class="agent-check agent-filter"><input type="checkbox" data-show-inactive><span>Show inactive tokens</span></label><button class="button small" data-refresh>Refresh tokens</button></div></div><div data-token-list></div><small>Newest 100 tokens. Last used means successful authentication. One endpoint; access is determined by the token.</small></section>`;
  const feedback = host.querySelector(".agent-feedback");
  const say = (text) => {
    feedback.textContent = text;
  };
  const form = host.querySelector("form");
  const secret = host.querySelector(".agent-secret");
  let issued = null;
  const date = (value) => (value ? new Date(value).toLocaleString() : "Never");
  const drawTokens = () => {
    const active = (t) => !t.revoked_at && new Date(t.expires_at) > new Date();
    const shown = tokens.filter(
      (t) => host.querySelector("[data-show-inactive]").checked || active(t),
    );
    host.querySelector("[data-token-list]").innerHTML = shown.length
      ? `${shown
          .sort((a, b) => Number(active(b)) - Number(active(a)))
          .map((t) => {
            const status = t.revoked_at
              ? "Revoked"
              : new Date(t.expires_at) <= new Date()
                ? "Expired"
                : "Active";
            return `<article class="agent-token-row" aria-label="${esc(t.label)}"><div><strong>${esc(t.label)}</strong><p>${esc(t.scope === "admin" ? "Admin · all projects" : t.project)} · ${t.destructive ? "Destructive enabled" : "Scoped writes"}</p><small>Last used ${esc(date(t.last_used_at))} · Expires ${esc(date(t.expires_at))}</small><details><summary>Token details</summary><code>${esc(t.id)}</code></details></div><div class="agent-token-action"><span>${status}</span><button class="button small" data-revoke="${esc(t.id)}" ${status !== "Active" ? "disabled" : ""}>Revoke</button></div></article>`;
          })
          .join("")}`
      : '<p class="agent-empty">No active tokens. Create a token to connect an agent, or show inactive tokens.</p>';
  };
  drawTokens();
  host.querySelector("[data-show-inactive]").onchange = drawTokens;
  let selectedClient = "codex";
  const updateClient = () => {
    const setup = clientSetup(selectedClient, connection.url);
    const install = clientInstall(selectedClient, connection.url);
    host.querySelector("#agent-snippet").textContent = install.command;
    host.querySelector("#agent-config").textContent = install.config;
    host.querySelector("#agent-config-location").textContent =
      install.destination;
    host.querySelector("#agent-client-note").textContent = setup.note;
    host
      .querySelector("#agent-client-panel")
      .setAttribute("aria-labelledby", `client-${selectedClient}`);
    host.querySelectorAll("[data-client]").forEach((tab) => {
      const on = tab.dataset.client === selectedClient;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    });
  };
  updateClient();
  host.querySelector("[role=tablist]").onkeydown = (event) => {
    const tabs = [...host.querySelectorAll("[data-client]")];
    const current = tabs.indexOf(document.activeElement);
    if (
      current < 0 ||
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[next].click();
    tabs[next].focus();
  };
  form.elements.scope.onchange = () => {
    const admin = form.elements.scope.value === "admin";
    host.querySelector("[data-project-field]").hidden = admin;
    form.elements.project.required = !admin;
    form.elements.project.disabled = admin;
    host.querySelector("[data-admin-warning]").hidden = !admin;
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    say("Creating token…");
    try {
      const value = {
        label: form.elements.label.value,
        scope: form.elements.scope.value,
        days: Number(form.elements.days.value),
        destructive: form.elements.destructive.checked,
      };
      if (value.scope === "project")
        value.project = form.elements.project.value;
      issued = await api("agent-tokens", {
        method: "POST",
        body: JSON.stringify(value),
      });
      if (!host.isConnected) {
        issued = null;
        return;
      }
      form.hidden = true;
      host.querySelector("[data-new-token]").hidden = true;
      secret.hidden = false;
      secret.querySelector("input").value = issued.token;
      secret.focus();
      const { token, ...metadata } = issued;
      tokens.unshift(metadata);
      drawTokens();
      say("Token created. Save it before leaving this page.");
    } catch (error) {
      say(
        `${error.message} If the response was interrupted, refresh tokens and revoke any token you did not receive before creating another.`,
      );
    } finally {
      button.disabled = false;
    }
  };
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.dataset.client) {
        selectedClient = button.dataset.client;
        updateClient();
      }
      if (button.hasAttribute("data-new-token")) {
        form.hidden = false;
        button.setAttribute("aria-expanded", "true");
        form.elements.label.focus();
      }
      if (button.hasAttribute("data-cancel-token")) {
        form.hidden = true;
        host
          .querySelector("[data-new-token]")
          .setAttribute("aria-expanded", "false");
        host.querySelector("[data-new-token]").focus();
      }
      if (button.hasAttribute("data-show-config")) {
        const config = host.querySelector("#agent-config");
        config.hidden = !config.hidden;
        button.textContent = config.hidden ? "Show config" : "Hide config";
        button.setAttribute("aria-expanded", String(!config.hidden));
      }
      if (button.hasAttribute("data-config-copy")) {
        await copy(host.querySelector("#agent-config").textContent);
        say("Client config copied. No token is included.");
      }
      if (button.hasAttribute("data-endpoint-copy")) {
        await copy(connection.url);
        say("MCP endpoint copied.");
      }
      if (button.hasAttribute("data-env-copy")) {
        await copy(tokenCommand);
        say("Token setup copied with a placeholder, not your secret.");
      }
      if (button.hasAttribute("data-download-command")) {
        await copy(downloadCommand);
        say("File-loading command copied. Replace the file path.");
      }
      if (button.hasAttribute("data-setup-copy")) {
        await copy(host.querySelector("#agent-snippet").textContent);
        say("Client setup copied. No token is included.");
      }
      if (button.hasAttribute("data-secret-copy") && issued) {
        await copy(issued.token);
        say("Token copied. Store it privately.");
      }
      if (button.hasAttribute("data-download") && issued) {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(issued, null, 2) + "\n"], {
            type: "application/json",
          }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "wardroom-token.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        say(
          "Token downloaded. Move it to a private location outside your repository.",
        );
      }
      if (button.hasAttribute("data-dismiss")) {
        issued = null;
        secret.querySelector("input").value = "";
        secret.hidden = true;
        form.hidden = true;
        form.reset();
        form.elements.scope.onchange();
        const create = host.querySelector("[data-new-token]");
        create.hidden = false;
        create.setAttribute("aria-expanded", "false");
        create.focus();
        say("Token hidden. It cannot be retrieved again.");
      }
      if (button.hasAttribute("data-refresh")) {
        button.disabled = true;
        tokens = await api("agent-tokens");
        drawTokens();
        say("Token list refreshed.");
      }
      if (button.dataset.revoke) {
        const t = tokens.find((t) => t.id === button.dataset.revoke);
        if (
          !window.confirm(
            `Revoke “${t.label}”? Its agent will lose access on the next request.`,
          )
        )
          return;
        button.disabled = true;
        await api("agent-tokens/revoke", {
          method: "POST",
          body: JSON.stringify({ id: t.id }),
        });
        t.revoked_at = new Date().toISOString();
        if (issued?.id === t.id) host.querySelector("[data-dismiss]").click();
        drawTokens();
        say("Token revoked.");
      }
    } catch (error) {
      say(error.message);
    } finally {
      button.disabled = false;
    }
  });
}
