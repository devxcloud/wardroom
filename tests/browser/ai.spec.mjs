import { test, expect } from "@playwright/test";

const sse = (...events) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

test("global AI drawer starts lazily, survives navigation and stays responsive", async ({
  page,
}) => {
  const chatId = "8b6d8849-78db-4f50-ae3a-7d2c91dca398";
  let testedConnection;
  let createdConversations = 0;
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
    if (url.pathname === "/api/ai/conversations" && method === "POST") {
      createdConversations++;
      expect(route.request().postDataJSON()).toEqual({
        scope: "admin",
        destructive: false,
        auto: false,
      });
      return route.fulfill({
        status: 201,
        json: {
          id: chatId,
          scope: { scope: "admin", destructive: false },
          events: [],
        },
      });
    }
    if (url.pathname === "/api/ai/test" && method === "POST") {
      testedConnection = route.request().postDataJSON();
      return route.fulfill({
        json: { ok: true, model: testedConnection.model },
      });
    }
    if (url.pathname.endsWith("/policy") && method === "POST") {
      expect(route.request().postDataJSON()).toEqual({ auto: true });
      return route.fulfill({
        json: {
          id: chatId,
          scope: { scope: "admin", destructive: false },
          auto: true,
          events: [],
        },
      });
    }
    if (url.pathname.endsWith("/approve"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: sse(
          {
            type: "tool-start",
            id: "call-retire",
            name: "project_retire",
            target: { project: "sample" },
          },
          {
            type: "tool-result",
            id: "call-retire",
            name: "project_retire",
            target: { project: "sample" },
            ok: true,
            durationMs: 42,
          },
          { type: "text", text: "The sample project was retired." },
          { type: "done" },
        ),
      });
    if (url.pathname.endsWith("/messages")) {
      const message = route.request().postDataJSON();
      expect(message.context).toBeTruthy();
      if (message.message.includes("database usage"))
        return route.fulfill({
          contentType: "text/event-stream",
          body: sse(
            {
              type: "text",
              text: [
                "## Project: thryx",
                "",
                "**Description:** Issue tracking",
                "",
                "| Database | Size |",
                "| --- | ---: |",
                "| `thryx` | 7.7 MB |",
                "| `thryx_test` | 15.0 MB |",
                "",
                "```sql",
                "SELECT pg_database_size('thryx');",
                "```",
                "",
              ].join("\n"),
            },
            { type: "text", text: "<img src=x onerror=alert(1)>" },
            { type: "done" },
          ),
        });
      if (message.message.includes("Retire"))
        return route.fulfill({
          contentType: "text/event-stream",
          body: sse(
            {
              type: "approval-required",
              approvalId: "approval-1",
              id: "call-retire",
              name: "project_retire",
              target: { project: "sample" },
              destructive: true,
            },
            { type: "done" },
          ),
        });
      return route.fulfill({
        contentType: "text/event-stream",
        body: sse(
          {
            type: "tool-start",
            id: "call-1",
            name: "service_health",
            target: {},
          },
          {
            type: "tool-result",
            id: "call-1",
            name: "service_health",
            target: {},
            ok: true,
          },
          { type: "text", text: "All shared services are healthy." },
          { type: "done" },
        ),
      });
    }
    await route.continue();
  });
  await page.goto("/");
  await page
    .getByLabel("Dashboard password")
    .fill(process.env.DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(
    page.getByRole("complementary", { name: "Wardroom AI" }),
  ).toBeVisible();
  await expect(page.getByLabel("Access scope")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start conversation" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Protected" })).toBeVisible();
  expect(createdConversations).toBe(0);
  await page.getByLabel("Message Wardroom").fill("Check shared services");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect(createdConversations).toBe(1);
  await expect(page.getByText("Check service health")).toBeVisible();
  await expect(page.getByText("Completed", { exact: false })).toBeVisible();
  await expect(
    page.getByText("All shared services are healthy."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Protected" }).click();
  await expect(page.getByRole("button", { name: "Auto" })).toBeVisible();
  await expect(
    page.getByText("Switched to Auto", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Message Wardroom").fill("Show database usage");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Project: thryx" }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("cell", { name: "15.0 MB" })).toBeVisible();
  await expect(
    page.getByText("SELECT pg_database_size('thryx');"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(page.locator(".ai-markdown img")).toHaveCount(0);
  await expect(
    page.getByText("<img src=x onerror=alert(1)>", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Message Wardroom").fill("Retire sample");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Approval required")).toBeVisible();
  await expect(page.getByText("May not be recoverable")).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("Approved and completed")).toBeVisible();
  await expect(page.getByText("The sample project was retired.")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "System" })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Wardroom AI" }),
  ).toBeVisible();
  await expect(page.getByText("Viewing System")).toBeVisible();
  await expect(
    page.getByText("All shared services are healthy."),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "AI & MCP" })
    .click();
  await expect(page).toHaveURL(/#ai-mcp$/);
  await expect(
    page.getByRole("button", { name: "MCP access" }),
  ).toHaveAttribute("aria-current", "page");
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
  await expect(
    page.getByRole("complementary", { name: "Wardroom AI" }),
  ).toHaveCSS("width", "390px");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/ai-mobile.png", fullPage: true });
});
