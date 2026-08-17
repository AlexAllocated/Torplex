import { expect, test } from "@playwright/test";

const baseUrl = process.env.TORPLEX_E2E_MOCK_URL;

test("LCARS simulation supports operations and first-class AI acquisition", async ({ page }) => {
  test.skip(!baseUrl, "TORPLEX_E2E_MOCK_URL is required");
  test.setTimeout(30_000);

  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl!);
  await expect(page).toHaveTitle("Torplex Operations");
  await expect(page.locator(".lcars-shell")).toBeVisible();
  await expect(page.locator(".simulation-banner")).toContainText("no live torrent, Plex, or Pi systems connected");
  await expect(page.getByRole("link", { name: /Acquire/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find with AI" })).toBeVisible();
  await expect(page.locator("#connection")).toHaveText("Live", { timeout: 5_000 });
  await expect(page.locator("#items .item")).toHaveCount(6);
  await expect(page.locator("#vpnStatus")).toHaveClass(/verified/);
  await expect(page.locator(".map-peer-label")).toHaveCount(4);
  await page.locator("#tactical").scrollIntoViewIfNeeded();
  await expect(page.locator("#tactical")).toHaveAttribute("data-map-rendering", "running");

  const paintedSamples = async (selector: string) => page.locator(selector).evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4 * 32) {
      if (pixels[index] > 0) painted += 1;
    }
    return painted;
  });
  await expect.poll(() => paintedSamples("#worldMapRaster"), { timeout: 10_000 }).toBeGreaterThan(100);
  await expect.poll(() => paintedSamples("#worldCanvas"), { timeout: 10_000 }).toBeGreaterThan(100);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#quickSearch").fill("Acquire the complete Star Trek Picard series");
  await page.getByRole("button", { name: "Find with AI" }).click();
  await expect(page).toHaveURL(/\/add\?prompt=/);
  await expect(page.getByRole("tab", { name: /Find with AI/i })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#catalogSearchPrompt")).toHaveValue("Acquire the complete Star Trek Picard series");
  await page.locator("#searchRightsConfirmed").check();
  await page.getByRole("button", { name: "Build proposal" }).click();
  await expect(page.locator(".proposal-row")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator(".proposal-row")).toContainText("Complete series · S01-S03");
  await expect(page.getByRole("button", { name: "Prepare 1 selected" })).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(page.getByRole("button", { name: "Prepare 1 selected" })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("Galaxy and Intrepid interfaces preserve their Starfleet visual contracts", async ({ page }) => {
  test.skip(!baseUrl, "TORPLEX_E2E_MOCK_URL is required");
  test.setTimeout(60_000);

  type Theme = 'galaxy' | 'intrepid';
  const expected = {
    galaxy: {
      kicker: 'Library Computer Access / Retrieval System',
      body: 'rgb(186, 164, 229)',
      heading: 'rgb(186, 164, 229)',
      label: 'rgb(235, 148, 58)',
      active: 'rgb(252, 193, 159)',
      completed: 'rgb(153, 204, 102)',
      stripes: ['rgb(136, 153, 255)', 'rgb(235, 148, 58)', 'rgb(186, 164, 229)', 'rgb(186, 164, 229)', 'rgb(207, 79, 79)'],
      footer: ['rgb(207, 79, 79)', 'rgb(234, 156, 114)', 'rgb(207, 79, 79)', 'rgb(186, 164, 229)', 'rgb(234, 156, 114)'],
      breakpoints: {
        1440: { rail: 200, divider: 6.4, outer: 130, inner: 60, textBar: 40, footer: 24 },
        900: { rail: 150, divider: 6.4, outer: 100, inner: 40, textBar: 30, footer: 20 },
        390: { rail: 62, divider: 4.8, outer: 40, inner: 28, textBar: 24, footer: 10 },
      },
    },
    intrepid: {
      kicker: 'Intrepid-Class Integrated Data Network',
      body: 'rgb(112, 181, 255)',
      heading: 'rgb(255, 187, 51)',
      label: 'rgb(255, 187, 51)',
      active: 'rgb(233, 129, 129)',
      completed: 'rgb(148, 179, 0)',
      stripes: ['rgb(130, 140, 173)', 'rgb(255, 187, 51)', 'rgb(34, 136, 255)', 'rgb(130, 140, 173)'],
      footer: ['rgb(130, 140, 173)', 'rgb(255, 225, 202)', 'rgb(34, 136, 255)', 'rgb(130, 140, 173)', 'rgb(130, 140, 173)'],
      breakpoints: {
        1440: { rail: 200, divider: 8, outer: 100, inner: 44, textBar: 40, footer: 20 },
        900: { rail: 150, divider: 8, outer: 80, inner: 30, textBar: 30, footer: 20 },
        390: { rail: 62, divider: 5.52, outer: 30, inner: 24, textBar: 24, footer: 10 },
      },
    },
  } as const;

  const loadTheme = async (theme: Theme, width: 1440 | 900 | 390, path = '/') => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    if (page.url() === 'about:blank') {
      await page.goto(baseUrl!);
    }
    await page.evaluate((value) => localStorage.setItem('torplex:interface-theme', value), theme);
    await page.goto(`${baseUrl}${path}`);
    await expect(page.locator('html')).toHaveAttribute('data-interface-theme', theme);
    if (path === '/') {
      await expect(page.locator('#connection')).toHaveText('Live', { timeout: 5_000 });
      await expect(page.locator('#items .item')).toHaveCount(6);
    }
  };

  const visualContract = () => page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const rail = rect('.lcars-rail');
    const workspace = rect('.lcars-workspace');
    const cap = rect('.lcars-rail-cap');
    const frameDivider = rect('.lcars-frame-divider');
    const nav = rect('.lcars-nav');
    const header = rect('.lcars-header');
    const workspaceDivider = rect('.lcars-workspace-divider');
    const content = rect('.lcars-content');
    const footer = rect('.lcars-footer');
    const footerSegments = [...document.querySelectorAll('.lcars-footer span')].map((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        height: box.height,
        color: getComputedStyle(element).backgroundColor,
      };
    });
    const itemChildrenFit = [...document.querySelectorAll('#items .item')].every((item) => {
      const parent = item.getBoundingClientRect();
      return [...item.children].filter(visible).every((child) => {
        const box = child.getBoundingClientRect();
        return box.left >= parent.left - 1 && box.right <= parent.right + 1
          && box.top >= parent.top - 1 && box.bottom <= parent.bottom + 1;
      });
    });
    const interactiveElementsFit = [...document.querySelectorAll('button, a, input, textarea, select, [role="tab"]')]
      .filter(visible)
      .every((element) => {
        const box = element.getBoundingClientRect();
        return box.left >= -1 && box.right <= document.documentElement.clientWidth + 1;
      });
    const rows = [...document.querySelectorAll('#items .item')].map((item) => item.getBoundingClientRect());
    const textLine = rect('.lcars-text-bar i');
    const textTerminal = rect('.lcars-text-bar b');
    const capStyle = getComputedStyle(document.querySelector('.lcars-rail-cap')!);
    const capElbow = getComputedStyle(document.querySelector('.lcars-rail-cap')!, '::after');
    const navElbow = getComputedStyle(document.querySelector('.lcars-nav a:first-child')!);
    const innerElbow = getComputedStyle(document.querySelector('.lcars-section-heading .section-index')!);
    return {
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyFont: getComputedStyle(document.body).fontFamily,
      bodyColor: getComputedStyle(document.body).color,
      headingColor: getComputedStyle(document.querySelector('.lcars-section-heading h1')!).color,
      labelColor: getComputedStyle(document.querySelector('.section-eyebrow')!).color,
      activeColor: getComputedStyle(document.querySelector('.item.active')!).borderLeftColor,
      completedColor: getComputedStyle(document.querySelector('.item.completed')!).borderLeftColor,
      railWidth: rail.width,
      railWorkspaceGap: workspace.left - rail.right,
      capTopLeft: capStyle.borderTopLeftRadius,
      capElbow: parseFloat(capElbow.borderBottomLeftRadius),
      navElbow: parseFloat(navElbow.borderTopLeftRadius),
      innerElbow: parseFloat(innerElbow.borderTopLeftRadius),
      dividerHeight: frameDivider.height,
      frameSeamDeltas: [
        Math.abs(cap.bottom - frameDivider.top),
        Math.abs(header.bottom - workspaceDivider.top),
        Math.abs(frameDivider.bottom - nav.top),
        Math.abs(workspaceDivider.bottom - content.top),
        Math.abs(frameDivider.top - workspaceDivider.top),
        Math.abs(frameDivider.bottom - workspaceDivider.bottom),
      ],
      stripes: [...document.querySelectorAll('.lcars-header-stripe span')]
        .filter(visible)
        .map((element) => getComputedStyle(element).backgroundColor),
      footerHeight: footer.height,
      footerSegments,
      footerFits: footerSegments.every((segment, index) => segment.left >= footer.left - .5
        && segment.right <= footer.right + .5
        && (index === 0 || segment.left >= footerSegments[index - 1].right - .5)),
      textBarHeight: textLine.height,
      textBarAligned: textLine.height === textTerminal.height
        && Math.abs((textLine.top + textLine.height / 2) - (textTerminal.top + textTerminal.height / 2)) < .5,
      rowsOrdered: rows.every((row, index) => index === 0 || row.top >= rows[index - 1].bottom),
      itemChildrenFit,
      interactiveElementsFit,
    };
  });

  const assertContract = async (theme: Theme, width: 1440 | 900 | 390) => {
    await loadTheme(theme, width);
    const actual = await visualContract();
    const contract = expected[theme];
    const geometry = contract.breakpoints[width];
    expect(actual.scrollWidth).toBe(actual.viewport);
    expect(actual.bodyFont).toBe('Antonio, "Arial Narrow", "Avenir Next Condensed", sans-serif');
    expect(actual.bodyColor).toBe(contract.body);
    expect(actual.headingColor).toBe(contract.heading);
    expect(actual.labelColor).toBe(contract.label);
    expect(actual.activeColor).toBe(contract.active);
    expect(actual.completedColor).toBe(contract.completed);
    expect(actual.railWidth).toBeCloseTo(geometry.rail, 1);
    expect(actual.railWorkspaceGap).toBeCloseTo(0, 1);
    expect(actual.capTopLeft).toBe('0px');
    expect(actual.capElbow).toBeCloseTo(geometry.outer, 1);
    expect(actual.navElbow).toBeCloseTo(geometry.outer, 1);
    expect(actual.innerElbow).toBeCloseTo(geometry.inner, 1);
    expect(actual.dividerHeight).toBeCloseTo(geometry.divider, 1);
    expect(Math.max(...actual.frameSeamDeltas)).toBeLessThan(.6);
    expect(actual.stripes).toEqual(contract.stripes);
    expect(actual.footerHeight).toBeCloseTo(geometry.footer, 1);
    expect(actual.footerSegments.map(({ color }) => color)).toEqual(contract.footer);
    expect(actual.footerFits).toBe(true);
    expect(actual.textBarHeight).toBeCloseTo(geometry.textBar, 1);
    expect(actual.textBarAligned).toBe(true);
    expect(actual.rowsOrdered).toBe(true);
    expect(actual.itemChildrenFit).toBe(true);
    expect(actual.interactiveElementsFit).toBe(true);
  };

  await page.goto(baseUrl!);
  await page.evaluate(() => localStorage.removeItem('torplex:interface-theme'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-interface-theme', 'galaxy');
  await expect(page.locator('body')).toHaveAttribute('data-lcars-audio', /armed|online|muted/);

  await assertContract('galaxy', 1440);
  await expect(page.locator('.lcars-kicker')).toHaveText(expected.galaxy.kicker);
  const themeTrigger = page.getByRole('button', { name: /Change interface theme/ });
  await themeTrigger.click();
  await expect(themeTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitemradio')).toHaveCount(2);
  await page.getByRole('menuitemradio', { name: /Intrepid Class/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-interface-theme', 'intrepid');
  await expect(page.locator('.lcars-kicker')).toHaveText(expected.intrepid.kicker);
  expect(await page.evaluate(() => localStorage.getItem('torplex:interface-theme'))).toBe('intrepid');

  for (const width of [1440, 900, 390] as const) {
    for (const theme of ['galaxy', 'intrepid'] as const) {
      await assertContract(theme, width);
    }
  }

  for (const theme of ['galaxy', 'intrepid'] as const) {
    await loadTheme(theme, 390, '/add');
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const addFits = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      return [...document.querySelectorAll('button, a, textarea, select, [role="tab"], .search-workspace, .bulk-workspace')]
        .filter((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        })
        .every((element) => {
          const box = element.getBoundingClientRect();
          return box.left >= -1 && box.right <= viewport + 1;
        });
    });
    expect(addFits).toBe(true);
  }
});
