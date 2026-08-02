import { expect, test } from "@playwright/test";

const baseUrl = process.env.TORPLEX_E2E_URL;
const password = process.env.TORPLEX_E2E_PASSWORD;
const torrentPath = process.env.TORPLEX_E2E_TORRENT;
const magnetUri = process.env.TORPLEX_E2E_MAGNET;

async function unlock(page: import("@playwright/test").Page) {
  await page.goto(new URL("/auth/login", baseUrl!).toString());
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("button", { name: "Add Torrent" }).click();
  await expect(page).toHaveURL(/\/add$/);
}

test("torrent intake uses normal document scrolling on mobile", async ({ page }) => {
  test.skip(!baseUrl || !password, "Torplex URL and password are required");

  await page.setViewportSize({ width: 390, height: 844 });
  await unlock(page);
  await expect(page.locator("dialog")).toHaveCount(0);
  const metrics = await page.evaluate(() => ({
    innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    bodyOverflow: getComputedStyle(document.body).overflowY,
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.innerHeight);
  expect(metrics.bodyOverflow).not.toBe("hidden");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Add 0 selected items" })).toBeVisible();
});

test("torrent intake supports reviewed file selection and Smart Setup", async ({ page }) => {
  test.skip(!baseUrl || !password || !torrentPath, "Torplex URL, password, and a torrent fixture are required");
  test.setTimeout(180_000);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await unlock(page);

  const item = page.locator(".bulk-intake-item").first();
  await item.getByLabel("Smart Setup instructions Optional").fill(
    "Download only Avatar: The Last Airbender animated series and The Legend of Korra. Include all episodes and matching English captions. Exclude the 2010 live-action movie and unrelated extras.",
  );
  const inspected = page.waitForResponse((response) => response.url().endsWith("/api/torrent/inspect") && response.ok());
  const planned = page.waitForResponse((response) => response.url().endsWith("/api/torrent/plan"));
  await item.getByLabel("Torrent file").setInputFiles(torrentPath!);
  await inspected;
  await item.getByText("Files, Smart Setup, and advanced organization").click();
  await expect(item.locator(".bulk-file-tree input[type='checkbox']")).toHaveCount(259);
  await expect(item.locator(".bulk-item-title")).toContainText("259 of 259 files");
  await expect(page.getByRole("button", { name: "Add 0 selected items" })).toBeDisabled();

  expect((await planned).ok()).toBe(true);

  await expect(item.locator(".status-pill")).toContainText("plan ready", { timeout: 150_000 });
  await expect(page.getByRole("button", { name: "Add 1 selected item" })).toBeDisabled();
  await page.getByLabel(/I confirm that I have the rights/).check();
  await expect(page.getByRole("button", { name: "Add 1 selected item" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Run Smart Setup again" })).toBeEnabled();
  await expect(item.locator(".bulk-item-title")).toContainText("226 of 259 files");
  await expect(item.getByLabel("Organizer")).toHaveValue("routeDirectories");
  await expect(item.locator(".route-row")).toHaveCount(7);
  await expect(item.locator(".smart-plan-review")).toContainText("Confidence: high");
  await item.locator(".route-editor").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/home/alex/code/Torplex/test-results/torplex-intake-smart-plan.png", fullPage: false });
});

test("magnet metadata automatically starts Smart Setup before rights confirmation", async ({ page }) => {
  test.skip(!baseUrl || !password || !magnetUri, "Torplex URL, password, and a magnet fixture are required");
  test.setTimeout(180_000);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await unlock(page);
  const inspected = page.waitForResponse((response) => response.url().endsWith("/api/torrent/inspect"));
  const planned = page.waitForResponse((response) => response.url().endsWith("/api/torrent/plan"));
  const item = page.locator(".bulk-intake-item").first();
  await item.getByLabel("Magnet or link").fill(magnetUri!);
  expect((await inspected).ok()).toBe(true);
  await item.getByLabel("Magnet or link").press("Tab");
  expect((await planned).ok()).toBe(true);

  await item.getByText("Files, Smart Setup, and advanced organization").click();
  await expect(item.locator(".bulk-file-tree input[type='checkbox']")).not.toHaveCount(0);
  await expect(item.locator(".status-pill")).toContainText("plan ready", { timeout: 150_000 });
  await expect(page.getByRole("button", { name: "Add 1 selected item" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Run Smart Setup again" })).toBeEnabled();
});
