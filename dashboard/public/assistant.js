import { renderMarkdown } from "./markdown.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

const toolLabels = {
  service_health: "Check service health",
  project_list: "List projects",
  project_get: "Inspect project",
  project_provision: "Provision project",
  project_retire: "Retire project",
  database_list: "List databases",
  container_list: "Inspect containers",
  container_logs: "Read container logs",
  container_action: "Change a container",
  volume_list: "List Docker volumes",
  volume_create: "Create a Docker volume",
  volume_remove: "Remove a Docker volume",
  network_list: "List Docker networks",
  network_create: "Create a Docker network",
  network_remove: "Remove a Docker network",
  user_createdb: "Allow the project login to create databases",
  user_set_createdb: "Set whether the project login may create databases",
  sql_query: "Run read-only SQL",
  mail_list: "List captured mail",
  mail_search: "Search captured mail",
  mail_get: "Read a captured message",
  mail_delete: "Delete a captured message",
  database_backup: "Backup a database to a bucket",
  database_restore: "Restore a database dump",
  s3_credentials_rotate: "Rotate project MinIO keys",
  database_create: "Create a project database",
  lvm_list: "List LVM volume groups",
  lvm_extend: "Grow a logical volume",
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

const notice = (message, kind = "") =>
  `<p class="ai-notice ${kind}" role="status">${esc(message)}</p>`;

function eventHtml(event, settled = false) {
  if (event.type === "text")
    return `<div class="ai-message assistant">${esc(event.text)}</div>`;
  if (event.type === "tool-start")
    return `<details class="ai-tool running" data-tool-id="${esc(event.id)}" open><summary><span></span><strong>${esc(toolLabel(event.name))}</strong><small data-tool-state>Running</small></summary><code>${esc(targetLabel(event.target))}</code><p data-tool-error hidden></p></details>`;
  if (event.type === "tool-result")
    return `<details class="ai-tool ${event.ok ? "completed" : "failed"}" data-tool-id="${esc(event.id)}"><summary><span></span><strong>${esc(toolLabel(event.name))}</strong><small data-tool-state>${event.ok ? "Completed" : "Failed"}</small></summary><code>${esc(targetLabel(event.target))}</code><p data-tool-error ${event.error ? "" : "hidden"}>${esc(event.error || "")}</p></details>`;
  if (event.type === "approval-required") {
    const action = toolLabel(event.name);
    const target = targetLabel(event.target);
    return `<section class="ai-approval ${settled ? "settled" : ""}" data-approval-id="${esc(event.approvalId)}" data-tool-id="${esc(event.id)}" aria-label="Approval required">
      <p><strong>${esc(action)}</strong>${target ? `<code>${esc(target)}</code>` : ""}</p>
      <span class="ai-approval-state">${settled ? "Resolved" : event.destructive ? "May not be recoverable" : "Changes development infrastructure"}</span>
      ${settled ? "" : `<div class="ai-approval-actions"><button class="button" type="button" data-reject-approval="${esc(event.approvalId)}">Cancel</button><button class="button ${event.destructive ? "danger" : "primary"}" type="button" data-approve-operation="${esc(event.approvalId)}">Allow</button></div>`}
    </section>`;
  }
  if (event.type === "approval-rejected")
    return notice("Operation cancelled. No infrastructure change was made.");
  if (event.type === "cancelled")
    return notice("Stopped. An operation already running may still complete.");
  if (event.type === "error") return notice(event.error, "error");
  return "";
}

function historyHtml(events = []) {
  return events
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
      if (event.type === "approval-required") {
        const settled = events
          .slice(index + 1)
          .some(
            (candidate) =>
              (candidate.type === "tool-result" ||
                candidate.type === "approval-rejected") &&
              candidate.id === event.id,
          );
        return eventHtml(event, settled);
      }
      return eventHtml(event);
    })
    .join("");
}

function renderHistory(transcript, events = []) {
  let markdown = "";
  const flush = () => {
    if (!markdown) return;
    const message = document.createElement("div");
    message.className = "ai-message assistant";
    renderMarkdown(message, markdown);
    transcript.append(message);
    markdown = "";
  };
  events.forEach((event, index) => {
    if (event.type === "text") {
      markdown += event.text;
      return;
    }
    flush();
    if (
      event.type === "tool-result" &&
      events
        .slice(0, index)
        .some(
          (candidate) =>
            candidate.type === "tool-start" && candidate.id === event.id,
        )
    )
      return;
    if (event.type === "approval-required") {
      const settled = events
        .slice(index + 1)
        .some(
          (candidate) =>
            (candidate.type === "tool-result" ||
              candidate.type === "approval-rejected") &&
            candidate.id === event.id,
        );
      transcript.insertAdjacentHTML("beforeend", eventHtml(event, settled));
      return;
    }
    transcript.insertAdjacentHTML("beforeend", eventHtml(event));
  });
  flush();
}

export function mountAssistant(
  host,
  api,
  { icon, getContext, onConfigure } = {},
) {
  let settings;
  let conversation;
  let controller;
  let open = false;
  let returnFocus;
  let awaitingApproval = false;
  let disposed = false;
  let auto = sessionStorage.getItem("wardroom-ai-auto") === "1";

  host.innerHTML = `<aside class="ai-drawer" role="complementary" aria-label="Wardroom AI" aria-hidden="true">
    <header class="ai-drawer-head"><div><strong>Wardroom AI</strong><span data-assistant-status>Loading connection…</span></div><div><button class="icon-button" type="button" data-new-assistant-chat aria-label="New conversation" title="New conversation">${icon("plus")}</button><button class="icon-button" type="button" data-close-assistant aria-label="Close assistant">${icon("close")}</button></div></header>
    <div class="ai-drawer-context"><button class="ai-state ready" type="button" data-assistant-mode aria-pressed="true">Protected</button><span data-assistant-context>Viewing Overview</span></div>
    <div class="ai-drawer-body" data-assistant-body><div class="ai-loading" role="status">Loading assistant…</div></div>
  </aside>`;
  const drawer = host.querySelector(".ai-drawer");
  const body = host.querySelector("[data-assistant-body]");

  const syncMode = () => {
    const button = host.querySelector("[data-assistant-mode]");
    if (!button) return;
    button.textContent = auto ? "Auto" : "Protected";
    button.classList.toggle("ready", !auto);
    button.classList.toggle("auto", auto);
    button.setAttribute("aria-pressed", String(!auto));
    button.title = auto
      ? "Ordinary writes run immediately. Destructive changes still need confirmation."
      : "Confirm every infrastructure change in this chat.";
  };

  const triggers = () => document.querySelectorAll('[data-action="assistant"]');
  const syncOpenState = () => {
    drawer.classList.toggle("open", open);
    drawer.setAttribute("aria-hidden", String(!open));
    drawer.inert = !open;
    document.body.classList.toggle("ai-drawer-open", open);
    triggers().forEach((trigger) =>
      trigger.setAttribute("aria-expanded", String(open)),
    );
    const app = document.querySelector("#app");
    if (app) app.inert = open && matchMedia("(max-width: 650px)").matches;
  };

  const updateContext = () => {
    const context = getContext?.() || "Overview";
    const element = host.querySelector("[data-assistant-context]");
    if (element) element.textContent = `Viewing ${context}`;
  };

  const updateTool = (event) => {
    let entry = [...body.querySelectorAll(".ai-tool[data-tool-id]")].find(
      (candidate) => candidate.dataset.toolId === event.id,
    );
    if (!entry) {
      body
        .querySelector(".ai-transcript")
        ?.insertAdjacentHTML("beforeend", eventHtml(event));
      entry = [...body.querySelectorAll(".ai-tool[data-tool-id]")].find(
        (candidate) => candidate.dataset.toolId === event.id,
      );
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

  const setComposerState = () => {
    const form = body.querySelector(".ai-composer");
    if (!form) return;
    form.elements.message.disabled = awaitingApproval;
    form.querySelector('[type="submit"]').disabled = awaitingApproval;
  };

  const applyEvent = (event) => {
    const transcript = body.querySelector(".ai-transcript");
    if (!transcript) return;
    if (event.type === "text") {
      let message = transcript.querySelector(".ai-message.streaming");
      if (!message) {
        message = document.createElement("div");
        message.className = "ai-message assistant streaming";
        message.markdownSource = "";
        transcript.append(message);
      }
      message.markdownSource = (message.markdownSource || "") + event.text;
      message.textContent = message.markdownSource;
    } else if (event.type === "tool-result") {
      finalizeStreaming(transcript);
      updateTool(event);
      const approval = transcript.querySelector(
        `.ai-approval[data-tool-id="${CSS.escape(event.id)}"]`,
      );
      if (approval) {
        approval.classList.add("settled");
        approval.querySelector(".ai-approval-state").textContent = event.ok
          ? "Approved and completed"
          : "Approved · operation failed";
        approval.querySelector(".ai-approval-actions")?.remove();
      }
      awaitingApproval = false;
      setComposerState();
    } else if (event.type === "approval-required") {
      finalizeStreaming(transcript);
      transcript.insertAdjacentHTML("beforeend", eventHtml(event));
      awaitingApproval = true;
      setComposerState();
    } else if (event.type === "done") {
      finalizeStreaming(transcript);
    } else if (!["done", "usage"].includes(event.type)) {
      finalizeStreaming(transcript);
      transcript.insertAdjacentHTML("beforeend", eventHtml(event));
    }
    transcript.scrollTop = transcript.scrollHeight;
  };

  const finalizeStreaming = (transcript) => {
    const message = transcript.querySelector(".ai-message.streaming");
    if (!message) return;
    renderMarkdown(message, message.markdownSource || message.textContent);
    message.classList.remove("streaming");
    delete message.markdownSource;
  };

  const consumeStream = async (response) => {
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
        if (line) applyEvent(JSON.parse(line.slice(6)));
      }
      if (done) break;
    }
    finalizeStreaming(body.querySelector(".ai-transcript"));
  };

  const renderConversation = () => {
    awaitingApproval = Boolean(
      conversation?.events?.some(
        (event, index, events) =>
          event.type === "approval-required" &&
          !events
            .slice(index + 1)
            .some(
              (candidate) =>
                (candidate.type === "tool-result" ||
                  candidate.type === "approval-rejected") &&
                candidate.id === event.id,
            ),
      ),
    );
    body.innerHTML = `<div class="ai-transcript" role="log" aria-label="Conversation" aria-live="polite"></div>
      <form class="ai-composer"><label class="sr-only" for="assistant-message">Message Wardroom</label><textarea id="assistant-message" name="message" rows="2" maxlength="32768" required placeholder="Ask Wardroom…"></textarea><div><span>Enter to send · Shift+Enter for a new line</span><button class="button" type="button" data-stop-assistant hidden>Stop</button><button class="button primary" type="submit">Send</button></div></form>`;
    const transcript = body.querySelector(".ai-transcript");
    if (conversation?.events?.length)
      renderHistory(transcript, conversation.events);
    else
      transcript.innerHTML =
        '<div class="ai-welcome"><strong>What needs attention?</strong><span>Ask about services, logs, data, containers, or a development change.</span></div>';
    transcript.scrollTop = transcript.scrollHeight;
    setComposerState();
  };

  const load = async () => {
    try {
      settings = await api("ai/settings");
      host.querySelector("[data-assistant-status]").textContent =
        settings.configured ? settings.model : "Model not configured";
      if (!settings.configured) {
        body.innerHTML = `<div class="ai-drawer-empty"><h2>Connect a model</h2><p>Add an OpenAI-compatible endpoint before asking Wardroom to operate your development environment.</p><button class="button primary" type="button" data-configure-assistant>Configure model</button></div>`;
        return;
      }
      const savedId = sessionStorage.getItem("wardroom-ai-conversation");
      if (savedId)
        try {
          conversation = await api(`ai/conversations/${savedId}`);
          auto = Boolean(conversation.auto);
          sessionStorage.setItem("wardroom-ai-auto", auto ? "1" : "0");
        } catch {
          sessionStorage.removeItem("wardroom-ai-conversation");
        }
      syncMode();
      renderConversation();
    } catch (error) {
      body.innerHTML = `<div class="ai-load-error" role="alert"><h2>Couldn’t load the assistant.</h2><p>${esc(error.message)}</p><button class="button" data-retry-assistant>Try again</button></div>`;
    }
  };

  const openDrawer = async (trigger) => {
    returnFocus = trigger || returnFocus;
    open = true;
    updateContext();
    syncOpenState();
    await load();
    requestAnimationFrame(() =>
      body.querySelector("textarea, button")?.focus(),
    );
  };

  const closeDrawer = () => {
    open = false;
    syncOpenState();
    if (returnFocus?.isConnected) returnFocus.focus();
    else triggers()[0]?.focus();
  };

  const submitMessage = async (form) => {
    const message = form.elements.message.value.trim();
    if (!message || awaitingApproval) return;
    if (!conversation) {
      conversation = await api("ai/conversations", {
        method: "POST",
        body: JSON.stringify({
          scope: "admin",
          destructive: false,
          auto,
        }),
      });
      sessionStorage.setItem("wardroom-ai-conversation", conversation.id);
    }
    const transcript = body.querySelector(".ai-transcript");
    transcript.querySelector(".ai-welcome")?.remove();
    transcript.insertAdjacentHTML(
      "beforeend",
      `<div class="ai-message user">${esc(message)}</div>`,
    );
    form.elements.message.value = "";
    const send = form.querySelector('[type="submit"]');
    const stop = form.querySelector("[data-stop-assistant]");
    send.disabled = true;
    stop.hidden = false;
    controller = new AbortController();
    try {
      await consumeStream(
        await fetch(`/api/ai/conversations/${conversation.id}/messages`, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            context: getContext?.() || "Overview",
          }),
        }),
      );
    } catch (error) {
      if (error.name !== "AbortError")
        transcript.insertAdjacentHTML(
          "beforeend",
          notice(error.message, "error"),
        );
    } finally {
      send.disabled = awaitingApproval;
      stop.hidden = true;
      controller = null;
      if (!awaitingApproval) form.elements.message.focus();
    }
  };

  const click = async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.action === "assistant") {
      if (open) closeDrawer();
      else await openDrawer(button);
    } else if (host.contains(button)) {
      if (button.dataset.closeAssistant !== undefined) closeDrawer();
      else if (button.dataset.configureAssistant !== undefined) {
        closeDrawer();
        onConfigure?.();
      } else if (button.dataset.retryAssistant !== undefined) {
        settings = null;
        await load();
      } else if (button.dataset.assistantMode !== undefined) {
        if (controller) return;
        const next = !auto;
        auto = next;
        sessionStorage.setItem("wardroom-ai-auto", auto ? "1" : "0");
        syncMode();
        if (!conversation) return;
        try {
          const updated = await api(
            `ai/conversations/${conversation.id}/policy`,
            {
              method: "POST",
              body: JSON.stringify({ auto }),
            },
          );
          conversation = { ...conversation, auto: Boolean(updated.auto) };
          body.querySelector(".ai-transcript")?.insertAdjacentHTML(
            "beforeend",
            notice(
              auto
                ? "Switched to Auto. Ordinary writes run immediately; destructive changes still need confirmation."
                : "Switched to Protected. Confirm every infrastructure change.",
            ),
          );
        } catch (error) {
          auto = !next;
          sessionStorage.setItem("wardroom-ai-auto", auto ? "1" : "0");
          syncMode();
          body
            .querySelector(".ai-transcript")
            ?.insertAdjacentHTML("beforeend", notice(error.message, "error"));
        }
      } else if (button.dataset.newAssistantChat !== undefined) {
        if (conversation)
          await api(`ai/conversations/${conversation.id}/close`, {
            method: "POST",
            body: "{}",
          });
        sessionStorage.removeItem("wardroom-ai-conversation");
        conversation = null;
        renderConversation();
        body.querySelector("textarea")?.focus();
      } else if (button.dataset.stopAssistant !== undefined) {
        controller?.abort();
        if (conversation)
          await api(`ai/conversations/${conversation.id}/stop`, {
            method: "POST",
            body: "{}",
          }).catch(() => {});
      } else if (button.dataset.approveOperation) {
        const card = button.closest(".ai-approval");
        card
          .querySelectorAll("button")
          .forEach((item) => (item.disabled = true));
        card.querySelector(".ai-approval-state").textContent =
          "Running approved change…";
        controller = new AbortController();
        try {
          await consumeStream(
            await fetch(`/api/ai/conversations/${conversation.id}/approve`, {
              method: "POST",
              signal: controller.signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                approvalId: button.dataset.approveOperation,
              }),
            }),
          );
        } catch (error) {
          card.querySelector(".ai-approval-state").textContent = error.message;
          card
            .querySelectorAll("button")
            .forEach((item) => (item.disabled = false));
        } finally {
          controller = null;
        }
      } else if (button.dataset.rejectApproval) {
        const card = button.closest(".ai-approval");
        await api(`ai/conversations/${conversation.id}/reject`, {
          method: "POST",
          body: JSON.stringify({ approvalId: button.dataset.rejectApproval }),
        });
        card.classList.add("settled");
        card.querySelector(".ai-approval-state").textContent = "Cancelled";
        card.querySelector(".ai-approval-actions")?.remove();
        awaitingApproval = false;
        setComposerState();
        body.querySelector("textarea")?.focus();
      } else if (button.dataset.copyCode !== undefined) {
        const code = button.closest(".ai-code-block")?.querySelector("code");
        if (!code) return;
        if (navigator.clipboard && window.isSecureContext)
          await navigator.clipboard.writeText(code.textContent);
        else {
          const field = document.createElement("textarea");
          field.value = code.textContent;
          document.body.append(field);
          field.select();
          document.execCommand("copy");
          field.remove();
        }
        button.textContent = "Copied";
        setTimeout(() => {
          if (button.isConnected) button.textContent = "Copy code";
        }, 1600);
      }
    }
  };

  const submit = (event) => {
    if (!host.contains(event.target) || !event.target.matches(".ai-composer"))
      return;
    event.preventDefault();
    void submitMessage(event.target);
  };

  const keydown = (event) => {
    if (event.key === "Escape" && open) closeDrawer();
    if (
      host.contains(event.target) &&
      event.target.matches("textarea") &&
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();
      event.target.form.requestSubmit();
    }
  };

  document.addEventListener("click", click);
  document.addEventListener("submit", submit);
  document.addEventListener("keydown", keydown);
  syncOpenState();
  updateContext();
  syncMode();

  return {
    setContext() {
      updateContext();
      syncOpenState();
    },
    close: closeDrawer,
    dispose() {
      if (disposed) return;
      disposed = true;
      controller?.abort();
      document.removeEventListener("click", click);
      document.removeEventListener("submit", submit);
      document.removeEventListener("keydown", keydown);
      document.body.classList.remove("ai-drawer-open");
      const app = document.querySelector("#app");
      if (app) app.inert = false;
      host.innerHTML = "";
    },
  };
}
