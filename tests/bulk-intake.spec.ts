import { expect, test } from "@playwright/test";

const baseUrl = process.env.TORPLEX_E2E_URL;
const password = process.env.TORPLEX_E2E_PASSWORD;

function ndjson(payload: Record<string, unknown>) {
  return `${JSON.stringify({ type: "progress", message: "Working" })}\n${JSON.stringify({ type: "result", ...payload })}\n`;
}

async function checkWarpedControl(locator: ReturnType<import("@playwright/test").Page["locator"]>) {
  await locator.evaluate((element: HTMLInputElement) => element.click());
  await expect(locator).toBeChecked();
}

test("AI search proposals become independently planned bulk intake items", async ({ page }) => {
  test.skip(!baseUrl || !password, "Torplex URL and password are required");
  test.setTimeout(60_000);

  const works = [
    { id: "alpha-2001", title: "Alpha", year: 2001, type: "movie", searchQuery: "Alpha 2001", notes: "", requiredSeasons: [] },
    { id: "beta-2002", title: "Beta", year: 2002, type: "movie", searchQuery: "Beta 2002", notes: "", requiredSeasons: [] },
  ];
  await page.route("**/api/torrent/search", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: ndjson({
        proposal: {
          summary: "Two exact films found",
          works,
          alreadyOwned: [{
            inventoryItem: { id: "plex-movie-42", title: "Event Horizon", year: 1997, type: "movie", source: "plex", status: "in library" },
            reason: "Excluded because it is already in Plex",
          }],
          selections: works.map((work, index) => ({
            selectionId: work.id,
            workId: work.id,
            targetId: work.id,
            scopeLabel: "Movie",
            seasonNumber: null,
            candidateId: `candidate-${index}`,
            reason: "Exact title, year, and healthy swarm",
            confidence: "high",
            work,
            candidate: {
              id: `candidate-${index}`,
              workId: work.id,
              name: `${work.title}.${work.year}.1080p.WEB-DL`,
              sourceUrl: `magnet:?xt=urn:btih:${index === 0 ? "A".repeat(40) : "B".repeat(40)}`,
              descriptionUrl: "",
              providerUrl: "https://example.test",
              provider: "example.test",
              sizeBytes: 4_000_000_000,
              seeders: 42 - index,
              leechers: 2,
              publishedAt: 1,
            },
            alternatives: index === 0 ? [{
              id: "candidate-alpha-fallback",
              workId: work.id,
              name: `${work.title}.${work.year}.1080p.BluRay.FALLBACK`,
              sourceUrl: `magnet:?xt=urn:btih:${"C".repeat(40)}`,
              descriptionUrl: "",
              providerUrl: "https://fallback.example.test",
              provider: "fallback.example.test",
              sizeBytes: 4_100_000_000,
              seeders: 38,
              leechers: 1,
              publishedAt: 2,
            }] : [],
            metadata: {
              payloadName: `${work.title} (${work.year})`,
              totalBytes: 4_000_001_024,
              fileCount: 2,
              sampleFiles: [`${work.title} (${work.year})/${work.title} (${work.year}).mkv`],
              seasonNumbers: [],
            },
          })),
          missing: [],
          providers: ["fixture"],
          model: "fixture-model",
        },
      }),
    });
  });
  let primaryFailures = 0;
  let fallbackInspections = 0;
  await page.route("**/api/torrent/inspect", async (route) => {
    const body = route.request().postData() || "";
    if (body.includes("AAAAAAAA")) {
      primaryFailures += 1;
      await route.fulfill({
        status: 408,
        contentType: "application/json",
        body: JSON.stringify({ error: "No connected peer supplied this magnet's file list within 150 seconds." }),
      });
      return;
    }
    if (body.includes("CCCCCCCC")) fallbackInspections += 1;
    const beta = body.includes("BBBBBBBB");
    const title = beta ? "Beta (2002)" : "Alpha (2001)";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        payloadName: title,
        fileCount: 2,
        totalBytes: 4_000_001_024,
        files: [
          { index: 1, path: `${title}/${title}.mkv`, length: 4_000_000_000 },
          { index: 2, path: `${title}/${title}.en.srt`, length: 1024 },
        ],
        suggested: {
          title,
          id: beta ? "beta-2002" : "alpha-2001",
          mediaType: "movie",
          destinationPath: `/tmp/torplex-media/Movies/${title}`,
          organizeStrategy: "mergeRoot",
          targetSubdir: "",
        },
        smartSetup: { available: true, model: "fixture-model" },
      }),
    });
  });
  await page.route("**/api/torrent/plan", async (route) => {
    const body = route.request().postData() || "";
    const beta = body.includes("BBBBBBBB");
    const title = beta ? "Beta (2002)" : "Alpha (2001)";
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: ndjson({
        model: "fixture-model",
        plan: {
          summary: `${title} is ready`, confidence: "high", selectedFiles: [1, 2], title,
          id: beta ? "beta-2002" : "alpha-2001", mediaType: "movie",
          destinationPath: `/tmp/torplex-media/Movies/${title}`, organizeStrategy: "mergeRoot", targetSubdir: "", routes: [],
          decisions: ["Selected the feature and English captions."], warnings: [],
          postDownloadChecks: { verifyStreams: true, scanForMalware: true, ensureEnglishSubtitles: true, verifyCanonicalMetadata: true, verifyArtwork: true, validateMetadataWithAi: true, refreshPlex: true },
        },
      }),
    });
  });
  let bulkSubmitted = false;
  await page.route("**/api/torrents/bulk", async (route) => {
    bulkSubmitted = true;
    const body = route.request().postData() || "";
    expect(body).toContain("alpha-2001");
    expect(body).toContain("beta-2002");
    expect(body).toContain("CCCCCCCC");
    expect(body).not.toContain("AAAAAAAA");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, items: [{}, {}], restartMessage: "Queued 2 items" }) });
  });

  await page.goto(new URL("/auth/login", baseUrl!).toString());
  await page.locator("#crtBootTrigger").click();
  await expect(page.locator("body")).toHaveClass(/crt-powered-on/);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("button", { name: "Add Torrent" }).click();
  await expect(page.locator("body")).toHaveClass(/crt-powered-on/);
  await expect(page.locator("#crtBootTrigger")).toBeHidden();
  await page.getByRole("tab", { name: "Find with AI" }).click();
  await page.getByLabel("What do you want to find?").fill("Find both fixture films");
  await checkWarpedControl(page.getByLabel(/I will use these search results only/));
  await page.getByRole("button", { name: "Build proposal" }).click();
  await expect(page.locator(".proposal-row")).toHaveCount(2);
  await expect(page.getByText("Event Horizon (1997)")).toBeVisible();
  await expect(page.getByText("1 existing title skipped")).toBeVisible();
  await page.screenshot({ path: "/home/alex/code/Torplex/test-results/torplex-search-proposal.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Prepare 2 selected" })).toBeVisible();
  await page.screenshot({ path: "/home/alex/code/Torplex/test-results/torplex-search-proposal-mobile.png", fullPage: false });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Prepare 2 selected" }).click();
  await expect(page.locator(".bulk-intake-item")).toHaveCount(2);
  await expect(page.locator(".bulk-intake-item.ready")).toHaveCount(2);
  await expect(page.getByText("Fallback source active")).toBeVisible();
  expect(primaryFailures).toBe(1);
  expect(fallbackInspections).toBe(1);
  await checkWarpedControl(page.getByLabel(/I confirm that I have the rights or authorization required/));
  await expect(page.getByRole("button", { name: "Add 2 selected items" })).toBeEnabled();
  await page.screenshot({ path: "/home/alex/code/Torplex/test-results/torplex-bulk-intake.png", fullPage: false });
  await page.getByRole("button", { name: "Add 2 selected items" }).click();
  await expect.poll(() => bulkSubmitted).toBe(true);
});

test("an active AI search can be cancelled", async ({ page }) => {
  test.skip(!baseUrl || !password, "Torplex URL and password are required");
  await page.route("**/api/torrent/search", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: "" }).catch(() => {});
  });

  await page.goto(new URL("/auth/login", baseUrl!).toString());
  await page.locator("#crtBootTrigger").click();
  await expect(page.locator("body")).toHaveClass(/crt-powered-on/);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("button", { name: "Add Torrent" }).click();
  await expect(page.locator("body")).toHaveClass(/crt-powered-on/);
  await expect(page.locator("#crtBootTrigger")).toBeHidden();
  await page.getByRole("tab", { name: "Find with AI" }).click();
  await page.getByLabel("What do you want to find?").fill("Find ten science fiction horror films");
  await checkWarpedControl(page.getByLabel(/I will use these search results only/));
  await page.getByRole("button", { name: "Build proposal" }).click();
  await expect(page.getByRole("button", { name: "Cancel search" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel search" }).click();
  await expect(page.getByText("Search cancelled").last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Build proposal" })).toBeEnabled();
});
