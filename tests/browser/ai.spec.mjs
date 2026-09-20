import { test, expect } from "@playwright/test";

test("AI connection and scoped chat are clear, private and responsive", async ({
  page,
}) => {
  const chatId = "8b6d8849-78db-4f50-ae3a-7d2c91dca398";
  let testedConnection;
  await page.route("**/api/ai/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/ai/settings" && method === "GET")
      return route.fulfill({
        json: {
          configured: true,
          baseUrl: "https://provider.example/v1",
          model: "dev-model",
          hasKey: true,
        },
      });
    if (url.pathname === "/api/ai/conversations" && method === "POST")
      return route.fulfill({
        status: 201,
        json: {
          id: chatId,
          scope: { scope: "admin", destructive: false },
          events: [],
        },
      });
    if (url.pathname === "/api/ai/test" && method === "POST") {
      testedConnection = route.request().postDataJSON();
      return route.fulfill({
        json: { ok: true, model: testedConnection.model },
      });
    }
    if (url.pathname.endsWith("/messages"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"tool-start","id":"call-1","name":"service_health","target":{}}\n\ndata: {"type":"tool-result","id":"call-1","name":"service_health","target":{},"ok":true}\n\ndata: {"type":"text","text":"All shared services are healthy."}\n\ndata: {"type":"done"}\n\n',
      });
    await route.continue();
  });
  await page.goto("/");
  await page
    .getByLabel("Dashboard password")
    .fill(process.env.DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "AI & MCP" })
    .click();
  await expect(page).toHaveURL(/#ai-mcp$/);
  await expect(
    page.getByRole("button", { name: "MCP access" }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(/#ai-mcp\/chat$/);
  await page.getByLabel("Access scope").selectOption("admin");
  await page.getByRole("button", { name: "Start conversation" }).click();
  await page.getByLabel("Message Wardroom").fill("Check shared services");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Check service health")).toBeVisible();
  await expect(page.getByText("Completed", { exact: false })).toBeVisible();
  await expect(
    page.getByText("All shared services are healthy."),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/ai-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Connection", exact: true }).click();
  await expect(page.getByLabel("API key")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Save connection" }),
  ).toBeVisible();
  await page.getByLabel("Model ID").fill("edited-model");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(
    page.getByText("edited-model answered successfully."),
  ).toBeVisible();
  expect(testedConnection.model).toBe("edited-model");
  expect(testedConnection.baseUrl).toBe("https://provider.example/v1");
  await expect(page.getByText("may be billed", { exact: false })).toBeVisible();
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
  ).not.toContain("API key");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/ai-mobile.png", fullPage: true });
});
