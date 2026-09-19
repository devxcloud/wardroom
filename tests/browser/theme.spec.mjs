import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("long test-lab endpoints remain readable beside fault controls", async ({
  page,
}) => {
  // Exercise the working-tree CSS before deployment as well as after it.
  for (const file of ["style.css", "tools.css"]) {
    await page.route(`**/${file}`, (route) =>
      readFile(
        new URL(`../../dashboard/public/${file}`, import.meta.url),
        "utf8",
      ).then((body) => route.fulfill({ contentType: "text/css", body })),
    );
  }
  await page.route("**/api/tools", (route) =>
    route.fulfill({
      json: {
        tools: [
          { id: "api", status: "healthy", detail: "API workbench is ready." },
        ],
        lab: { active: true, wiremock: "healthy", toxiproxy: "healthy" },
        connections: {
          otlpGrpc: "devbox.internal:4317",
          otlpHttp: "http://devbox.internal:4318",
          postgresProxy: "long-development-host.internal.example:15434",
          redisProxy: "long-development-host.internal.example:16379",
          minioProxy: "http://long-development-host.internal.example:19100",
        },
      },
    }),
  );
  await page.goto("/");
  await page
    .getByLabel("Dashboard password")
    .fill(process.env.DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.locator(".fault-row")).toHaveCount(3);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const row of await page.locator(".fault-row").all()) {
      const code = row.locator("code");
      expect(
        await code.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const label = await code.boundingBox();
      const control = await row.locator("select").boundingBox();
      expect(label.y + label.height).toBeLessThanOrEqual(control.y);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
