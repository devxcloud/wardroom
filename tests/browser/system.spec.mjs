import { test, expect } from "@playwright/test";

async function openSystem(page) {
  await page.goto("/");
  await page
    .getByLabel("Dashboard password")
    .fill(process.env.DASHBOARD_PASSWORD);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Inside your devbox." }),
  ).toBeVisible();
}

test("live host metrics, chart controls, and container inspection", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openSystem(page);
  await expect(page.locator(".resource-gauge")).toHaveCount(3);
  await expect(page.locator(".time-chart")).toHaveCount(4);
  await expect(page.locator("#system-live-state")).toContainText("Live");
  await expect(
    page.getByRole("heading", { name: "LVM volume groups" }),
  ).toBeVisible();
  await expect(page.locator("#system-lvm")).toContainText("unallocated");
  await expect(page.getByRole("button", { name: "Grow" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Containers" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Docker volumes" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/system-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "1h", exact: true }).click();
  await expect(page.locator(".time-chart").first()).toHaveAttribute(
    "aria-label",
    /over 1h/,
  );
  await page.locator(".time-chart").first().focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator('[data-tooltip="cpu"]')).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume live" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("system dashboard fits mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSystem(page);
  await expect(page.locator(".resource-gauge")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/system-mobile.png",
    fullPage: true,
  });
});
