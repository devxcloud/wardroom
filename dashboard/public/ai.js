import { mountAgents } from "./agents.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export async function mountAi(
  host,
  api,
  { section = "access", projects = [] } = {},
) {
  let cleanup = () => {};
  let activeSection = ["chat", "connection", "access"].includes(section)
    ? section
    : "access";
  const shell = () => {
    host.innerHTML = `<div class="ai-tabs" role="navigation" aria-label="AI and MCP sections">
      ${[
        ["chat", "Chat"],
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
  const renderChat = async (surface) => {
    const settings = await api("ai/settings");
    if (!settings.configured) {
      surface.innerHTML = `<div class="ai-empty"><span class="ai-orbit" aria-hidden="true"></span><h2>Connect a model to start</h2><p>Wardroom can investigate and operate your development infrastructure with the permissions you choose.</p><button class="button primary" data-open-connection>Configure connection</button></div>`;
      surface
        .querySelector("button")
        .addEventListener("click", () =>
          host.querySelector('[data-ai-section="connection"]').click(),
        );
      return;
    }
    let conversation;
    const savedId = sessionStorage.getItem("wardroom-ai-conversation");
    if (savedId)
      try {
        conversation = await api(`ai/conversations/${savedId}`);
      } catch {
        sessionStorage.removeItem("wardroom-ai-conversation");
      }
    if (!conversation) {
      surface.innerHTML = `<div class="ai-start"><div><h2>Work with Wardroom</h2><p>Prompts and selected tool results go to <strong>${esc(settings.model)}</strong>. Don’t paste secrets unless you intend to send them to your provider.</p></div>
        <form><label>Access scope<select name="scope"><option value="project">One project</option><option value="admin">Workspace admin</option></select></label>
        <label data-project-field>Project<select name="project" required>${projects.map((project) => `<option value="${esc(project.name)}">${esc(project.name)}</option>`).join("")}</select></label>
        <label class="ai-check"><input name="destructive" type="checkbox"> Allow destructive operations and project SQL</label>
        <button class="button primary" type="submit">Start conversation</button></form></div>`;
      const form = surface.querySelector("form");
      const scope = form.elements.scope;
      scope.addEventListener("change", () => {
        surface.querySelector("[data-project-field]").hidden =
          scope.value === "admin";
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const payload = {
          scope: data.get("scope"),
          destructive: data.get("destructive") === "on",
        };
        if (payload.scope === "project") payload.project = data.get("project");
        try {
          conversation = await api("ai/conversations", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          sessionStorage.setItem("wardroom-ai-conversation", conversation.id);
          await showConversation();
        } catch (error) {
          form.insertAdjacentHTML("beforeend", notice(error.message, "error"));
        }
      });
      return;
    }
    await showConversation();
    async function showConversation() {
      surface.innerHTML = `<div class="ai-chat-head"><div><h2>${conversation.scope.scope === "admin" ? "Workspace" : esc(conversation.scope.project)}</h2><p>${esc(settings.model)} · ${conversation.scope.destructive ? "Destructive tools enabled" : "Protected mode"}</p></div><button class="text-button" data-new-chat>New conversation</button></div>
        <div class="ai-transcript" role="log" aria-label="Conversation">${historyHtml(conversation.events || []) || '<div class="ai-welcome"><strong>What needs attention?</strong><span>Ask about services, data, logs, resources, or make a development change.</span></div>'}</div>
        <form class="ai-composer"><label class="sr-only" for="ai-message">Message Wardroom</label><textarea id="ai-message" name="message" rows="3" maxlength="32768" required placeholder="Ask about your infrastructure…"></textarea><div><span>Enter to send · Shift+Enter for a new line</span><button class="button" type="button" data-stop hidden>Stop</button><button class="button primary" type="submit">Send</button></div></form>`;
      const transcript = surface.querySelector(".ai-transcript");
      const form = surface.querySelector("form");
      const send = form.querySelector('[type="submit"]');
      const stop = form.querySelector("[data-stop]");
      let controller;
      for (const event of conversation.events || [])
        if (event.type === "tool-result") updateTool(transcript, event);
      surface
        .querySelector("[data-new-chat]")
        .addEventListener("click", async () => {
          await api(`ai/conversations/${conversation.id}/close`, {
            method: "POST",
            body: "{}",
          });
          sessionStorage.removeItem("wardroom-ai-conversation");
          conversation = null;
          await renderChat(surface);
        });
      stop.addEventListener("click", async () => {
        controller?.abort();
        await api(`ai/conversations/${conversation.id}/stop`, {
          method: "POST",
          body: "{}",
        }).catch(() => {});
      });
      form.elements.message.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          form.requestSubmit();
        }
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = form.elements.message.value.trim();
        if (!message) return;
        transcript.querySelector(".ai-welcome")?.remove();
        transcript.insertAdjacentHTML(
          "beforeend",
          `<div class="ai-message user">${esc(message)}</div>`,
        );
        form.elements.message.value = "";
        send.disabled = true;
        stop.hidden = false;
        controller = new AbortController();
        let assistant;
        try {
          const response = await fetch(
            `/api/ai/conversations/${conversation.id}/messages`,
            {
              method: "POST",
              signal: controller.signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message }),
            },
          );
          if (!response.ok)
            throw Error((await response.json()).error || "AI request failed.");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            buffer += decoder
              .decode(value || new Uint8Array(), { stream: !done })
              .replaceAll("\r\n", "\n");
            let index;
            while ((index = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const line = frame
                .split("\n")
                .find((entry) => entry.startsWith("data: "));
              if (!line) continue;
              const event = JSON.parse(line.slice(6));
              if (event.type === "text") {
                if (!assistant) {
                  assistant = document.createElement("div");
                  assistant.className = "ai-message assistant";
                  transcript.append(assistant);
                }
                assistant.append(document.createTextNode(event.text));
              } else if (event.type === "tool-result")
                updateTool(transcript, event);
              else transcript.insertAdjacentHTML("beforeend", eventHtml(event));
              transcript.scrollTop = transcript.scrollHeight;
            }
            if (done) break;
          }
        } catch (error) {
          if (error.name !== "AbortError")
            transcript.insertAdjacentHTML(
              "beforeend",
              notice(error.message, "error"),
            );
        } finally {
          send.disabled = false;
          stop.hidden = true;
          controller = null;
          form.elements.message.focus();
        }
      });
      cleanup = () => controller?.abort();
    }
  };
  const toolLabels = {
    service_health: "Check service health",
    project_list: "List projects",
    project_get: "Inspect project",
    project_provision: "Provision project",
    database_list: "List databases",
    container_list: "Inspect containers",
    container_logs: "Read container logs",
  };
  const toolLabel = (name) =>
    toolLabels[name] ||
    name
      .split("_")
      .map((word, index) =>
        index ? word : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join(" ");
  const targetLabel = (target = {}) =>
    Object.values(target).filter(Boolean).join(" · ") || "Workspace";
  const toolEntry = (container, id) =>
    [...container.querySelectorAll("[data-tool-id]")].find(
      (entry) => entry.dataset.toolId === id,
    );
  const updateTool = (container, event) => {
    let entry = toolEntry(container, event.id);
    if (!entry) {
      container.insertAdjacentHTML("beforeend", eventHtml(event));
      entry = toolEntry(container, event.id);
    }
    if (!entry) return;
    entry.classList.remove("running", "completed", "failed");
    entry.classList.add(event.ok ? "completed" : "failed");
    entry.open = false;
    const state = entry.querySelector("[data-tool-state]");
    if (state)
      state.textContent = event.ok
        ? `Completed${Number.isFinite(event.durationMs) ? ` · ${event.durationMs} ms` : ""}`
        : "Failed";
    const error = entry.querySelector("[data-tool-error]");
    if (error && event.error) {
      error.hidden = false;
      error.textContent = event.error;
    }
  };
  const historyHtml = (events) =>
    events
      .map((event, index) => {
        if (
          event.type === "tool-result" &&
          events
            .slice(0, index)
            .some(
              (candidate) =>
                candidate.type === "tool-start" && candidate.id === event.id,
            )
        )
          return "";
        return eventHtml(event);
      })
      .join("");
  const eventHtml = (event) => {
    if (event.type === "text")
      return `<div class="ai-message assistant">${esc(event.text)}</div>`;
    if (event.type === "tool-start")
      return `<details class="ai-tool running" data-tool-id="${esc(event.id)}" open><summary><span></span><strong>${esc(toolLabel(event.name))}</strong><small data-tool-state>Running</small></summary><code>${esc(targetLabel(event.target))}</code><p data-tool-error hidden></p></details>`;
    if (event.type === "tool-result")
      return `<details class="ai-tool ${event.ok ? "completed" : "failed"}" data-tool-id="${esc(event.id)}"><summary><span></span><strong>${esc(toolLabel(event.name))}</strong><small data-tool-state>${event.ok ? "Completed" : "Failed"}</small></summary><code>${esc(targetLabel(event.target))}</code><p data-tool-error ${event.error ? "" : "hidden"}>${esc(event.error || "")}</p></details>`;
    if (event.type === "cancelled")
      return notice(
        "Stopped. An operation already running may still complete.",
      );
    if (event.type === "error") return notice(event.error, "error");
    return "";
  };
  const render = async () => {
    const surface = host.querySelector(".ai-surface");
    surface.innerHTML =
      '<div class="ai-loading" role="status">Loading workspace…</div>';
    try {
      if (activeSection === "access") {
        surface.innerHTML = '<div class="agent-panel"></div>';
        await mountAgents(surface.firstElementChild, api);
      } else if (activeSection === "connection")
        await renderConnection(surface);
      else await renderChat(surface);
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
