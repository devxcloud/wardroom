import { test, expect } from "@playwright/test";

async function openContainers(page) {
  await page.goto("/");
  await page
    .getByLabel("Dashboard password")
    .fill(process.env.DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Containers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Containers, volumes and networks." }),
  ).toBeVisible();
}

test("container inventory, details, and volume list", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openContainers(page);
  await expect(page.locator("#runtime-live-state")).toContainText("Live");
  await expect(
    page.getByRole("heading", { name: "Docker volumes" }),
  ).toBeVisible();
  await expect(page.locator("#volume-rows tr").first()).toBeVisible();
  await expect(page.locator("#volume-rows")).toContainText(/GiB|MiB|KiB|0 B/);
  await expect(
    page.getByRole("heading", { name: "Docker networks" }),
  ).toBeVisible();
  await expect(page.locator("#network-rows tr").first()).toBeVisible();
  await page.screenshot({
    path: "test-results/containers-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("Find a container").fill("shared-infra-gateway");
  await expect(page.locator(".container-table tbody tr")).toHaveCount(1);
  await page.locator("[data-container]").click();
  await expect(page.locator("dialog")).toContainText("shared-infra-gateway");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("containers page fits mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openContainers(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/containers-mobile.png",
    fullPage: true,
  });
});
