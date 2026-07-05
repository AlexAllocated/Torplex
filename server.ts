import { existsSync, readFileSync, statSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";

const root = process.env.BATCH_DIR ?? "/media/plex/.downloads/torrent-batch";
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "8787");
const ignoredPeerIps = new Set((process.env.IGNORED_PEER_IPS ?? "20.172.155.193").split(",").map((ip) => ip.trim()).filter(Boolean));

type Item = {
  id: string;
  title: string;
  totalBytes: number;
  destination: { type: "movie" | "show"; path: string };
};

type Manifest = {
  createdAt: string;
  items: Item[];
};

type StateItem = {
  status?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
};

type State = {
  startedAt?: string;
  finishedAt?: string;
  currentItemId?: string | null;
  items?: Record<string, StateItem>;
};

type Peer = {
  ip: string;
  port: string;
  state: string;
  bytesReceived?: number;
};

type PeerGeo = Peer & {
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  lat?: number;
  lon?: number;
  isp?: string;
  as?: string;
  active?: boolean;
  probing?: boolean;
  receiveRateBps?: number;
  lastSeenAt?: string;
  lastActiveAt?: string;
  ageSeconds?: number;
  lookupStatus: "mapped" | "unmapped";
};

const byteUnits: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

const peerGeoCache = new Map<string, { expiresAt: number; value: PeerGeo }>();
const peerHistory = new Map<string, PeerGeo>();
let peerSnapshot: {
  updatedAt: string;
  peers: PeerGeo[];
  activeCount: number;
  probingCount: number;
  inactiveCount: number;
  aria2Connections: number;
  aria2Seeders: number;
} = {
  updatedAt: new Date(0).toISOString(),
  peers: [],
  activeCount: 0,
  probingCount: 0,
  inactiveCount: 0,
  aria2Connections: 0,
  aria2Seeders: 0,
};
let lastPeerRefresh = 0;
const peerRefreshMs = 5_000;
const peerGeoTtlMs = 12 * 60 * 60 * 1000;
const peerHistoryTtlMs = 15 * 60 * 1000;

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readTail(path: string, maxBytes = 160_000): string {
  try {
    const stat = statSync(path);
    const fd = Bun.file(path);
    const start = Math.max(0, stat.size - maxBytes);
    return readFileSync(path).subarray(start).toString("utf8");
  } catch {
    return "";
  }
}

function parseAmount(value: string, unit: string): number {
  return Number(value) * (byteUnits[unit] ?? 1);
}

function parseProgress(log: string) {
  const clean = log.replace(/\x1b\[[0-9;]*[mK]/g, "");
  const lines = clean.split(/\r?\n/).filter(Boolean);
  const progressLines = lines.filter((line) => line.includes("[#") && line.includes("/") && line.includes("("));
  const line = progressLines.at(-1) ?? "";
  const match = line.match(
    /\[#\w+\s+([0-9.]+)(B|KiB|MiB|GiB|TiB)\/([0-9.]+)(B|KiB|MiB|GiB|TiB)\((\d+)%\)/,
  );
  const connections = Number(line.match(/\bCN:(\d+)/)?.[1] ?? 0);
  const seeders = Number(line.match(/\bSD:(\d+)/)?.[1] ?? 0);
  if (!match) {
    return { line, downloadedBytes: 0, totalBytes: 0, percent: 0, rate: "", eta: "", connections, seeders };
  }
  const rate = line.match(/\bDL:([^\s\]]+)/)?.[1] ?? "";
  const eta = line.match(/\bETA:([^\]\s]+)/)?.[1] ?? "";
  return {
    line,
    downloadedBytes: parseAmount(match[1], match[2]),
    totalBytes: parseAmount(match[3], match[4]),
    percent: Number(match[5]),
    rate,
    eta,
    connections,
    seeders,
  };
}

async function diskUsage() {
  const proc = Bun.spawnSync(["df", "-h", "/media/plex"]);
  const text = proc.stdout.toString().trim();
  const line = text.split(/\r?\n/)[1] ?? "";
  const parts = line.trim().split(/\s+/);
  return {
    filesystem: parts[0] ?? "",
    size: parts[1] ?? "",
    used: parts[2] ?? "",
    available: parts[3] ?? "",
    usePercent: parts[4] ?? "",
    mount: parts[5] ?? "",
  };
}

function parseRemoteAddress(value: string): { ip: string; port: string } | null {
  if (value.startsWith("[")) {
    const match = value.match(/^\[([^\]]+)\]:(\d+)$/);
    return match ? { ip: match[1], port: match[2] } : null;
  }
  const match = value.match(/^(.+):(\d+)$/);
  return match ? { ip: match[1], port: match[2] } : null;
}

function isPublicIp(ip: string) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(
    a === 10 ||
    a === 127 ||
    a === 0 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function connectedPeers(): Peer[] {
  const proc = Bun.spawnSync(["ss", "-Htinp"]);
  const lines = proc.stdout.toString().split(/\r?\n/);
  const peers = new Map<string, Peer>();
  let current: Peer | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      if (current) {
        const bytesReceived = Number(line.match(/\bbytes_received:(\d+)/)?.[1]);
        if (Number.isFinite(bytesReceived)) current.bytesReceived = bytesReceived;
      }
      continue;
    }
    current = null;
    if (!line.includes("aria2c")) continue;
    const parts = line.trim().split(/\s+/);
    const state = parts[0] ?? "";
    const remote = parseRemoteAddress(parts[4] ?? "");
    if (!remote || !isPublicIp(remote.ip)) continue;
    if (ignoredPeerIps.has(remote.ip)) continue;
    current = { ip: remote.ip, port: remote.port, state };
    peers.set(`${remote.ip}:${remote.port}`, current);
  }
  return [...peers.values()].slice(0, 48);
}

function markPeerActivity(peer: PeerGeo, nowMs: number): PeerGeo {
  const previous = peerHistory.get(`${peer.ip}:${peer.port}`);
  const active = peer.state === "ESTAB";
  const probing = !active && peer.state !== "";
  const previousBytes = previous?.bytesReceived;
  const previousSeen = previous?.lastSeenAt ? Date.parse(previous.lastSeenAt) : 0;
  const elapsedSeconds = previousSeen ? Math.max(0.001, (nowMs - previousSeen) / 1000) : 0;
  const receivedDelta =
    Number.isFinite(peer.bytesReceived) && Number.isFinite(previousBytes)
      ? Math.max(0, Number(peer.bytesReceived) - Number(previousBytes))
      : 0;
  const receiveRateBps = elapsedSeconds ? receivedDelta / elapsedSeconds : previous?.receiveRateBps ?? 0;
  return {
    ...previous,
    ...peer,
    active,
    probing,
    receiveRateBps,
    lastSeenAt: new Date(nowMs).toISOString(),
    lastActiveAt: active ? new Date(nowMs).toISOString() : previous?.lastActiveAt,
    ageSeconds: 0,
  };
}

async function lookupPeer(peer: Peer): Promise<PeerGeo> {
  const cached = peerGeoCache.get(peer.ip);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, ...peer };
  try {
    const fields = "status,country,countryCode,regionName,city,lat,lon,isp,as,query";
    const response = await fetch(`http://ip-api.com/json/${peer.ip}?fields=${fields}`);
    const data = (await response.json()) as Record<string, unknown>;
    if (data.status === "success") {
      const value: PeerGeo = {
        ...peer,
        country: String(data.country ?? ""),
        countryCode: String(data.countryCode ?? ""),
        region: String(data.regionName ?? ""),
        city: String(data.city ?? ""),
        lat: Number(data.lat),
        lon: Number(data.lon),
        isp: String(data.isp ?? ""),
        as: String(data.as ?? ""),
        lookupStatus: "mapped",
      };
      peerGeoCache.set(peer.ip, { expiresAt: Date.now() + peerGeoTtlMs, value });
      return value;
    }
  } catch {
    // Keep the dashboard live even if the geo service is unavailable.
  }
  const value: PeerGeo = { ...peer, lookupStatus: "unmapped" };
  peerGeoCache.set(peer.ip, { expiresAt: Date.now() + 5 * 60 * 1000, value });
  return value;
}

async function swarmPeers(stats?: { connections?: number; seeders?: number }) {
  if (Date.now() - lastPeerRefresh < peerRefreshMs) return peerSnapshot;
  lastPeerRefresh = Date.now();
  const nowMs = Date.now();
  const peers = connectedPeers();
  const activeKeys = new Set(peers.map((peer) => `${peer.ip}:${peer.port}`));
  for (const peer of await Promise.all(peers.map((peer) => lookupPeer(peer)))) {
    peerHistory.set(`${peer.ip}:${peer.port}`, markPeerActivity(peer, nowMs));
  }

  for (const [key, peer] of peerHistory) {
    const seenMs = peer.lastSeenAt ? Date.parse(peer.lastSeenAt) : 0;
    if (nowMs - seenMs > peerHistoryTtlMs) {
      peerHistory.delete(key);
      continue;
    }
    if (!activeKeys.has(key)) {
      peerHistory.set(key, {
        ...peer,
        active: false,
        probing: false,
        receiveRateBps: 0,
        ageSeconds: Math.max(0, Math.round((nowMs - seenMs) / 1000)),
      });
    }
  }

  const history = [...peerHistory.values()].sort((a, b) => {
    const aRank = a.active ? 0 : a.probing ? 1 : 2;
    const bRank = b.active ? 0 : b.probing ? 1 : 2;
    if (aRank !== bRank) return aRank - bRank;
    return Date.parse(b.lastSeenAt ?? "") - Date.parse(a.lastSeenAt ?? "");
  });
  peerSnapshot = {
    updatedAt: new Date().toISOString(),
    peers: history.slice(0, 80),
    activeCount: history.filter((peer) => peer.active).length,
    probingCount: history.filter((peer) => peer.probing).length,
    inactiveCount: history.filter((peer) => !peer.active && !peer.probing).length,
    aria2Connections: stats?.connections ?? 0,
    aria2Seeders: stats?.seeders ?? 0,
  };
  return peerSnapshot;
}

async function listLogs() {
  try {
    return (await readdir(join(root, "logs"))).filter((name) => name.endsWith(".log"));
  } catch {
    return [];
  }
}

async function buildStatus() {
  const manifest = readJson<Manifest>(join(root, "manifest.json"), { createdAt: "", items: [] });
  const state = readJson<State>(join(root, "state.json"), {});
  const stateItems = state.items ?? {};
  let completedBytes = 0;
  let activeBytes = 0;

  const items = manifest.items.map((item) => {
    const itemState = stateItems[item.id] ?? {};
    const log = readTail(join(root, "logs", `${item.id}.log`));
    const progress = parseProgress(log);
    const status = itemState.status ?? "pending";
    if (status === "completed") {
      completedBytes += item.totalBytes;
    } else if (status === "active" || status === "organizing") {
      activeBytes += Math.min(progress.downloadedBytes, item.totalBytes);
    }
    return {
      ...item,
      status,
      startedAt: itemState.startedAt,
      completedAt: itemState.completedAt,
      failedAt: itemState.failedAt,
      error: itemState.error,
      progress,
      destinationExists: existsSync(item.destination.path),
    };
  });

  const totalBytes = manifest.items.reduce((sum, item) => sum + item.totalBytes, 0);
  const activeItem = items.find((item) => item.status === "active" || item.status === "organizing");
  const doneBytes = completedBytes + activeBytes;
  const rawLog = readTail(join(root, "batch.log"), 80_000).replace(/\x1b\[[0-9;]*[mK]/g, "");
  return {
    generatedAt: new Date().toISOString(),
    root,
    state,
    totals: {
      totalBytes,
      doneBytes,
      percent: totalBytes ? Math.floor((doneBytes / totalBytes) * 1000) / 10 : 0,
      completedItems: items.filter((item) => item.status === "completed").length,
      totalItems: items.length,
    },
    disk: await diskUsage(),
    swarm: await swarmPeers(activeItem?.progress),
    items,
    logs: await listLogs(),
    batchLogTail: rawLog.split(/\r?\n/).slice(-80).join("\n"),
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function statusStream() {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const encodeEvent = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  return new ReadableStream({
    start(controller) {
      const enqueue = (chunk: Uint8Array) => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          closed = true;
          if (timer) clearInterval(timer);
          return false;
        }
      };
      const send = async () => {
        if (closed) return;
        try {
          enqueue(encodeEvent("status", await buildStatus()));
        } catch (error) {
          enqueue(encodeEvent("error", { message: error instanceof Error ? error.message : String(error) }));
        }
      };

      enqueue(encoder.encode("retry: 1000\n\n"));
      void send();
      timer = setInterval(() => void send(), 500);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });
}

function page() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Plex Batch Progress</title>
  <style>
    @property --p {
      syntax: "<number>";
      inherits: false;
      initial-value: 0;
    }
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0c1017;
      color: #e7edf5;
      --panel: rgba(19, 25, 35, .86);
      --panel-strong: rgba(24, 33, 45, .96);
      --line: rgba(150, 167, 190, .22);
      --muted: #95a3b7;
      --teal: #57e0c2;
      --green: #7ee787;
      --amber: #f7c65f;
      --rose: #f47086;
      --blue: #78a6ff;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      background:
        linear-gradient(120deg, rgba(87, 224, 194, .10), transparent 34%),
        linear-gradient(240deg, rgba(247, 198, 95, .09), transparent 38%),
        radial-gradient(circle at 50% -10%, rgba(120, 166, 255, .20), transparent 42%),
        #0c1017;
      color: #e7edf5;
      overflow-x: hidden;
    }
    body::before {
      position: fixed;
      inset: 0;
      z-index: 0;
      content: "";
      opacity: .28;
      background-image:
        linear-gradient(rgba(255, 255, 255, .045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, .045) 1px, transparent 1px);
      background-size: 54px 54px;
      animation: drift 18s linear infinite;
      mask-image: linear-gradient(to bottom, black, transparent 86%);
      pointer-events: none;
    }
    #warpCanvas {
      position: fixed;
      inset: 0;
      z-index: 0;
      width: 100vw;
      height: 100vh;
      opacity: .48;
      pointer-events: none;
      mix-blend-mode: screen;
    }
    main { position: relative; z-index: 1; max-width: 1220px; margin: 0 auto; padding: 24px; }
    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 18px;
      padding-top: 6px;
    }
    h1 { margin: 0; font-size: clamp(26px, 4vw, 46px); line-height: 1; letter-spacing: 0; }
    .subtitle { margin-top: 8px; color: var(--muted); font-size: 14px; }
    .live {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      min-width: 136px;
      justify-content: center;
      border: 1px solid rgba(87, 224, 194, .42);
      border-radius: 999px;
      padding: 9px 13px;
      color: #d9fff6;
      background: rgba(87, 224, 194, .10);
      box-shadow: 0 0 24px rgba(87, 224, 194, .10);
      font-weight: 700;
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--teal);
      box-shadow: 0 0 0 rgba(87, 224, 194, .75);
      animation: pulse 1.35s infinite;
    }
    .dashboard {
      display: grid;
      grid-template-columns: 1.15fr .85fr;
      align-items: start;
      gap: 16px;
      margin-bottom: 16px;
    }
    .gauge-stack {
      display: grid;
      gap: 14px;
    }
    .gauges {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-items: start;
      gap: 14px;
    }
    .panel, .gauge, .item, .terminal {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 16px 42px rgba(0, 0, 0, .24);
      backdrop-filter: blur(14px);
    }
    .panel { padding: 16px; }
    .gauge {
      position: relative;
      min-height: 214px;
      padding: 16px;
      overflow: hidden;
    }
    .gauge::after {
      position: absolute;
      inset: 0;
      content: "";
      background: linear-gradient(115deg, transparent, rgba(255, 255, 255, .08), transparent);
      translate: -120% 0;
      animation: glint 4.4s ease-in-out infinite;
      pointer-events: none;
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; font-weight: 800; }
    .value { margin-top: 6px; font-size: 24px; font-weight: 850; }
    .small { color: var(--muted); font-size: 13px; }
    .ring {
      --p: 0;
      width: min(112px, 34vw);
      aspect-ratio: 1;
      margin: 16px auto 10px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at center, #131923 0 57%, transparent 58%),
        conic-gradient(var(--ring-color, var(--teal)) calc(var(--p) * 1%), rgba(130, 150, 175, .20) 0);
      box-shadow: inset 0 0 20px rgba(255, 255, 255, .05), 0 0 24px rgba(87, 224, 194, .08);
      transition: --p .9s cubic-bezier(.22, 1, .36, 1);
    }
    .ring span { font-size: 24px; font-weight: 900; }
    .value, .ring span, [data-role="progress-label"] { font-variant-numeric: tabular-nums; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .metric {
      min-height: 78px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, .035);
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      padding: 14px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 16px 42px rgba(0, 0, 0, .20);
    }
    .summary-strip .metric { min-height: 72px; }
    .summary-strip .value {
      font-size: 20px;
      line-height: 1.15;
      overflow-wrap: anywhere;
    }
    .hero-bar {
      position: relative;
      height: 18px;
      margin-top: 14px;
      border-radius: 999px;
      background: rgba(137, 154, 180, .18);
      overflow: hidden;
    }
    .hero-fill, .item-fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: 0%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--teal), var(--amber), var(--rose));
      transition: width .9s cubic-bezier(.22, 1, .36, 1);
      will-change: width;
    }
    .hero-fill::after, .item-fill::after {
      position: absolute;
      inset: 0;
      content: "";
      background-image: linear-gradient(115deg, rgba(255, 255, 255, .24) 25%, transparent 25%, transparent 50%, rgba(255, 255, 255, .24) 50%, rgba(255, 255, 255, .24) 75%, transparent 75%, transparent);
      background-size: 24px 24px;
      animation: runway 1.1s linear infinite;
      opacity: .48;
    }
    .speed-card {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 250px;
    }
    canvas {
      width: 100%;
      height: 132px;
      margin-top: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(0, 0, 0, .18);
    }
    .items {
      display: grid;
      gap: 10px;
      margin-top: 16px;
    }
    .transfer-map {
      position: relative;
      margin-top: 16px;
      padding: 16px;
      overflow: hidden;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 16px 42px rgba(0, 0, 0, .22);
    }
    .map-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .map-actions {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .icon-button {
      display: inline-grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border: 1px solid rgba(87, 224, 194, .32);
      border-radius: 8px;
      color: #d9fff6;
      background: rgba(87, 224, 194, .08);
      cursor: pointer;
      transition: background .2s ease, border-color .2s ease, transform .2s ease;
    }
    .icon-button:hover {
      border-color: rgba(87, 224, 194, .62);
      background: rgba(87, 224, 194, .15);
      transform: translateY(-1px);
    }
    .icon-button svg { width: 18px; height: 18px; }
    .map-track {
      position: relative;
      display: grid;
      grid-template-columns: repeat(var(--count), minmax(42px, 1fr));
      gap: 8px;
      align-items: center;
      min-height: 76px;
    }
    .map-track::before {
      position: absolute;
      left: 22px;
      right: 22px;
      top: 27px;
      height: 2px;
      content: "";
      background: linear-gradient(90deg, rgba(87, 224, 194, .82), rgba(120, 166, 255, .35), rgba(150, 167, 190, .12));
      box-shadow: 0 0 16px rgba(87, 224, 194, .26);
    }
    .map-node {
      position: relative;
      z-index: 1;
      display: grid;
      gap: 7px;
      justify-items: center;
      min-width: 0;
      color: var(--muted);
      font-size: 11px;
      text-align: center;
    }
    .map-dot {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 1px solid rgba(150, 167, 190, .30);
      background: #121923;
      box-shadow: inset 0 0 16px rgba(255, 255, 255, .04);
      font-size: 12px;
      font-weight: 900;
      color: #cbd6e3;
      transition: transform .35s ease, border-color .35s ease, background .35s ease, box-shadow .35s ease;
    }
    .map-node.completed .map-dot {
      border-color: rgba(126, 231, 135, .72);
      background: rgba(126, 231, 135, .16);
      box-shadow: 0 0 20px rgba(126, 231, 135, .18);
      color: #d9ffe0;
    }
    .map-node.active .map-dot, .map-node.organizing .map-dot {
      border-color: rgba(87, 224, 194, .90);
      background: rgba(87, 224, 194, .18);
      box-shadow: 0 0 0 0 rgba(87, 224, 194, .75), 0 0 32px rgba(87, 224, 194, .24);
      color: #d9fff6;
      transform: scale(1.12);
      animation: nodePulse 1.4s ease-out infinite;
    }
    .map-node.failed .map-dot {
      border-color: rgba(244, 112, 134, .78);
      background: rgba(244, 112, 134, .17);
      color: #ffe2e8;
    }
    .map-label {
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .world-panel { padding-bottom: 14px; }
    .world-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(260px, .65fr);
      gap: 14px;
      align-items: stretch;
    }
    .world-map-frame {
      position: relative;
      width: 100%;
      aspect-ratio: 2 / 1;
      min-height: 260px;
      overflow: hidden;
      border-color: rgba(87, 224, 194, .24);
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        radial-gradient(circle at 50% 50%, rgba(87, 224, 194, .12), transparent 50%),
        linear-gradient(180deg, rgba(10, 18, 28, .96), rgba(7, 11, 17, .96));
      cursor: grab;
      touch-action: none;
    }
    .world-map-frame:fullscreen {
      width: 100vw;
      height: 100vh;
      min-height: 100vh;
      aspect-ratio: auto;
      border: 0;
      border-radius: 0;
      background: #07101a;
    }
    .world-map-frame:active { cursor: grabbing; }
    .world-map-frame .icon-button {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 3;
      background: rgba(7, 16, 26, .72);
      backdrop-filter: blur(10px);
    }
    .world-map-frame .exit-fullscreen-icon { display: none; }
    .world-map-frame:fullscreen .enter-fullscreen-icon { display: none; }
    .world-map-frame:fullscreen .exit-fullscreen-icon { display: block; }
    .world-map-viewport {
      position: absolute;
      inset: 0;
      overflow: hidden;
    }
    .world-map-frame:fullscreen .world-map-viewport {
      inset: auto;
      left: 50%;
      top: 50%;
      width: min(100vw, 200vh);
      height: min(50vw, 100vh);
      transform: translate(-50%, -50%);
    }
    .world-map-layer {
      position: absolute;
      inset: 0;
      transform-origin: 0 0;
      will-change: transform;
    }
    .world-map-image {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: fill;
      opacity: .48;
      filter: invert(1) hue-rotate(145deg) saturate(.65) brightness(1.25);
      mix-blend-mode: screen;
    }
    #worldCanvas {
      position: absolute;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
      margin: 0;
      border: 0;
      background: transparent;
    }
    .map-peer-label-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .map-peer-label {
      position: absolute;
      display: flex;
      align-items: center;
      gap: 5px;
      max-width: min(220px, 44vw);
      padding: 2px 5px;
      border: 1px solid rgba(150, 167, 190, .18);
      border-radius: 5px;
      background: rgba(5, 10, 16, .72);
      color: rgba(231, 237, 245, .94);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      font-weight: 700;
      line-height: 1.2;
      white-space: nowrap;
      transform: translate(8px, -14px);
      pointer-events: auto;
      transition: opacity .24s ease, max-width .18s ease, background .18s ease, border-color .18s ease, box-shadow .18s ease;
    }
    .map-peer-label:hover {
      max-width: min(360px, 72vw);
      border-color: rgba(87, 224, 194, .42);
      background: rgba(5, 10, 16, .90);
      box-shadow: 0 0 24px rgba(87, 224, 194, .18);
    }
    .map-peer-label img {
      position: static;
      inset: auto;
      width: 18px;
      height: 13px;
      flex: 0 0 auto;
      opacity: 1;
      filter: none;
      mix-blend-mode: normal;
      border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, .18);
      object-fit: cover;
    }
    .map-peer-label span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .map-peer-detail {
      display: none;
      color: rgba(231, 237, 245, .72);
    }
    .map-peer-label:hover .map-peer-detail {
      display: inline;
    }
    .map-progress-widget {
      position: absolute;
      left: 50%;
      bottom: 12px;
      z-index: 3;
      width: min(300px, calc(100% - 24px));
      padding: 6px 8px;
      border: 1px solid rgba(191, 255, 0, .28);
      border-radius: 8px;
      background: rgba(7, 16, 26, .58);
      box-shadow: 0 10px 24px rgba(0, 0, 0, .24);
      backdrop-filter: blur(10px);
      pointer-events: none;
      transform: translateX(-50%);
    }
    .map-progress-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #e7edf5;
      font-size: 10px;
      font-weight: 850;
      text-align: center;
    }
    .map-progress-meta {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-top: 3px;
      color: var(--muted);
      font-size: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .map-progress-bar {
      position: relative;
      height: 4px;
      margin-top: 5px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(150, 167, 190, .20);
    }
    .map-progress-fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: 0%;
      border-radius: inherit;
      background: linear-gradient(90deg, #00aa00, #bfff00);
      box-shadow: 0 0 16px rgba(191, 255, 0, .30);
      transition: width .8s cubic-bezier(.22, 1, .36, 1);
    }
    .peer-pills {
      display: grid;
      align-content: start;
      gap: 8px;
      max-height: 330px;
      overflow: auto;
      padding-right: 4px;
    }
    .peer-card {
      display: grid;
      gap: 3px;
      padding: 10px;
      border: 1px solid rgba(150, 167, 190, .20);
      border-radius: 8px;
      background: rgba(255, 255, 255, .035);
      box-shadow: inset 0 0 18px rgba(255, 255, 255, .025);
    }
    .peer-card.active {
      border-color: rgba(87, 224, 194, .46);
      background: rgba(87, 224, 194, .08);
    }
    .peer-card.probing {
      border-color: rgba(247, 198, 95, .38);
      background: rgba(247, 198, 95, .07);
    }
    .peer-card.inactive {
      opacity: .68;
      border-color: rgba(150, 167, 190, .14);
    }
    .peer-card strong {
      color: #d9fff6;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .peer-card span {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .peer-state {
      width: fit-content;
      margin-top: 2px;
      padding: 2px 6px;
      border: 1px solid rgba(150, 167, 190, .22);
      border-radius: 999px;
      font-size: 10px;
      font-weight: 850;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .peer-card.active .peer-state { color: #d9fff6; border-color: rgba(87, 224, 194, .50); }
    .peer-card.probing .peer-state { color: #fff1c7; border-color: rgba(247, 198, 95, .46); }
    .peer-empty {
      display: grid;
      place-items: center;
      min-height: 120px;
      color: var(--muted);
      border: 1px dashed rgba(150, 167, 190, .24);
      border-radius: 8px;
      font-size: 13px;
      text-align: center;
      padding: 14px;
    }
    .item {
      position: relative;
      display: grid;
      grid-template-columns: minmax(220px, 1.5fr) minmax(110px, .55fr) minmax(190px, 1fr) minmax(78px, .35fr) minmax(78px, .35fr);
      gap: 12px;
      align-items: center;
      min-height: 82px;
      padding: 13px;
      overflow: hidden;
      transition: background-color .35s ease, border-color .35s ease, transform .35s ease;
    }
    .item.active { border-color: rgba(87, 224, 194, .55); background: rgba(24, 44, 43, .88); }
    .item.completed { border-color: rgba(126, 231, 135, .45); }
    .item.failed { border-color: rgba(244, 112, 134, .62); background: rgba(58, 25, 34, .88); }
    .item.active::before {
      position: absolute;
      inset: 0;
      content: "";
      background: linear-gradient(90deg, transparent, rgba(87, 224, 194, .10), transparent);
      translate: -100% 0;
      animation: scan 2.6s ease-in-out infinite;
      pointer-events: none;
    }
    .title { min-width: 0; font-weight: 800; }
    .title div:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #cbd6e3; }
    .chip {
      display: inline-flex;
      width: fit-content;
      align-items: center;
      justify-content: center;
      min-width: 92px;
      padding: 6px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: #e7edf5;
      background: rgba(255, 255, 255, .045);
      font-size: 12px;
      font-weight: 850;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    .chip.active, .chip.organizing { border-color: rgba(87, 224, 194, .55); color: #ccfff5; background: rgba(87, 224, 194, .13); }
    .chip.completed { border-color: rgba(126, 231, 135, .50); color: #d9ffe0; background: rgba(126, 231, 135, .10); }
    .chip.failed { border-color: rgba(244, 112, 134, .58); color: #ffe2e8; background: rgba(244, 112, 134, .12); }
    .item-bar {
      position: relative;
      height: 10px;
      margin-top: 7px;
      border-radius: 999px;
      background: rgba(137, 154, 180, .18);
      overflow: hidden;
    }
    .item-fill { background: linear-gradient(90deg, var(--blue), var(--teal)); }
    .terminal {
      margin-top: 16px;
      overflow: hidden;
    }
    .terminal-head {
      display: flex;
      align-items: center;
      gap: 7px;
      border-bottom: 1px solid var(--line);
      padding: 11px 14px;
      background: rgba(0, 0, 0, .18);
    }
    .light { width: 10px; height: 10px; border-radius: 50%; background: var(--rose); }
    .light:nth-child(2) { background: var(--amber); }
    .light:nth-child(3) { background: var(--green); }
    pre {
      min-height: 180px;
      max-height: 360px;
      margin: 0;
      padding: 14px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: rgba(0, 0, 0, .22);
    }
    .burst {
      position: fixed;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--teal);
      pointer-events: none;
      animation: burst .9s ease-out forwards;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(87, 224, 194, .75); }
      70% { box-shadow: 0 0 0 11px rgba(87, 224, 194, 0); }
      100% { box-shadow: 0 0 0 0 rgba(87, 224, 194, 0); }
    }
    @keyframes drift { to { background-position: 54px 54px, 54px 54px; } }
    @keyframes runway { to { background-position: 24px 0; } }
    @keyframes glint {
      0%, 54% { translate: -120% 0; }
      78%, 100% { translate: 120% 0; }
    }
    @keyframes scan {
      0%, 35% { translate: -100% 0; }
      75%, 100% { translate: 100% 0; }
    }
    @keyframes burst {
      to { opacity: 0; transform: translate(var(--x), var(--y)) scale(.2); }
    }
    @keyframes nodePulse {
      70% { box-shadow: 0 0 0 16px rgba(87, 224, 194, 0), 0 0 32px rgba(87, 224, 194, .24); }
      100% { box-shadow: 0 0 0 0 rgba(87, 224, 194, 0), 0 0 32px rgba(87, 224, 194, .24); }
    }
    @media (max-width: 980px) {
      .dashboard { grid-template-columns: 1fr; }
      .world-shell { grid-template-columns: 1fr; }
      .item { grid-template-columns: 1fr; }
      .title div:first-child { white-space: normal; }
    }
    @media (max-width: 720px) {
      main { padding: 16px; }
      header { align-items: flex-start; flex-direction: column; }
      .gauges, .metric-grid, .summary-strip { grid-template-columns: 1fr; }
      .gauge { min-height: 174px; }
    }
  </style>
</head>
<body>
<canvas id="warpCanvas" aria-hidden="true"></canvas>
<main>
  <header>
    <div>
      <h1>Plex Batch Control</h1>
      <div class="subtitle" id="subtitle">Waiting for the first live packet...</div>
    </div>
    <div class="live"><span class="dot"></span><span id="connection">Connecting</span></div>
  </header>

  <section class="dashboard">
    <div class="gauge-stack">
      <div class="gauges">
        <div class="gauge">
          <div class="label">Batch</div>
          <div class="ring" id="batchRing"><span id="batchPercent">0%</span></div>
          <div class="small" id="batchText">0 of 0 complete</div>
        </div>
        <div class="gauge">
          <div class="label">Active Item</div>
          <div class="ring" id="activeRing" style="--ring-color: var(--amber);"><span id="activePercent">0%</span></div>
          <div class="small" id="activeText">No active item yet</div>
        </div>
        <div class="gauge">
          <div class="label">Disk Free</div>
          <div class="ring" id="diskRing" style="--ring-color: var(--green);"><span id="diskPercent">0%</span></div>
          <div class="small" id="diskText">Checking disk...</div>
        </div>
      </div>
      <div class="summary-strip">
        <div class="metric"><div class="label">Current</div><div class="value" id="currentMini">...</div></div>
        <div class="metric"><div class="label">ETA</div><div class="value" id="etaMini">...</div></div>
        <div class="metric"><div class="label">Remaining</div><div class="value" id="remainingMini">...</div></div>
      </div>
    </div>

    <div class="panel speed-card">
      <div>
        <div class="label">Live Speed</div>
        <div class="value" id="speedNow">0 MiB/s</div>
        <div class="hero-bar"><div id="totalFill" class="hero-fill"></div></div>
      </div>
      <canvas id="speedCanvas" aria-label="Download speed history"></canvas>
      <div class="metric-grid">
        <div class="metric"><div class="label">Downloaded</div><div class="value" id="downloaded">...</div></div>
        <div class="metric"><div class="label">Updated</div><div class="value" id="updated">...</div></div>
      </div>
    </div>
  </section>

  <section class="transfer-map world-panel">
    <div class="map-title">
      <div class="label">Swarm Atlas</div>
      <div class="small" id="routeStatus">Waiting for peer telemetry...</div>
    </div>
    <div class="world-shell">
      <div class="world-map-frame">
        <div id="worldMapViewport" class="world-map-viewport">
          <button id="fullscreenMap" class="icon-button" type="button" title="Fullscreen map" aria-label="Fullscreen map">
            <svg class="enter-fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>
            </svg>
            <svg class="exit-fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M16 3v3a2 2 0 0 0 2 2h3"></path><path d="M8 21v-3a2 2 0 0 0-2-2H3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path>
            </svg>
          </button>
          <div class="map-progress-widget">
            <div id="mapTorrentTitle" class="map-progress-title">Queue idle</div>
            <div class="map-progress-meta"><span id="mapTorrentProgress">0%</span><span id="mapTorrentRate">0 B/s</span><span id="mapTorrentEta">-</span><span id="mapTorrentSeeds">Streams 0</span></div>
            <div class="map-progress-bar"><div id="mapTorrentFill" class="map-progress-fill"></div></div>
          </div>
          <div id="worldMapLayer" class="world-map-layer">
            <img class="world-map-image" src="/assets/BlankMap-Equirectangular.svg" alt="" aria-hidden="true" />
            <canvas id="worldCanvas" aria-label="Connected peer world map"></canvas>
            <div id="mapPeerLabels" class="map-peer-label-layer" aria-hidden="true"></div>
          </div>
        </div>
      </div>
      <div id="peerPills" class="peer-pills"></div>
    </div>
  </section>

  <section>
    <div class="label">Queue</div>
    <div id="items" class="items"></div>
  </section>

  <section class="terminal">
    <div class="terminal-head"><span class="light"></span><span class="light"></span><span class="light"></span><span class="label">Batch Log Tail</span></div>
    <pre id="log" class="mono"></pre>
  </section>
</main>
<script>
const fmt = ${formatBytes.toString()};
const speedChart = {
  samples: [],
  target: 0,
  current: 0,
  max: 10,
  raf: 0,
  lastFrame: 0,
  lastSampleAt: 0,
  windowMs: 45000,
};
const warp = {
  stars: [],
  raf: 0,
  lastFrame: 0,
  speed: 0,
  batchProgress: 0,
  width: 0,
  height: 0,
  dpr: 1,
};
const swarmMap = {
  peers: [],
  displayPeers: [],
  labelNodes: new Map(),
  raf: 0,
  lastFrame: 0,
  origin: { lat: 39, lon: -98 },
};
const mapView = {
  scale: 1,
  x: 0,
  y: 0,
  dragging: false,
  startX: 0,
  startY: 0,
  baseX: 0,
  baseY: 0,
};
const completedSeen = new Set();
const tweens = new Map();
const elementTweens = new WeakMap();
let renderedOnce = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function setRing(id, percent) {
  const value = clamp(percent);
  document.getElementById(id).style.setProperty('--p', value);
}

function easeOut(value) {
  return 1 - Math.pow(1 - value, 3);
}

function tweenNumber(id, target, formatter, duration) {
  const el = document.getElementById(id);
  if (!el) return;
  const previous = tweens.get(id);
  if (previous?.raf) cancelAnimationFrame(previous.raf);
  const start = previous ? previous.value : target;
  const state = { value: start, raf: 0 };
  tweens.set(id, state);
  if (!Number.isFinite(target) || Math.abs(start - target) < 0.01) {
    state.value = target;
    el.textContent = formatter(target);
    return;
  }
  const startedAt = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - startedAt) / duration);
    state.value = start + (target - start) * easeOut(t);
    el.textContent = formatter(state.value);
    if (t < 1) state.raf = requestAnimationFrame(step);
    else {
      state.value = target;
      el.textContent = formatter(target);
    }
  };
  state.raf = requestAnimationFrame(step);
}

function tweenElementNumber(el, target, formatter, duration) {
  if (!el) return;
  const previous = elementTweens.get(el);
  if (previous?.raf) cancelAnimationFrame(previous.raf);
  const start = previous ? previous.value : target;
  const state = { value: start, raf: 0 };
  elementTweens.set(el, state);
  if (!Number.isFinite(target) || Math.abs(start - target) < 0.01) {
    state.value = target;
    el.textContent = formatter(target);
    return;
  }
  const startedAt = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - startedAt) / duration);
    state.value = start + (target - start) * easeOut(t);
    el.textContent = formatter(state.value);
    if (t < 1) state.raf = requestAnimationFrame(step);
    else {
      state.value = target;
      el.textContent = formatter(target);
    }
  };
  state.raf = requestAnimationFrame(step);
}

function setText(el, value) {
  if (el && el.textContent !== String(value)) el.textContent = String(value);
}

function statusClassFor(status) {
  return String(status || 'pending').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
}

function rowIdFor(id) {
  return 'item-' + String(id).replace(/[^a-z0-9_-]/gi, '-');
}

function progressDetailFor(item) {
  if (item.status === 'completed') return fmt(item.totalBytes) + ' finished';
  if (item.progress.downloadedBytes) {
    return fmt(item.progress.downloadedBytes) + ' / ' + fmt(item.progress.totalBytes || item.totalBytes);
  }
  return 'queued';
}

function shortTitle(title) {
  const cleaned = String(title || '').replace(/\\([^)]*\\)/g, '').replace(/[:]/g, ' ').trim();
  return cleaned
    .split(/\\s+/)
    .filter((word) => !['the', 'and', 'of'].includes(word.toLowerCase()))
    .slice(0, 3)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 3) || '...';
}

function flagUrlForCountry(countryCode) {
  const code = String(countryCode || '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return '';
  return 'https://flagcdn.com/w20/' + code + '.png';
}

function renderSwarmMap(swarm) {
  const routeStatus = document.getElementById('routeStatus');
  const peerPills = document.getElementById('peerPills');
  const peers = Array.isArray(swarm?.peers) ? swarm.peers : [];
  const mapped = peers.filter((peer) => Number.isFinite(peer.lat) && Number.isFinite(peer.lon));
  swarmMap.peers = peers;
  routeStatus.textContent = peers.length
    ? 'aria2 SD:' + (swarm.aria2Seeders ?? 0) + ' CN:' + (swarm.aria2Connections ?? 0) +
      ' - active ' + (swarm.activeCount ?? 0) +
      ', probing ' + (swarm.probingCount ?? 0) +
      ', inactive ' + (swarm.inactiveCount ?? 0) +
      ' - ' + mapped.length + '/' + peers.length + ' mapped'
    : 'No connected aria2c peers visible yet';
  peerPills.innerHTML = peers.length
    ? peers.map((peer) => {
      const place = [peer.city, peer.region, peer.countryCode || peer.country].filter(Boolean).join(', ') || 'Unmapped';
      const network = peer.as || peer.isp || 'Network unknown';
      const state = peer.active ? 'active' : peer.probing ? 'probing' : 'inactive';
      const age = peer.active || peer.probing ? peer.state : 'last seen ' + Math.round((peer.ageSeconds || 0) / 60) + 'm ago';
      const speed = peer.active ? formatPeerRate(peer.receiveRateBps) : '-';
      return '<div class="peer-card ' + esc(state) + '">' +
        '<strong>' + esc(peer.ip + ':' + peer.port) + '</strong>' +
        '<span>' + esc(place) + '</span>' +
        '<span>' + esc(network) + '</span>' +
        '<span>' + esc('Speed ' + speed) + '</span>' +
        '<span class="peer-state">' + esc(state + ' - ' + age) + '</span>' +
      '</div>';
    }).join('')
    : '<div class="peer-empty">No active peer sockets yet. The map will light up once aria2c has established connections.</div>';
  if (!swarmMap.raf) swarmMap.raf = requestAnimationFrame(drawWorldFrame);
}

function clampMapView() {
  const viewport = document.getElementById('worldMapViewport');
  if (!viewport) return;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  mapView.scale = Math.max(1, Math.min(6, mapView.scale));
  if (mapView.scale === 1) {
    mapView.x = 0;
    mapView.y = 0;
    return;
  }
  mapView.x = Math.min(0, Math.max(width - width * mapView.scale, mapView.x));
  mapView.y = Math.min(0, Math.max(height - height * mapView.scale, mapView.y));
}

function applyMapTransform() {
  clampMapView();
  const layer = document.getElementById('worldMapLayer');
  if (layer) layer.style.transform = 'translate(' + mapView.x + 'px, ' + mapView.y + 'px) scale(' + mapView.scale + ')';
}

function initMapControls() {
  const frame = document.querySelector('.world-map-frame');
  if (!frame) return;
  frame.addEventListener('wheel', (event) => {
    event.preventDefault();
    const viewport = document.getElementById('worldMapViewport');
    const rect = (viewport ?? frame).getBoundingClientRect();
    const oldScale = mapView.scale;
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextScale = Math.max(1, Math.min(6, oldScale * (direction > 0 ? 1.18 : 1 / 1.18)));
    const px = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const py = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const mapX = (px - mapView.x) / oldScale;
    const mapY = (py - mapView.y) / oldScale;
    mapView.scale = nextScale;
    mapView.x = px - mapX * nextScale;
    mapView.y = py - mapY * nextScale;
    applyMapTransform();
  }, { passive: false });
  frame.addEventListener('pointerdown', (event) => {
    if (mapView.scale <= 1) return;
    mapView.dragging = true;
    mapView.startX = event.clientX;
    mapView.startY = event.clientY;
    mapView.baseX = mapView.x;
    mapView.baseY = mapView.y;
    frame.setPointerCapture(event.pointerId);
  });
  frame.addEventListener('pointermove', (event) => {
    if (!mapView.dragging) return;
    mapView.x = mapView.baseX + event.clientX - mapView.startX;
    mapView.y = mapView.baseY + event.clientY - mapView.startY;
    applyMapTransform();
  });
  frame.addEventListener('pointerup', (event) => {
    mapView.dragging = false;
    try { frame.releasePointerCapture(event.pointerId); } catch {}
  });
  frame.addEventListener('pointercancel', () => {
    mapView.dragging = false;
  });
  frame.addEventListener('dblclick', () => {
    mapView.scale = 1;
    mapView.x = 0;
    mapView.y = 0;
    applyMapTransform();
  });
  document.getElementById('fullscreenMap')?.addEventListener('click', async () => {
    if (document.fullscreenElement === frame) {
      await document.exitFullscreen();
    } else {
      await frame.requestFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', () => {
    applyMapTransform();
  });
}

function projectWorld(lat, lon, width, height) {
  return {
    x: ((lon + 180) / 360) * width,
    y: ((90 - lat) / 180) * height,
  };
}

function quadPoint(start, control, end, t) {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  };
}

function pulseForSpeed(now, bytesPerSecond, phase = 0) {
  const speed = Math.max(.45, Math.min(4.6, Math.log2((Number(bytesPerSecond) || 0) / 65536 + 1)));
  return {
    speed,
    value: .5 + Math.sin(now / (900 / speed) + phase) * .5,
  };
}

function mixColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function heatColor(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  const t = Math.max(0, Math.min(1, Math.log2(value / 32768 + 1) / 8));
  const stops = [
    [45, 126, 255],
    [0, 170, 0],
    [191, 255, 0],
    [255, 140, 0],
    [255, 46, 46],
  ];
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  return mixColor(stops[index], stops[index + 1], scaled - index).join(', ');
}

function syncDisplayPeers(peers) {
  const now = performance.now();
  const existing = new Map(swarmMap.displayPeers.map((peer) => [peer.peer ? peer.peer.ip + ':' + peer.peer.port : '', peer]));
  const next = [];
  peers.filter((peer) => Number.isFinite(peer.lat) && Number.isFinite(peer.lon)).slice(0, 32).forEach((peer, index) => {
    const key = peer.ip + ':' + peer.port;
    const current = existing.get(key) || { alpha: 0, x: 0, y: 0, phase: Math.random() * Math.PI * 2 };
    current.peer = peer;
    current.targetLat = Number(peer.lat);
    current.targetLon = Number(peer.lon);
    current.lastSeen = now;
    current.rank = index;
    current.fading = false;
    next.push(current);
  });
  existing.forEach((peer, ip) => {
    if (ip && !next.some((item) => item.peer && item.peer.ip + ':' + item.peer.port === ip)) {
      peer.fading = true;
      next.push(peer);
    }
  });
  swarmMap.displayPeers = next.slice(0, 40);
}

function renderMapPeerLabels(width, height) {
  const layer = document.getElementById('mapPeerLabels');
  if (!layer) return;
  const visible = swarmMap.displayPeers.filter((item) => item.peer?.active && item.rank < 12 && item.alpha > .05);
  const seen = new Set();
  visible.forEach((item) => {
    const key = item.peer.ip + ':' + item.peer.port;
    seen.add(key);
    let node = swarmMap.labelNodes.get(key);
    if (!node) {
      node = document.createElement('div');
      node.className = 'map-peer-label';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      const text = document.createElement('span');
      text.className = 'map-peer-speed';
      const detail = document.createElement('span');
      detail.className = 'map-peer-detail';
      node.append(img, text, detail);
      layer.appendChild(node);
      swarmMap.labelNodes.set(key, node);
    }
    const text = formatPeerRate(item.peer.receiveRateBps);
    const country = item.peer.country || item.peer.countryCode || 'Unknown country';
    const detailText = country + ' - ' + item.peer.ip + ':' + item.peer.port;
    const flagUrl = flagUrlForCountry(item.peer.countryCode);
    const img = node.querySelector('img');
    const span = node.querySelector('.map-peer-speed');
    const detail = node.querySelector('.map-peer-detail');
    if (img) {
      img.hidden = !flagUrl;
      if (flagUrl && img.src !== flagUrl) {
        img.src = flagUrl;
        img.alt = item.peer.countryCode || '';
      }
    }
    if (span) span.textContent = text;
    if (detail) detail.textContent = detailText;
    node.title = country + ' - ' + item.peer.ip + ':' + item.peer.port + ' - ' + text;
    const estimatedWidth = Math.min(170, 16 + (flagUrl ? 25 : 0) + text.length * 6);
    const x = Math.min(width - estimatedWidth - 8, Math.max(6, item.x + 8));
    const y = Math.min(height - 18, Math.max(10, item.y - 14));
    node.style.left = x.toFixed(1) + 'px';
    node.style.top = y.toFixed(1) + 'px';
    node.style.opacity = String(Math.min(.96, item.alpha));
  });
  swarmMap.labelNodes.forEach((node, key) => {
    if (!seen.has(key)) {
      node.remove();
      swarmMap.labelNodes.delete(key);
    }
  });
}

function drawWorldFrame(now) {
  swarmMap.raf = requestAnimationFrame(drawWorldFrame);
  const canvas = document.getElementById('worldCanvas');
  if (!canvas) return;
  syncDisplayPeers(swarmMap.peers);
  const viewport = document.getElementById('worldMapViewport');
  const rect = { width: viewport?.clientWidth || canvas.clientWidth, height: viewport?.clientHeight || canvas.clientHeight };
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.floor(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  const dt = swarmMap.lastFrame ? Math.min(80, now - swarmMap.lastFrame) : 16;
  swarmMap.lastFrame = now;
  const width = rect.width;
  const height = rect.height;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const vignette = ctx.createRadialGradient(width / 2, height / 2, height * .1, width / 2, height / 2, width * .62);
  vignette.addColorStop(0, 'rgba(87, 224, 194, .10)');
  vignette.addColorStop(.55, 'rgba(7, 12, 19, 0)');
  vignette.addColorStop(1, 'rgba(7, 12, 19, .40)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(150, 167, 190, .13)';
  ctx.lineWidth = 1;
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = projectWorld(0, lon, width, height).x;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = projectWorld(lat, 0, width, height).y;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const totalIngestBps = swarmMap.displayPeers.reduce(
    (sum, item) => sum + (item.peer?.active ? Number(item.peer.receiveRateBps) || 0 : 0),
    0,
  );
  const origin = projectWorld(swarmMap.origin.lat, swarmMap.origin.lon, width, height);
  const vmPulse = pulseForSpeed(now, totalIngestBps);
  const vmColor = heatColor(totalIngestBps);
  const vmLabelColor = '191, 255, 0';
  const vmRadius = 4.5 * (1 + vmPulse.value);
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, vmRadius + 5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(' + vmColor + ', ' + (.06 + vmPulse.value * .10) + ')';
  ctx.fill();
  ctx.fillStyle = 'rgb(' + vmColor + ')';
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, vmRadius, 0, Math.PI * 2);
  ctx.shadowColor = 'rgba(' + vmColor + ', .75)';
  ctx.shadowBlur = 16 + vmPulse.value * 14;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillStyle = 'rgba(' + vmLabelColor + ', .95)';
  ctx.textAlign = 'center';
  ctx.fillText('VM', origin.x, origin.y - vmRadius - 7);
  ctx.textAlign = 'start';

  swarmMap.displayPeers = swarmMap.displayPeers.filter((item) => item.alpha > .02 || !item.fading);
  swarmMap.displayPeers.forEach((item) => {
    const target = projectWorld(item.targetLat, item.targetLon, width, height);
    if (!item.x && !item.y) {
      item.x = target.x;
      item.y = target.y;
    }
    item.x = target.x;
    item.y = target.y;
    item.alpha += ((item.fading ? 0 : 1) - item.alpha) * (1 - Math.exp(-dt / 360));
    const targetAlpha = item.peer.active ? 1 : item.peer.probing ? .72 : .38;
    const alpha = Math.max(0, Math.min(targetAlpha, item.alpha * targetAlpha));
    const hue = 166 + (item.rank % 9) * 12;
    const peerPulse = pulseForSpeed(now, item.peer.receiveRateBps, item.phase + Math.PI);
    const activeColor = heatColor(item.peer.receiveRateBps);

    const start = { x: origin.x, y: origin.y };
    const end = { x: item.x, y: item.y };
    const midX = (origin.x + item.x) / 2;
    const midY = (origin.y + item.y) / 2 - Math.min(80, Math.abs(origin.x - item.x) * .12);
    const control = { x: midX, y: midY };
    if (item.peer.active) {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
      ctx.strokeStyle = 'rgba(' + activeColor + ', ' + (.62 * alpha) + ')';
      ctx.lineWidth = 2.2;
      ctx.shadowColor = 'rgba(' + activeColor + ', .36)';
      ctx.shadowBlur = 7;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    if (item.peer.active) {
      const rateBps = Number(item.peer.receiveRateBps) || 0;
      const speedFactor = Math.max(.55, Math.min(4.5, Math.log2(rateBps / 32768 + 1)));
      const packetCount = Math.max(2, Math.min(8, Math.round(2 + speedFactor * 1.35)));
      for (let i = 0; i < packetCount; i += 1) {
        const travel = ((now / (1550 / speedFactor)) + i / packetCount + item.phase) % 1;
        const t = 1 - travel;
        const head = quadPoint(start, control, end, t);
        const tail = quadPoint(start, control, end, Math.min(1, t + .03 + speedFactor * .006));
        const packetAlpha = alpha * (.42 + .58 * Math.sin(travel * Math.PI));
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(head.x, head.y);
        ctx.strokeStyle = 'rgba(' + activeColor + ', ' + packetAlpha + ')';
        ctx.lineWidth = 3.2;
        ctx.shadowColor = 'rgba(' + activeColor + ', .88)';
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(head.x, head.y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + activeColor + ', ' + packetAlpha + ')';
        ctx.fill();
      }
    }

    ctx.beginPath();
    const activePeerRadius = 2.25 + (1 - peerPulse.value) * 2.25;
    const outerRadius = item.peer.active ? activePeerRadius + 3 : item.peer.probing ? 5 : 4;
    ctx.arc(item.x, item.y, outerRadius, 0, Math.PI * 2);
    ctx.fillStyle = item.peer.active
      ? 'rgba(' + activeColor + ', ' + (.075 * alpha) + ')'
      : item.peer.probing
        ? 'rgba(247, 198, 95, ' + (.06 * alpha) + ')'
        : 'rgba(247, 198, 95, ' + (.05 * alpha) + ')';
    ctx.fill();
    ctx.beginPath();
    const innerRadius = item.peer.active ? activePeerRadius : item.peer.probing ? 3.1 : 2.6;
    ctx.arc(item.x, item.y, innerRadius, 0, Math.PI * 2);
    ctx.fillStyle = item.peer.active
      ? 'rgba(' + activeColor + ', ' + (.95 * alpha) + ')'
      : item.peer.probing
        ? 'rgba(247, 198, 95, ' + (.88 * alpha) + ')'
        : 'rgba(247, 198, 95, ' + (.78 * alpha) + ')';
    ctx.shadowColor = item.peer.active ? 'rgba(' + activeColor + ', ' + (.75 * alpha) + ')' : 'transparent';
    ctx.shadowBlur = item.peer.active ? 7 + (1 - peerPulse.value) * 7 : 0;
    ctx.fill();
    ctx.shadowBlur = 0;
  });
  renderMapPeerLabels(width, height);
}

function renderItems(items) {
  const container = document.getElementById('items');
  const seen = new Set();
  const priority = { active: 0, organizing: 0, pending: 1, failed: 2, completed: 3 };
  const orderedItems = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (priority[a.item.status] ?? 1) - (priority[b.item.status] ?? 1) || a.index - b.index)
    .map((entry) => entry.item);
  orderedItems.forEach((item) => {
    const rowId = rowIdFor(item.id);
    seen.add(rowId);
    let row = document.getElementById(rowId);
    if (!row) {
      row = document.createElement('article');
      row.id = rowId;
      row.innerHTML =
        '<div class="title"><div data-role="title"></div><div class="mono" data-role="size"></div></div>' +
        '<div><span data-role="status" class="chip"></span></div>' +
        '<div><div data-role="progress-label"></div><div class="item-bar"><div data-role="fill" class="item-fill"></div></div><div class="mono" data-role="detail"></div></div>' +
        '<div><div class="label">Rate</div><div data-role="rate"></div></div>' +
        '<div><div class="label">ETA</div><div data-role="eta"></div></div>';
    }
    container.appendChild(row);

    const progress = item.status === 'completed' ? 100 : clamp(item.progress.percent);
    const statusClass = statusClassFor(item.status);
    row.className = 'item ' + statusClass;
    setText(row.querySelector('[data-role="title"]'), item.title);
    setText(row.querySelector('[data-role="size"]'), fmt(item.totalBytes));

    const chip = row.querySelector('[data-role="status"]');
    chip.className = 'chip ' + statusClass;
    setText(chip, item.status);

    tweenElementNumber(
      row.querySelector('[data-role="progress-label"]'),
      progress,
      (value) => value ? Math.round(value) + '%' : 'waiting',
      700,
    );
    row.querySelector('[data-role="fill"]').style.width = progress + '%';
    setText(row.querySelector('[data-role="detail"]'), progressDetailFor(item));
    setText(row.querySelector('[data-role="rate"]'), item.progress.rate || '-');
    setText(row.querySelector('[data-role="eta"]'), item.progress.eta || '-');
  });
  Array.from(container.children).forEach((row) => {
    if (!seen.has(row.id)) row.remove();
  });
}

function activeItem(data) {
  return data.items.find((item) => item.status === 'active' || item.status === 'organizing') ?? null;
}

function parseSpeed(rate) {
  const match = String(rate || '').match(/^([0-9.]+)(B|KiB|MiB|GiB|TiB)$/);
  if (!match) return 0;
  const value = Number(match[1]);
  const multipliers = { B: 1 / 1024 / 1024, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1024 * 1024 };
  return value * multipliers[match[2]];
}

function formatSpeed(value) {
  if (!Number.isFinite(value)) return '0 MiB/s';
  if (value >= 1024) return (value / 1024).toFixed(2) + ' GiB/s';
  return value.toFixed(value >= 10 ? 0 : 1) + ' MiB/s';
}

function formatPeerRate(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  if (value >= 1024 * 1024 * 1024) return (value / 1024 / 1024 / 1024).toFixed(2) + ' GiB/s';
  if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1) + ' MiB/s';
  if (value >= 1024) return (value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1) + ' KiB/s';
  return Math.round(value) + ' B/s';
}

function resetWarpStar(star, fresh) {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.pow(Math.random(), .65) * 1.7;
  star.x = Math.cos(angle) * radius;
  star.y = Math.sin(angle) * radius;
  star.z = fresh ? Math.random() * .95 + .08 : .98;
  star.size = Math.random() * 1.35 + .45;
  star.twinkle = Math.random() * Math.PI * 2;
}

function resizeWarp() {
  const canvas = document.getElementById('warpCanvas');
  if (!canvas) return;
  warp.dpr = Math.min(2, window.devicePixelRatio || 1);
  warp.width = window.innerWidth;
  warp.height = window.innerHeight;
  canvas.width = Math.floor(warp.width * warp.dpr);
  canvas.height = Math.floor(warp.height * warp.dpr);
}

function initWarp() {
  resizeWarp();
  if (!warp.stars.length) {
    for (let i = 0; i < 180; i += 1) {
      const star = {};
      resetWarpStar(star, true);
      warp.stars.push(star);
    }
  }
  if (!warp.raf) warp.raf = requestAnimationFrame(drawWarpFrame);
}

function drawWarpFrame(now) {
  warp.raf = requestAnimationFrame(drawWarpFrame);
  const canvas = document.getElementById('warpCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dt = warp.lastFrame ? Math.min(80, now - warp.lastFrame) : 16;
  warp.lastFrame = now;
  const targetSpeed = Math.min(1, speedChart.current / 75);
  warp.speed += (targetSpeed - warp.speed) * (1 - Math.exp(-dt / 520));
  const centerX = warp.width * (.50 + Math.sin(now / 6200) * .015);
  const centerY = warp.height * (.36 + Math.cos(now / 7400) * .018);
  const hue = 168 + warp.batchProgress * .95;
  const pace = (.00009 + warp.speed * .0011) * dt;
  const streak = 1.8 + warp.speed * 20;

  ctx.setTransform(warp.dpr, 0, 0, warp.dpr, 0, 0);
  ctx.clearRect(0, 0, warp.width, warp.height);
  ctx.globalCompositeOperation = 'lighter';

  const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(warp.width, warp.height) * .62);
  glow.addColorStop(0, 'hsla(' + hue + ', 80%, 58%, ' + (.08 + warp.speed * .08) + ')');
  glow.addColorStop(.42, 'hsla(' + (hue + 35) + ', 80%, 45%, .035)');
  glow.addColorStop(1, 'hsla(' + hue + ', 80%, 45%, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, warp.width, warp.height);

  warp.stars.forEach((star) => {
    const oldZ = star.z;
    star.z -= pace * (.65 + star.size * .28);
    if (star.z <= .035) resetWarpStar(star, false);

    const scale = Math.min(warp.width, warp.height) * .23;
    const x = centerX + star.x / star.z * scale;
    const y = centerY + star.y / star.z * scale;
    const oldX = centerX + star.x / oldZ * scale;
    const oldY = centerY + star.y / oldZ * scale;

    if (x < -80 || x > warp.width + 80 || y < -80 || y > warp.height + 80) {
      resetWarpStar(star, false);
      return;
    }

    const alpha = Math.min(.88, (.10 + (1 - star.z) * .52 + warp.speed * .24) * (.72 + Math.sin(now / 420 + star.twinkle) * .18));
    ctx.lineWidth = star.size * (.7 + warp.speed * .7);
    ctx.strokeStyle = 'hsla(' + hue + ', 92%, 72%, ' + alpha + ')';
    ctx.beginPath();
    ctx.moveTo(oldX, oldY);
    ctx.lineTo(x + (x - oldX) * streak, y + (y - oldY) * streak);
    ctx.stroke();
  });

  ctx.globalCompositeOperation = 'source-over';
}

function updateSpeedChart(value) {
  const now = performance.now();
  speedChart.target = Number.isFinite(value) ? value : 0;
  if (!speedChart.samples.length || now - speedChart.lastSampleAt >= 450) {
    speedChart.samples.push({ time: now, value: speedChart.target });
    speedChart.lastSampleAt = now;
  } else {
    speedChart.samples[speedChart.samples.length - 1].value = speedChart.target;
  }
  const oldest = now - speedChart.windowMs - 1000;
  while (speedChart.samples.length > 2 && speedChart.samples[0].time < oldest) {
    speedChart.samples.shift();
  }
  if (!speedChart.raf) speedChart.raf = requestAnimationFrame(drawSpeedFrame);
}

function drawSpeedFrame(now) {
  speedChart.raf = requestAnimationFrame(drawSpeedFrame);
  const canvas = document.getElementById('speedCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.floor(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext('2d');
  const dt = speedChart.lastFrame ? Math.min(120, now - speedChart.lastFrame) : 16;
  speedChart.lastFrame = now;
  const alpha = 1 - Math.exp(-dt / 420);
  speedChart.current += (speedChart.target - speedChart.current) * alpha;
  const windowStart = now - speedChart.windowMs;
  while (speedChart.samples.length > 2 && speedChart.samples[0].time < windowStart - 1000) {
    speedChart.samples.shift();
  }

  const points = speedChart.samples
    .filter((point) => point.time >= windowStart)
    .concat({ time: now, value: speedChart.current });
  const targetMax = Math.max(10, ...points.map((point) => point.value)) * 1.18;
  speedChart.max += (targetMax - speedChart.max) * Math.min(1, dt / 900);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const pad = 14;
  const width = rect.width - pad * 2;
  const height = rect.height - pad * 2;
  const max = Math.max(10, speedChart.max);

  ctx.strokeStyle = 'rgba(150, 167, 190, .24)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad + (height / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(rect.width - pad, y);
    ctx.stroke();
  }

  const gradient = ctx.createLinearGradient(0, pad, 0, rect.height - pad);
  gradient.addColorStop(0, 'rgba(87, 224, 194, .40)');
  gradient.addColorStop(1, 'rgba(87, 224, 194, 0)');

  const toX = (time) => pad + ((time - windowStart) / speedChart.windowMs) * width;
  const toY = (value) => pad + height - (value / max) * height;

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = toX(point.time);
    const y = toY(point.value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(rect.width - pad, rect.height - pad);
  ctx.lineTo(pad, rect.height - pad);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = toX(point.time);
    const y = toY(point.value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#57e0c2';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(87, 224, 194, .55)';
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const head = points.at(-1);
  if (head) {
    ctx.beginPath();
    ctx.arc(toX(head.time), toY(head.value), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#d9fff6';
    ctx.shadowColor = 'rgba(87, 224, 194, .85)';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function celebrate() {
  for (let i = 0; i < 26; i += 1) {
    const particle = document.createElement('span');
    particle.className = 'burst';
    particle.style.left = '50vw';
    particle.style.top = '84px';
    particle.style.background = ['#57e0c2', '#f7c65f', '#f47086', '#78a6ff', '#7ee787'][i % 5];
    particle.style.setProperty('--x', (Math.cos(i / 26 * Math.PI * 2) * (90 + Math.random() * 110)) + 'px');
    particle.style.setProperty('--y', (Math.sin(i / 26 * Math.PI * 2) * (50 + Math.random() * 90)) + 'px');
    document.body.appendChild(particle);
    setTimeout(() => particle.remove(), 950);
  }
}

function render(data) {
  const active = activeItem(data);
  const activePercent = active ? active.progress.percent || 0 : data.totals.completedItems === data.totals.totalItems ? 100 : 0;
  const activeStreams = Array.isArray(data.swarm?.peers)
    ? data.swarm.peers.filter((peer) => peer.active && Number.isFinite(peer.lat) && Number.isFinite(peer.lon)).slice(0, 32).length
    : 0;
  const diskUse = Number(String(data.disk.usePercent || '0').replace('%', '')) || 0;
  const diskFree = clamp(100 - diskUse);
  const speed = parseSpeed(active?.progress?.rate);
  warp.batchProgress = data.totals.percent;

  document.getElementById('connection').textContent = 'Live';
  document.getElementById('subtitle').textContent = active ? active.title : 'Queue idle';
  tweenNumber('batchPercent', data.totals.percent, (value) => value.toFixed(1) + '%', 800);
  document.getElementById('batchText').textContent = data.totals.completedItems + ' of ' + data.totals.totalItems + ' complete';
  tweenNumber('activePercent', activePercent, (value) => Math.round(value) + '%', 800);
  document.getElementById('activeText').textContent = active ? (active.progress.eta ? 'ETA ' + active.progress.eta : active.status) : 'No active item';
  tweenNumber('diskPercent', diskFree, (value) => Math.round(value) + '%', 800);
  document.getElementById('diskText').textContent = data.disk.available + ' free of ' + data.disk.size;
  setRing('batchRing', data.totals.percent);
  setRing('activeRing', activePercent);
  setRing('diskRing', diskFree);
  document.getElementById('totalFill').style.width = clamp(data.totals.percent) + '%';
  tweenNumber('downloaded', data.totals.doneBytes, (value) => fmt(value) + ' / ' + fmt(data.totals.totalBytes), 700);
  document.getElementById('updated').textContent = new Date(data.generatedAt).toLocaleTimeString();
  tweenNumber('speedNow', speed, formatSpeed, 450);
  if (active) tweenNumber('currentMini', activePercent, (value) => Math.round(value) + '% @ ' + (active.progress.rate || '-'), 700);
  else document.getElementById('currentMini').textContent = '-';
  document.getElementById('etaMini').textContent = active?.progress?.eta || '-';
  document.getElementById('mapTorrentTitle').textContent = active ? active.title : 'Queue idle';
  document.getElementById('mapTorrentProgress').textContent = active ? Math.round(activePercent) + '%' : '-';
  document.getElementById('mapTorrentRate').textContent = active?.progress?.rate || '-';
  document.getElementById('mapTorrentEta').textContent = active?.progress?.eta || '-';
  document.getElementById('mapTorrentSeeds').textContent = 'Streams ' + activeStreams;
  document.getElementById('mapTorrentFill').style.width = clamp(activePercent) + '%';
  tweenNumber('remainingMini', Math.max(0, data.totals.totalBytes - data.totals.doneBytes), fmt, 700);
  updateSpeedChart(speed);

  data.items.forEach((item) => {
    if (item.status === 'completed' && !completedSeen.has(item.id)) {
      completedSeen.add(item.id);
      if (renderedOnce) celebrate();
    }
  });
  renderedOnce = true;

  renderItems(data.items);
  renderSwarmMap(data.swarm);
  document.getElementById('log').textContent = data.batchLogTail || '';
}
async function refreshFallback() {
  const res = await fetch('/status.json', { cache: 'no-store' });
  render(await res.json());
}
if ('EventSource' in window) {
  const events = new EventSource('/events');
  events.addEventListener('status', (event) => render(JSON.parse(event.data)));
  events.addEventListener('error', () => {
    document.getElementById('connection').textContent = 'Reconnecting';
  });
} else {
  document.getElementById('connection').textContent = 'Fallback';
  refreshFallback();
  setInterval(refreshFallback, 1000);
}
initWarp();
initMapControls();
window.addEventListener('resize', () => {
  resizeWarp();
  updateSpeedChart(speedChart.target);
  applyMapTransform();
});
</script>
</body>
</html>`;
}

Bun.serve({
  hostname: host,
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/events") {
      return new Response(statusStream(), {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }
    if (url.pathname === "/status.json") {
      return Response.json(await buildStatus(), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/assets/BlankMap-Equirectangular.svg") {
      return new Response(Bun.file(join(import.meta.dir, "assets", "BlankMap-Equirectangular.svg")), {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
      });
    }
    return new Response(page(), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
});

console.log(`Plex progress server listening on http://${host}:${port}`);
