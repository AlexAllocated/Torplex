import { expect, test } from "@playwright/test";

const baseUrl = process.env.TORPLEX_E2E_URL;
const password = process.env.TORPLEX_E2E_PASSWORD;
const expectedOriginLabel = process.env.TORPLEX_E2E_ORIGIN_LABEL;
const requirePeers = process.env.TORPLEX_E2E_REQUIRE_PEERS === "1";
const requireMappedOrigin = process.env.TORPLEX_E2E_REQUIRE_MAPPED_ORIGIN === "1";
const testReorder = process.env.TORPLEX_E2E_REORDER === "1";

test("authenticated dashboard renders live swarm telemetry", async ({ page }, testInfo) => {
  test.skip(!baseUrl || !password, "TORPLEX_E2E_URL and TORPLEX_E2E_PASSWORD are required");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveTitle("Torplex");
  if (requirePeers) await expect(page.locator("#routeStatus")).toContainText("mapped", { timeout: 20_000 });
  else await expect(page.locator("#routeStatus")).not.toContainText("Waiting for peer telemetry", { timeout: 20_000 });

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/status");
    return await response.json();
  });
  if (expectedOriginLabel) expect(status.swarm.origin.label).toBe(expectedOriginLabel);
  expect(Number.isFinite(status.swarm.origin.lat) && Number.isFinite(status.swarm.origin.lon)).toBe(true);
  if (requireMappedOrigin) expect(status.swarm.origin.lookupStatus).toBe("mapped");
  if (requirePeers) {
    expect(status.swarm.peers.length).toBeGreaterThan(0);
    expect(status.swarm.peers.some((peer: { lookupStatus?: string }) => peer.lookupStatus === "mapped")).toBe(true);
  }
  expect(status.swarm.activeCount + status.swarm.probingCount + status.swarm.inactiveCount).toBe(status.swarm.peers.length);
  const pendingCount = status.items.filter((item: { status?: string }) => item.status === "pending").length;
  await expect(page.locator('.item.pending [data-role="drag-handle"]')).toHaveCount(pendingCount);
  if (pendingCount) await expect(page.locator('.item.pending [data-role="drag-handle"]').first()).toHaveAttribute("draggable", "true");

  await expect(page.locator("#worldCanvas")).toBeVisible();
  const paintedSamples = async (selector: string) => await page.locator(selector).evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4 * 32) {
      if (pixels[index] > 0) painted += 1;
    }
    return painted;
  });
  await expect.poll(() => paintedSamples("#worldMapRaster"), { timeout: 15_000 }).toBeGreaterThan(100);
  await expect.poll(() => paintedSamples("#worldCanvas"), { timeout: 15_000 }).toBeGreaterThan(100);

  await page.screenshot({ path: `/tmp/torplex-pi-${testInfo.project.name}-desktop.png` });
  const firstPendingItem = page.locator("#items .item.pending").first();
  if (pendingCount) {
    await firstPendingItem.scrollIntoViewIfNeeded();
    const handle = firstPendingItem.locator('[data-role="drag-handle"]');
    await expect(handle).toBeVisible();
    const geometry = await firstPendingItem.evaluate((row) => {
      const rowRect = row.getBoundingClientRect();
      const handleRect = row.querySelector('[data-role="drag-handle"]')!.getBoundingClientRect();
      const titleRect = row.querySelector('[data-role="title"]')!.getBoundingClientRect();
      const sizeRect = row.querySelector('[data-role="size"]')!.getBoundingClientRect();
      return {
        handleTop: handleRect.top - rowRect.top,
        handleBottom: rowRect.bottom - handleRect.bottom,
        titleLeft: titleRect.left,
        sizeLeft: sizeRect.left,
      };
    });
    expect(Math.abs(geometry.handleTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.handleBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.titleLeft - geometry.sizeLeft)).toBeLessThan(1);
    await page.screenshot({ path: `/tmp/torplex-pi-${testInfo.project.name}-queue-pending.png` });
  }
  const lastQueueItem = page.locator("#items .item").last();
  await lastQueueItem.scrollIntoViewIfNeeded();
  await expect(lastQueueItem).toBeVisible();
  await expect(lastQueueItem.locator('[data-role="title"]')).toBeVisible();
  await expect(lastQueueItem.locator('[data-role="title"]')).not.toBeEmpty();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/tmp/torplex-pi-${testInfo.project.name}-queue-bottom.png` });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/torplex-pi-${testInfo.project.name}-mobile.png` });
});

test("pending rows can be reprioritized across multiple positions", async ({ page }) => {
  test.skip(!baseUrl || !password || !testReorder, "Live reorder test is opt-in");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Unlock" }).click();

  const originalIds = await page.evaluate(async () => {
    const status = await (await fetch("/api/status")).json();
    return status.items
      .filter((item: { status?: string }) => item.status === "active" || item.status === "organizing" || item.status === "pending")
      .map((item: { id: string }) => item.id);
  });
  const originalPendingIds = await page.evaluate(async () => {
    const status = await (await fetch("/api/status")).json();
    return status.items.filter((item: { status?: string }) => item.status === "pending").map((item: { id: string }) => item.id);
  });
  test.skip(originalPendingIds.length < 3, "At least three pending items are required");

  try {
    const pendingRows = page.locator("#items .item.pending");
    const targetIndex = Math.min(3, originalPendingIds.length - 1);
    await pendingRows.first().scrollIntoViewIfNeeded();
    const reordered = page.waitForResponse((response) =>
      response.url().endsWith("/api/torrents/reorder") && response.request().method() === "POST",
    );
    await pendingRows.first().locator('[data-role="drag-handle"]').dragTo(pendingRows.nth(targetIndex), {
      targetPosition: { x: 80, y: 70 },
    });
    expect((await reordered).ok()).toBe(true);
    const expectedPendingIds = [...originalPendingIds];
    expectedPendingIds.splice(targetIndex, 0, expectedPendingIds.shift()!);
    await expect.poll(async () => page.evaluate(async () => {
      const status = await (await fetch("/api/status")).json();
      return status.items.filter((item: { status?: string }) => item.status === "pending").map((item: { id: string }) => item.id);
    })).toEqual(expectedPendingIds);
  } finally {
    await page.evaluate(async (ids) => {
      await fetch("/api/torrents/reorder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    }, originalIds);
  }
});
