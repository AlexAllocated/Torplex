import { expect, test } from "@playwright/test";

const baseUrl = process.env.TORPLEX_E2E_URL;
const password = process.env.TORPLEX_E2E_PASSWORD;
const expectedOriginLabel = process.env.TORPLEX_E2E_ORIGIN_LABEL;
const requirePeers = process.env.TORPLEX_E2E_REQUIRE_PEERS === "1";
const requireMappedOrigin = process.env.TORPLEX_E2E_REQUIRE_MAPPED_ORIGIN === "1";
const requireVpn = process.env.TORPLEX_E2E_REQUIRE_VPN === "1";
const testReorder = process.env.TORPLEX_E2E_REORDER === "1";

async function powerOn(page: import("@playwright/test").Page) {
  const boot = page.locator("#crtBootTrigger");
  await expect(boot).toBeVisible();
  await boot.click();
  await expect(page.locator("body")).toHaveClass(/crt-powered-on/);
}

test("authenticated dashboard renders live swarm telemetry", async ({ page }, testInfo) => {
  test.skip(!baseUrl || !password, "TORPLEX_E2E_URL and TORPLEX_E2E_PASSWORD are required");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl!);
  await expect(page.locator('.theme-dot')).toHaveCount(6);
  await page.getByRole('button', { name: 'Purple phosphor' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-crt-theme', 'purple');
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Unlock" }).click();
  await powerOn(page);
  await expect(page).toHaveTitle("Torplex");
  await expect(page.locator('.crt-theme-dot')).toHaveCount(6);
  await expect(page.locator('html')).toHaveAttribute('data-crt-theme', 'purple');
  const themes = {
    red: '248 72 72',
    orange: '251 146 60',
    yellow: '250 204 21',
    green: '74 222 128',
    blue: '59 130 246',
    purple: '168 85 247',
  };
  for (const [theme, expectedRgb] of Object.entries(themes)) {
    await page.locator(`.crt-theme-dot[data-theme="${theme}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-crt-theme', theme);
    const rgb = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--phosphor-main').trim());
    expect(rgb).toBe(expectedRgb);
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-crt-theme', 'purple');
  await expect(page.locator('body')).toHaveClass(/crt-powering-on/);
  await expect(page.locator('body')).toHaveClass(/crt-powered-on/);
  await page.locator('.crt-theme-dot[data-theme="green"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-crt-theme', 'green');
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      loaded: document.fonts.check('16px "BigBlue TerminalPlus"'),
      family: getComputedStyle(document.body).fontFamily,
    };
  });
  expect(font.loaded).toBe(true);
  expect(font.family).toContain("BigBlue TerminalPlus");
  if (requirePeers) await expect(page.locator("#routeStatus")).toContainText("mapped", { timeout: 20_000 });
  else await expect(page.locator("#routeStatus")).not.toContainText("Waiting for peer telemetry", { timeout: 20_000 });

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/status");
    return await response.json();
  });
  if (expectedOriginLabel) expect(status.swarm.origin.label).toBe(expectedOriginLabel);
  expect(Number.isFinite(status.swarm.origin.lat) && Number.isFinite(status.swarm.origin.lon)).toBe(true);
  if (requireMappedOrigin) expect(status.swarm.origin.lookupStatus).toBe("mapped");
  if (requireVpn) {
    expect(status.swarm.vpn.connected).toBe(true);
    expect(status.swarm.vpn.verified).toBe(true);
    expect(status.swarm.relay.lookupStatus).toBe("mapped");
    expect(status.swarm.relay.lat).not.toBe(status.swarm.origin.lat);
    expect(status.swarm.relay.lon).not.toBe(status.swarm.origin.lon);
    await expect(page.locator("#vpnStatus")).toHaveClass(/verified/);
  }
  if (requirePeers) {
    expect(status.swarm.peers.length).toBeGreaterThan(0);
    expect(status.swarm.peers.some((peer: { lookupStatus?: string }) => peer.lookupStatus === "mapped")).toBe(true);
  }
  expect(status.swarm.activeCount + status.swarm.probingCount + status.swarm.inactiveCount).toBe(status.swarm.peers.length);
  const pendingCount = status.items.filter((item: { status?: string }) => item.status === "pending").length;
  const activeCount = status.items.filter((item: { status?: string }) => item.status === "active" || item.status === "organizing").length;
  await expect(page.locator('.item.pending [data-role="drag-handle"]')).toHaveCount(pendingCount);
  const activeShapes = await page.locator('.item.active .torrent-marker, .item.organizing .torrent-marker').evaluateAll((markers) =>
    markers.map((marker) => (marker as HTMLElement).dataset.shape),
  );
  expect(activeShapes).toHaveLength(activeCount);
  expect(new Set(activeShapes).size).toBe(Math.min(activeShapes.length, 12));
  if (activeShapes.length) {
    const markerSize = await page.locator('.item.active .torrent-marker, .item.organizing .torrent-marker').first().evaluate((marker) => {
      const rect = marker.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(markerSize.width).toBeGreaterThanOrEqual(20);
    expect(markerSize.height).toBeGreaterThanOrEqual(20);
  }
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
  if (requirePeers) {
    const peerLabel = page.locator('.map-peer-label').first();
    await expect(peerLabel).toBeVisible({ timeout: 15_000 });
    const transitionProperty = await peerLabel.evaluate((label) => getComputedStyle(label).transitionProperty);
    expect(transitionProperty).not.toContain('max-width');
    await peerLabel.hover();
    await expect.poll(async () => (await peerLabel.locator('.map-peer-detail').textContent())?.length || 0).toBeGreaterThan(8);
    await page.mouse.move(0, 0);
    await expect.poll(async () => await peerLabel.locator('.map-peer-detail').textContent()).toBe('');
  }

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
  await page.addStyleTag({ content: "#items .item { content-visibility: visible !important; }" });
  const overlappingRows = await page.locator("#items .item").evaluateAll((rows) => rows.flatMap((row) => {
    const title = row.querySelector('[data-role="title"]')?.getBoundingClientRect();
    const status = row.querySelector(".item-status")?.getBoundingClientRect();
    if (!title || !status || title.right <= status.left + 1) return [];
    return [row.querySelector('[data-role="title"]')?.textContent || "untitled"];
  }));
  expect(overlappingRows).toEqual([]);
  const queueColumns = await page.locator("#items .item").evaluateAll((rows) => rows.map((row) => ({
    title: row.querySelector(".item-title")!.getBoundingClientRect().left,
    status: row.querySelector(".item-status")!.getBoundingClientRect().left,
    progress: row.querySelector(".item-progress")!.getBoundingClientRect().left,
  })));
  for (const column of ["title", "status", "progress"] as const) {
    const positions = queueColumns.map((row) => row[column]);
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/torplex-pi-${testInfo.project.name}-mobile.png` });

  const mapFrame = page.locator(".world-map-frame");
  await mapFrame.scrollIntoViewIfNeeded();
  await mapFrame.evaluate((frame) => {
    const rect = frame.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const pointer = (type: string, pointerId: number, clientX: number, clientY: number) =>
      frame.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId,
        pointerType: "touch",
        isPrimary: pointerId === 1,
        clientX,
        clientY,
      }));
    pointer("pointerdown", 1, centerX - 30, centerY);
    pointer("pointerdown", 2, centerX + 30, centerY);
    pointer("pointermove", 1, centerX - 75, centerY);
    pointer("pointermove", 2, centerX + 75, centerY);
    pointer("pointerup", 1, centerX - 75, centerY);
    pointer("pointerup", 2, centerX + 75, centerY);
  });
  await expect.poll(async () => Number(await mapFrame.getAttribute("data-zoom"))).toBeGreaterThan(2);

  await mapFrame.evaluate((frame) => frame.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await expect(mapFrame).toHaveAttribute("data-zoom", "1.00");

  await mapFrame.evaluate((frame) => {
    Object.defineProperty(frame, "requestFullscreen", { configurable: true, value: undefined });
    Object.defineProperty(frame, "webkitRequestFullscreen", { configurable: true, value: undefined });
  });
  await page.locator("#fullscreenMap").click();
  await expect(mapFrame).toHaveClass(/pseudo-fullscreen/);
  await expect(page.locator("body")).toHaveClass(/map-fullscreen-open/);
  await expect(page.locator('.crt-theme-switcher')).toBeHidden();
  await expect(page.locator("#fullscreenMap")).toHaveAttribute("aria-label", "Exit fullscreen map");
  const fullscreenGeometry = await mapFrame.evaluate((frame) => {
    const frameRect = frame.getBoundingClientRect();
    const viewportRect = frame.querySelector(".world-map-viewport")!.getBoundingClientRect();
    return {
      frameLeft: frameRect.left,
      frameTop: frameRect.top,
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
      viewportLeft: viewportRect.left,
      viewportTop: viewportRect.top,
      viewportWidth: viewportRect.width,
      viewportHeight: viewportRect.height,
    };
  });
  expect(Math.abs(fullscreenGeometry.frameLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(fullscreenGeometry.frameTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(fullscreenGeometry.viewportLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(fullscreenGeometry.viewportTop)).toBeLessThanOrEqual(1);
  expect(fullscreenGeometry.frameWidth).toBeGreaterThanOrEqual(389);
  expect(fullscreenGeometry.frameHeight).toBeGreaterThanOrEqual(843);
  expect(fullscreenGeometry.viewportWidth).toBeGreaterThanOrEqual(389);
  expect(fullscreenGeometry.viewportHeight).toBeGreaterThanOrEqual(843);
  await page.screenshot({ path: `/tmp/torplex-pi-${testInfo.project.name}-mobile-fullscreen.png` });
  await page.locator("#fullscreenMap").click();
  await expect(mapFrame).not.toHaveClass(/map-fullscreen-active/);

  await page.locator("#logoutButton").click();
  await page.waitForURL(/\/auth\/login$/);
  const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === "plex_batch_session");
  expect(sessionCookie).toBeUndefined();
});

test("pending rows can be reprioritized across multiple positions", async ({ page }) => {
  test.skip(!baseUrl || !password || !testReorder, "Live reorder test is opt-in");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Unlock" }).click();
  await powerOn(page);

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
    await page.evaluate(() => {
      const nativeAnimate = Element.prototype.animate;
      (window as Window & { __queueReflowAnimations?: number }).__queueReflowAnimations = 0;
      Element.prototype.animate = function (...args) {
        if (this instanceof HTMLElement && this.classList.contains("item")) {
          const target = window as Window & { __queueReflowAnimations?: number };
          target.__queueReflowAnimations = (target.__queueReflowAnimations ?? 0) + 1;
        }
        return Reflect.apply(nativeAnimate, this, args);
      };
    });
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
    expect(await page.evaluate(() => (window as Window & { __queueReflowAnimations?: number }).__queueReflowAnimations ?? 0)).toBeGreaterThan(0);
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
