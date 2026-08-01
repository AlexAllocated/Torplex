import { expect, test } from "@playwright/test";

const baseUrl = process.env.TORPLEX_E2E_URL;
const password = process.env.TORPLEX_E2E_PASSWORD;
const torrentPath = process.env.TORPLEX_E2E_TORRENT;

test("torrent intake supports reviewed file selection and Smart Setup", async ({ page }) => {
  test.skip(!baseUrl || !password || !torrentPath, "Torplex URL, password, and a torrent fixture are required");
  test.setTimeout(180_000);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(new URL("/auth/login", baseUrl!).toString());
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("button", { name: "Add Torrent" }).click();

  const inspected = page.waitForResponse((response) => response.url().endsWith("/api/torrent/inspect") && response.ok());
  await page.locator("#torrentFile").setInputFiles(torrentPath!);
  await inspected;
  await expect(page.locator("#torrentFileTree input[data-role='file-selection']")).toHaveCount(259);
  await expect(page.locator("#selectionSummary")).toContainText("259 of 259 files selected");
  await expect(page.getByRole("button", { name: "Add selected content" })).toBeDisabled();

  await page.getByLabel(/I confirm that I have the rights/).check();
  await expect(page.getByRole("button", { name: "Add selected content" })).toBeEnabled();
  await page.locator("#additionalInstructions").fill(
    "Download only Avatar: The Last Airbender animated series and The Legend of Korra. Include all episodes and matching English captions. Exclude the 2010 live-action movie and unrelated extras.",
  );
  const planned = page.waitForResponse((response) => response.url().endsWith("/api/torrent/plan"));
  await page.getByRole("button", { name: "Fill with Smart Setup" }).click();
  expect((await planned).ok()).toBe(true);

  await expect(page.locator("#smartSetupStatus")).toContainText("plan applied", { timeout: 150_000 });
  await expect(page.locator("#selectionSummary")).toContainText("226 of 259 files selected");
  await expect(page.locator("#organizeStrategy")).toHaveValue("routeDirectories");
  await expect(page.locator("#routeRows .route-row")).toHaveCount(7);
  await expect(page.locator("#smartPlanReview")).toContainText("HIGH confidence");
  await page.locator("#routeEditor").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/home/alex/code/Torplex/test-results/torplex-intake-smart-plan.png", fullPage: false });
});
