import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { DeleteBucketCommand } from "@aws-sdk/client-s3";
import { Infrastructure } from "../../dashboard/infra.mjs";
import { configFrom } from "../../dashboard/config.mjs";
import { quoteIdentifier as qi } from "../../dashboard/domain.mjs";

async function signIn(page) {
  await page.goto("/");
  await page
    .getByLabel("Dashboard password")
    .fill(process.env.DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Your infrastructure", exact: true }),
  ).toBeVisible();
}

test("live workspace navigation, PostgreSQL explorer, and dialogs", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "PostgreSQL", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of your data." }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /Roles/ }).click();
  await expect(
    page.getByRole("columnheader", { name: "Privileges" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /Databases/ }).click();
  await page.getByLabel("Find a database").fill("postgres");
  await page.getByRole("button", { name: "postgres", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "postgres", exact: true }),
  ).toBeVisible();
  const tables = page.locator("[data-table]");
  if (await tables.count()) {
    await tables.first().click();
    await expect(page.locator(".records-table")).toBeVisible();
    await expect(page.getByText("Couldn’t load this table.")).toHaveCount(0);
    await page.screenshot({
      path: "test-results/explorer-desktop.png",
      fullPage: true,
    });
  }
  await page
    .getByRole("button", { name: /Projects/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Connect" }).first().click();
  await expect(page.locator(".connection-code")).toContainText(
    "<PROJECT_DB_PASSWORD>",
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("bad-name");
  await page
    .getByLabel("Database password", { exact: true })
    .fill("valid-test-password");
  expect(
    await page
      .locator("#project-form")
      .evaluate((form) => form.checkValidity()),
  ).toBe(false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Storage", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A place for every object." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The command desk" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile overview and keyboard-accessible form", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/overview-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page.getByLabel("Project name", { exact: true })).toBeFocused();
  await page.screenshot({
    path: "test-results/project-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog")).not.toBeVisible();
});

test("unreachable API has a useful retry state", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/databases", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Service unavailable. Check connectivity and retry.",
      }),
    }),
  );
  await page.getByRole("button", { name: "PostgreSQL", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connection interrupted." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("developer tools workbench links core tools and explains the optional lab", async ({
  page,
}) => {
  await page.route("**/api/tools", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tools: [
          {
            id: "logs",
            status: "healthy",
            detail: "Container logs are ready.",
          },
          {
            id: "redis",
            status: "healthy",
            detail: "Redis workspace is ready.",
          },
          {
            id: "traces",
            status: "healthy",
            detail: "Trace explorer is ready.",
          },
        ],
        lab: { active: false, wiremock: "inactive", toxiproxy: "inactive" },
        connections: {
          otlpGrpc: "devbox:4317",
          otlpHttp: "http://devbox:4318",
          postgresProxy: "devbox:15434",
          redisProxy: "devbox:16379",
          minioProxy: "http://devbox:19100",
        },
      }),
    }),
  );
  await signIn(page);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your developer cockpit." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open live logs/ }),
  ).toHaveAttribute("href", "/logs/");
  await expect(
    page.getByRole("link", { name: /Explore traces/ }),
  ).toHaveAttribute("href", "/jaeger/");
  await expect(page.getByText("devbox:4317", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Test lab is parked", { exact: true }),
  ).toBeVisible();
  await page.goto("/traces/");
  await expect(page).toHaveURL(/\/jaeger\/search$/);
  await expect(page).toHaveTitle("Jaeger UI");
});

test("create a project in the UI and browse its real records", async ({
  page,
}) => {
  const infra = new Infrastructure(configFrom());
  const name = `ui_check_${randomBytes(5).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  try {
    await signIn(page);
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page.getByLabel("Project name", { exact: true }).fill(name);
    await page.getByLabel("Database password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: `Connect ${name}` }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await infra.withDatabase(
      name,
      (c) =>
        c.query(
          "CREATE TABLE sample_records (id integer PRIMARY KEY, label text); INSERT INTO sample_records SELECT n,'Sample record ' || n FROM generate_series(1,55) n",
        ),
      false,
    );
    await page.getByRole("button", { name: "PostgreSQL", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await page.locator('[data-table="sample_records"]').click();
    await expect(page.getByText("1–50 records shown")).toBeVisible();
    await expect(
      page.locator(".records-table tbody tr").nth(1).locator("td").first(),
    ).toHaveText("2");
    await expect(page.locator(".records-table")).toContainText(
      "Sample record 1",
    );
    await page.screenshot({
      path: "test-results/explorer-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("51–55 records shown")).toBeVisible();
    await expect(
      page.locator(".records-table tbody tr").first().locator("td").first(),
    ).toHaveText("51");
    await expect(
      page.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
  } finally {
    // Delete only this test's uniquely named resources, never a shared project.
    for (const db of [name, `${name}_test`])
      await infra.pool.query(`DROP DATABASE IF EXISTS ${qi(db)}`);
    await infra.pool.query(`DROP ROLE IF EXISTS ${qi(name)}`);
    for (const b of [
      name.replaceAll("_", "-"),
      `${name.replaceAll("_", "-")}-test`,
    ])
      if (await infra.s3.bucketExists(b))
        await infra.s3Client.send(new DeleteBucketCommand({ Bucket: b }));
    await infra.pool.query("DELETE FROM shared_infra.events WHERE project=$1", [
      name,
    ]);
    await infra.pool.query("DELETE FROM shared_infra.projects WHERE name=$1", [
      name,
    ]);
    await infra.close();
  }
});
