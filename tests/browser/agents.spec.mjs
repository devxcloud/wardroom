import { test, expect } from "@playwright/test";
test.use({ screenshot: "off", actionTimeout: 5000 }); // Never capture an undisposed one-time credential on failure.

test("Tools issues a scoped token once, provides client setup and revokes access", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Dashboard password")
    .fill(process.env.DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.locator('[data-nav="tools"]').click();
  await expect(page.getByLabel("Token label")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "AI & MCP" })
    .click();
  await expect(page).toHaveURL(/#ai-mcp$/);
  await page.reload();
  await expect(page.locator('[data-nav="ai-mcp"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  const panel = page.getByRole("region", { name: "AI and MCP settings" });
  await expect(
    page.getByRole("heading", { name: "AI & MCP", exact: true }),
  ).toBeVisible();
  await expect(panel.getByLabel("Token label")).toBeHidden();
  await expect(panel.locator("#agent-config")).toBeHidden();
  await panel.getByRole("button", { name: "Show config", exact: true }).click();
  await expect(panel.locator("#agent-config")).toContainText(
    "bearer_token_env_var",
  );
  await panel.getByRole("button", { name: "Hide config", exact: true }).click();
  await panel
    .getByRole("button", { name: "Copy command", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("copied");
  await panel.getByRole("tab", { name: "Codex", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    panel.getByRole("tab", { name: "Claude Code", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("tab", { name: "Codex", exact: true }).click();
  await panel.getByRole("button", { name: "New token", exact: true }).click();
  const label = `browser-agent-${Date.now()}`;
  let issued;
  try {
    await panel.getByLabel("Token label").fill(label);
    await panel.getByLabel("Project name").fill("browser_agent");
    await expect(panel.getByLabel("Expires after")).toContainText(
      "No expiration",
    );
    await expect(
      panel.getByLabel("Allow destructive operations"),
    ).not.toBeChecked();
    const result = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/agent-tokens") &&
        r.request().method() === "POST",
    );
    await panel
      .getByRole("button", { name: "Create token", exact: true })
      .click();
    issued = await (await result).json();
    expect(issued.scope).toBe("project");
    expect(issued.destructive).toBe(false);
    const authorized = await page.request.post("/mcp", {
      headers: {
        Authorization: `Bearer ${issued.token}`,
        Accept: "application/json, text/event-stream",
      },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(authorized.status()).toBe(200);
    await expect(panel.getByLabel("New agent token")).toHaveValue(issued.token);
    expect(
      await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
    ).not.toContain(issued.token);
    await panel.getByRole("button", { name: "I saved it" }).click();
    await expect(panel.getByLabel("New agent token")).toBeHidden();
    for (const client of ["Claude Code", "Grok Build", "Codex", "Other"]) {
      await panel.getByRole("tab", { name: client, exact: true }).click();
      await expect(panel.locator("#agent-snippet")).not.toContainText(
        issued.token,
      );
    }
    await panel.getByRole("tab", { name: "Codex", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const alignment = await panel.evaluate((el) => {
      const checkbox = el
        .querySelector("[data-show-inactive]")
        .getBoundingClientRect();
      const refresh = el
        .querySelector("[data-refresh]")
        .getBoundingClientRect();
      const setup = el.querySelector(".agent-setup").getBoundingClientRect();
      const frame = el.getBoundingClientRect();
      return {
        delta: Math.abs(
          checkbox.y + checkbox.height / 2 - refresh.y - refresh.height / 2,
        ),
        width: setup.width / frame.width,
      };
    });
    expect(alignment.delta).toBeLessThan(2);
    expect(alignment.width).toBeGreaterThan(0.9);
    await page.screenshot({
      path: "test-results/agents-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/agents-mobile.png",
      fullPage: true,
    });
    page.once("dialog", (dialog) => dialog.accept());
    const row = panel.getByRole("article").filter({ hasText: label });
    await row.getByRole("button", { name: "Revoke" }).click();
    await panel.getByLabel("Show inactive tokens").check();
    await expect(row).toContainText("Revoked");
    const revoked = await page.request.post("/mcp", {
      headers: { Authorization: `Bearer ${issued.token}` },
      data: {},
    });
    expect(revoked.status()).toBe(401);
    const list = await (await page.request.get("/api/agent-tokens")).text();
    expect(list).not.toContain(issued.token);
  } finally {
    if (issued?.id)
      await page.request
        .post("/api/agent-tokens/revoke", {
          data: { id: issued.id },
          timeout: 3000,
        })
        .catch(() => {});
  }
});
