const startedAt = Date.now();

function mockItems(elapsedSeconds: number) {
  const cycle = (elapsedSeconds % 180) / 180;
  const firstPercent = Math.min(98.4, 36.8 + cycle * 34);
  const secondPercent = Math.min(96.2, 18.2 + cycle * 21);
  const firstTotal = 84.7 * 1024 ** 3;
  const secondTotal = 26.3 * 1024 ** 3;
  return [
    {
      id: "mock-voyager",
      title: "Star Trek: Voyager (1995) S01-S07",
      totalBytes: firstTotal,
      status: "active",
      progress: {
        percent: firstPercent,
        downloadedBytes: firstTotal * firstPercent / 100,
        totalBytes: firstTotal,
        rate: "8.7MiB",
        eta: "2h18m",
        phase: "downloading",
      },
    },
    {
      id: "mock-strange-new-worlds",
      title: "Star Trek: Strange New Worlds S01-S03",
      totalBytes: secondTotal,
      status: "active",
      progress: {
        percent: secondPercent,
        downloadedBytes: secondTotal * secondPercent / 100,
        totalBytes: secondTotal,
        rate: "3.1MiB",
        eta: "4h06m",
        phase: "downloading",
      },
    },
    {
      id: "mock-first-contact",
      title: "Star Trek: First Contact (1996)",
      totalBytes: 7.8 * 1024 ** 3,
      status: "pending",
      progress: { percent: 62.5, downloadedBytes: 4.9 * 1024 ** 3, totalBytes: 7.8 * 1024 ** 3, rate: "-", eta: "-", phase: "waiting" },
    },
    {
      id: "mock-lower-decks",
      title: "Star Trek: Lower Decks S01-S05",
      totalBytes: 22.8 * 1024 ** 3,
      status: "pending",
      progress: { percent: 0, downloadedBytes: 0, totalBytes: 22.8 * 1024 ** 3, rate: "-", eta: "-", phase: "queued" },
    },
    {
      id: "mock-deep-space-nine",
      title: "Star Trek: Deep Space Nine S01-S07",
      totalBytes: 89.5 * 1024 ** 3,
      status: "completed",
      completedAt: new Date(Date.now() - 32 * 60_000).toISOString(),
      progress: { percent: 100, downloadedBytes: 89.5 * 1024 ** 3, totalBytes: 89.5 * 1024 ** 3, rate: "-", eta: "-", phase: "completed" },
      aiMetadataStatus: "fixed",
      aiMetadataSummary: "Canonical series metadata and English captions verified.",
    },
    {
      id: "mock-event-horizon",
      title: "Event Horizon (1997)",
      totalBytes: 8.2 * 1024 ** 3,
      status: "completed",
      completedAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
      progress: { percent: 100, downloadedBytes: 8.2 * 1024 ** 3, totalBytes: 8.2 * 1024 ** 3, rate: "-", eta: "-", phase: "completed" },
      aiMetadataStatus: "passed",
    },
  ];
}

function mockStatus() {
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const items = mockItems(elapsedSeconds);
  const activeItems = items.filter((item) => item.status === "active");
  const completedItems = items.filter((item) => item.status === "completed");
  const totalBytes = items.reduce((sum, item) => sum + item.totalBytes, 0);
  const doneBytes = items.reduce((sum, item) => sum + Number(item.progress.downloadedBytes || 0), 0);
  const activePercent = activeItems.reduce((sum, item) => sum + item.progress.percent, 0) / activeItems.length;
  const peers = [
    { peerKey: "mock-1", itemId: "mock-voyager", ip: "185.44.72.19", port: 51413, country: "Netherlands", countryCode: "NL", city: "Amsterdam", org: "AS60781 LeaseWeb", lat: 52.3676, lon: 4.9041, active: true, probing: false, receiveRateBps: 4_800_000 },
    { peerKey: "mock-2", itemId: "mock-voyager", ip: "89.187.167.44", port: 49160, country: "Sweden", countryCode: "SE", city: "Stockholm", org: "AS60068 Datacamp", lat: 59.3293, lon: 18.0686, active: true, probing: false, receiveRateBps: 2_650_000 },
    { peerKey: "mock-3", itemId: "mock-strange-new-worlds", ip: "193.32.126.81", port: 6881, country: "Canada", countryCode: "CA", city: "Toronto", org: "AS9009 M247", lat: 43.6532, lon: -79.3832, active: true, probing: false, receiveRateBps: 2_100_000 },
    { peerKey: "mock-4", itemId: "mock-strange-new-worlds", ip: "103.152.220.14", port: 51413, country: "Japan", countryCode: "JP", city: "Tokyo", org: "AS2516 KDDI", lat: 35.6762, lon: 139.6503, active: true, probing: false, receiveRateBps: 1_250_000 },
    { peerKey: "mock-5", itemId: "mock-first-contact", ip: "45.134.142.93", port: 6881, country: "France", countryCode: "FR", city: "Paris", org: "AS3215 Orange", lat: 48.8566, lon: 2.3522, active: false, probing: true, receiveRateBps: 0 },
    { peerKey: "mock-6", itemId: "mock-first-contact", ip: "156.146.58.31", port: 51413, country: "Australia", countryCode: "AU", city: "Sydney", org: "AS212238 Datacamp", lat: -33.8688, lon: 151.2093, active: false, probing: false, receiveRateBps: 0 },
  ];
  return {
    generatedAt: new Date().toISOString(),
    disk: { size: "3.6 TiB", used: "1.4 TiB", available: "2.2 TiB", usePercent: "39%" },
    totals: {
      totalItems: items.length,
      activeItems: activeItems.length,
      completedItems: completedItems.length,
      percent: totalBytes ? doneBytes / totalBytes * 100 : 0,
      activePercent,
      activeEta: "2h18m",
      activeRateBytesPerSecond: 10_800_000,
      totalBytes,
      doneBytes,
    },
    items,
    swarm: {
      updatedAt: new Date().toISOString(),
      origin: { label: "PI", city: "Salt Lake City", country: "United States", countryCode: "US", lat: 40.7608, lon: -111.891, lookupStatus: "mapped" },
      relay: { label: "VPN TUNNEL", city: "Mexico City", country: "Mexico", countryCode: "MX", lat: 19.4326, lon: -99.1332, lookupStatus: "mapped" },
      vpn: { connected: true, verified: true, required: true, failClosed: true, provider: "Mullvad", interface: "wg0", exit: { city: "Mexico City", country: "Mexico" }, message: "Mock WireGuard route verified" },
      peers,
      activeCount: peers.filter((peer) => peer.active).length,
      probingCount: peers.filter((peer) => peer.probing).length,
      inactiveCount: peers.filter((peer) => !peer.active && !peer.probing).length,
      aria2Seeders: 8,
      aria2Connections: 12,
    },
    batchLogTail: "MOCK UI TELEMETRY ACTIVE",
  };
}

function mockProposal() {
  const work = { title: "Star Trek: Picard", year: 2020, type: "show", requiredSeasons: [1, 2, 3] };
  return {
    summary: "One complete-series source selected; one existing title excluded from acquisition.",
    qualityProfile: { directPlay: true },
    selections: [{
      selectionId: "mock-selection-picard",
      candidateId: "mock-candidate-picard",
      targetId: "mock-target-picard",
      work,
      scopeLabel: "Complete series · S01-S03",
      candidate: { name: "Star Trek Picard (2020) S01-S03 1080p WEB-DL H264", provider: "mock-index", sourceUrl: "magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=Mock", seeders: 147, sizeBytes: 42.6 * 1024 ** 3, providerReliability: { attempts: 21, manifestSuccessRate: .91 } },
      metadata: { fileCount: 32, totalBytes: 42.6 * 1024 ** 3 },
      reason: "Complete season coverage, English audio, H.264 video, and direct-play-compatible container verified.",
      alternatives: [],
    }],
    alreadyOwned: [{
      inventoryItem: { title: "Star Trek: First Contact", year: 1996, source: "plex", status: "available" },
      reason: "Canonical title already exists in the Plex Movies library.",
    }],
    missing: [{
      targetId: "mock-target-prodigy",
      work: { title: "Star Trek: Prodigy", year: 2021, type: "show", requiredSeasons: [1, 2] },
      scopeLabel: "Season 02",
      reason: "No candidate supplied a verified manifest within the mock search window.",
    }],
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function searchResponse() {
  const encoder = new TextEncoder();
  const messages = [
    "Reading acquisition directive",
    "Cross-referencing Plex and Torplex inventory",
    "Resolving canonical title and season coverage",
    "Testing provider manifests",
    "Ranking direct-play candidates",
  ];
  return new Response(new ReadableStream({
    start(controller) {
      let index = 0;
      const emit = () => {
        if (index < messages.length) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "progress", message: messages[index] })}\n`));
          index += 1;
          setTimeout(emit, 420);
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "result", proposal: mockProposal() })}\n`));
        controller.close();
      };
      emit();
    },
  }), {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

export function mockUiEnabled() {
  return process.env.TORPLEX_MOCK_UI === "1";
}

export function mockUiResponse(request: Request, url: URL) {
  const path = url.pathname;
  if (path === "/api/status") return jsonResponse(mockStatus());
  if (path === "/api/session") return jsonResponse({ configured: true, authenticated: true, user: { name: "Mock Operator" }, loginUrl: "/auth/login", logoutUrl: "/auth/logout" });
  if (path === "/api/events") {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    return new Response(new ReadableStream({
      start(controller) {
        const emit = () => controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(mockStatus())}\n\n`));
        emit();
        timer = setInterval(emit, 900);
      },
      cancel() {
        if (timer) clearInterval(timer);
      },
    }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" } });
  }
  if (path === "/api/torrent/search" && request.method === "POST") return searchResponse();
  if (path === "/api/torrent/search/retry" && request.method === "POST") return searchResponse();
  if (path === "/api/torrent/search/cancel") return jsonResponse({ cancelled: true });
  if (path.startsWith("/api/torrents")) return jsonResponse({ ok: true, mock: true, restartMessage: "Mock operation accepted" });
  return null;
}
