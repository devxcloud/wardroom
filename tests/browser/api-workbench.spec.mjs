import { test, expect } from "@playwright/test";

test("API workbench is protected and opens through the memorable gateway entry", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.API_WORKBENCH_TEST !== "1",
    "Enable when the optional API workbench is running.",
  );
  const origin = `http://${process.env.HOPPSCOTCH_HOST || "devbox"}:3000`;
  for (const path of ["/", "/admin", "/backend/ping", "/backend/graphql"]) {
    expect((await request.get(`${origin}${path}`)).status()).toBe(401);
  }
  await page.goto("/");
  await page
    .getByLabel("Dashboard password")
    .fill(process.env.DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const card = page.locator(".tool-api");
  await expect(card).toContainText("Ready");
  await expect(
    card.getByRole("link", { name: "Open Hoppscotch" }),
  ).toHaveAttribute("href", "/api");
  await page.screenshot({
    path: "test-results/api-tools-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const detail = await card.locator("small").boundingBox();
  const launch = await card.locator("a").boundingBox();
  expect(detail.y + detail.height).toBeLessThanOrEqual(launch.y);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/api-tools-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.goto("/api");
  await expect(page).toHaveURL(new RegExp(`:3000/`));
  await expect(page).toHaveTitle(/Hoppscotch/);
  await expect(page.locator("body")).toContainText(/Send|Get Started|Welcome/i);
  await page.screenshot({
    path: "test-results/hoppscotch.png",
    fullPage: true,
  });
});
