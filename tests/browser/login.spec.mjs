import { test, expect } from "@playwright/test";

for (const remembered of [false, true]) {
  test(`login remembers device only when selected (${remembered})`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: remembered ? 390 : 1440, height: 900 });
    await page.goto("/");
    const checkbox = page.getByRole("checkbox", {
      name: "Remember this device",
    });
    await expect(checkbox).not.toBeChecked();
    await page
      .getByLabel("Dashboard password")
      .fill(process.env.DASHBOARD_PASSWORD);
    await page.keyboard.press("Tab");
    await expect(checkbox).toBeFocused();
    if (remembered) await page.keyboard.press("Space");
    // Capture the login without exposing the password, even as masked text.
    await page.getByLabel("Dashboard password").fill("");
    await page.screenshot({
      path: `test-results/login-${remembered ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    await page
      .getByLabel("Dashboard password")
      .fill(process.env.DASHBOARD_PASSWORD);
    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(
      page.getByRole("heading", { name: "Your infrastructure", exact: true }),
    ).toBeVisible();
    const cookie = (await context.cookies()).find(
      (entry) => entry.name === "infra_session",
    );
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    const remaining = cookie.expires - Date.now() / 1000;
    const expected = remembered ? 2592000 : 43200;
    expect(remaining).toBeGreaterThan(expected - 60);
    expect(remaining).toBeLessThanOrEqual(expected);
    expect(
      await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
    ).not.toContain(process.env.DASHBOARD_PASSWORD);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Your infrastructure", exact: true }),
    ).toBeVisible();
  });
}
