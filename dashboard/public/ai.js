import { mountAgents } from "./agents.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export async function mountAi(host, api, { section = "access" } = {}) {
  let cleanup = () => {};
  let activeSection = ["connection", "access"].includes(section)
    ? section
    : "access";
  const shell = () => {
    host.innerHTML = `<div class="ai-tabs" role="navigation" aria-label="AI and MCP sections">
      ${[
        ["connection", "Connection"],
        ["access", "MCP access"],
      ]
        .map(
          ([key, label]) =>
            `<button type="button" data-ai-section="${key}" ${activeSection === key ? 'aria-current="page"' : ""}>${label}</button>`,
        )
        .join("")}
    </div><section class="ai-surface" aria-live="polite"></section>`;
    host.querySelectorAll("[data-ai-section]").forEach((button) =>
      button.addEventListener("click", async () => {
        cleanup();
        activeSection = button.dataset.aiSection;
        history.replaceState(
          null,
          "",
          activeSection === "access" ? "#ai-mcp" : `#ai-mcp/${activeSection}`,
        );
        shell();
        await render();
      }),
    );
  };
  const notice = (message, kind = "") =>
    `<p class="ai-notice ${kind}" role="status">${esc(message)}</p>`;
  const renderConnection = async (surface) => {
    const settings = await api("ai/settings");
    surface.innerHTML = `<div class="ai-section-heading"><div><h2>Model connection</h2><p>Use any endpoint that supports OpenAI-compatible streamed chat and tool calls.</p></div><span class="ai-state ${settings.configured ? "ready" : ""}">${settings.configured ? "Connected" : "Not configured"}</span></div>
      <form class="ai-connection-form"><label>Base URL<input name="baseUrl" type="url" required maxlength="2048" value="${esc(settings.baseUrl || "")}" placeholder="https://api.openai.com/v1"></label>
      <label>Model ID<input name="model" required maxlength="200" value="${esc(settings.model || "")}" placeholder="gpt-5.2"></label>
      <label>API key <span>${settings.hasKey ? "Saved securely · leave blank to keep" : "optional"}</span><input name="apiKey" type="password" maxlength="4096" autocomplete="new-password" placeholder="${settings.hasKey ? "Saved key remains unchanged" : "Provider key"}"></label>
      ${settings.hasKey ? '<label class="ai-check"><input type="checkbox" name="clearKey"> Remove saved key</label>' : ""}
      <label class="ai-check"><input type="checkbox" name="insecureHttp" ${settings.insecureHttp ? "checked" : ""}> Allow unencrypted HTTP for a private development endpoint</label>
      <p class="ai-context-note">The dashboard container makes this request. <code>localhost</code> refers to that container—not your laptop. Testing may be billed by your provider.</p>
      <div class="ai-form-actions"><button class="button primary" type="submit">Save connection</button><button class="button" type="button" data-test-connection>Test connection</button>${settings.configured ? '<button class="text-button ai-remove" type="button" data-remove-connection>Remove connection</button>' : ""}</div><div data-ai-feedback></div></form>`;
    const form = surface.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      button.textContent = "Saving…";
      try {
        const value = {
          baseUrl: data.get("baseUrl"),
          model: data.get("model"),
          insecureHttp: data.get("insecureHttp") === "on",
        };
        if (data.get("apiKey")) value.apiKey = data.get("apiKey");
        if (data.get("clearKey") === "on") value.clearKey = true;
        await api("ai/settings", {
          method: "POST",
          body: JSON.stringify(value),
        });
        await renderConnection(surface);
      } catch (error) {
        surface.querySelector("[data-ai-feedback]").innerHTML = notice(
          error.message,
          "error",
        );
        button.disabled = false;
        button.textContent = "Save connection";
      }
    });
    surface
      .querySelector("[data-test-connection]")
      ?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = "Testing…";
        try {
          const data = new FormData(form);
          const value = {
            baseUrl: data.get("baseUrl"),
            model: data.get("model"),
            insecureHttp: data.get("insecureHttp") === "on",
          };
          if (data.get("apiKey")) value.apiKey = data.get("apiKey");
          if (data.get("clearKey") === "on") value.clearKey = true;
          const result = await api("ai/test", {
            method: "POST",
            body: JSON.stringify(value),
          });
          surface.querySelector("[data-ai-feedback]").innerHTML = notice(
            `${result.model} answered successfully.`,
            "success",
          );
        } catch (error) {
          surface.querySelector("[data-ai-feedback]").innerHTML = notice(
            error.message,
            "error",
          );
        } finally {
          button.disabled = false;
          button.textContent = "Test connection";
        }
      });
    surface
      .querySelector("[data-remove-connection]")
      ?.addEventListener("click", async () => {
        if (!confirm("Remove this model connection and its saved API key?"))
          return;
        await api("ai/settings/remove", { method: "POST", body: "{}" });
        await renderConnection(surface);
      });
  };
  const render = async () => {
    const surface = host.querySelector(".ai-surface");
    surface.innerHTML =
      '<div class="ai-loading" role="status">Loading workspace…</div>';
    try {
      if (activeSection === "access") {
        surface.innerHTML = '<div class="agent-panel"></div>';
        await mountAgents(surface.firstElementChild, api);
      } else await renderConnection(surface);
    } catch (error) {
      surface.innerHTML = `<div class="ai-load-error" role="alert"><h2>Couldn’t load this workspace.</h2><p>${esc(error.message)}</p><button class="button" data-ai-retry>Try again</button></div>`;
      surface
        .querySelector("[data-ai-retry]")
        .addEventListener("click", render, { once: true });
    }
  };
  shell();
  await render();
  return () => cleanup();
}
