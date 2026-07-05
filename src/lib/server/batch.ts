import { existsSync, readFileSync, statSync } from "fs";
import { mkdir, readdir, rename, writeFile } from "fs/promises";
import { basename, join } from "path";

export const root = process.env.BATCH_DIR ?? "/media/plex/.downloads/torrent-batch";
const ignoredPeerIps = new Set((process.env.IGNORED_PEER_IPS ?? "").split(",").map((ip) => ip.trim()).filter(Boolean));
const mediaRoot = (process.env.MEDIA_ROOT ?? "/media/plex").replace(/\/$/, "");
const moviesDir = process.env.MOVIES_DIR ?? `${mediaRoot}/Movies`;
const tvDir = process.env.TV_DIR ?? `${mediaRoot}/TV Shows`;
const diskUsagePath = process.env.DISK_USAGE_PATH ?? mediaRoot;
const maxTorrentBytes = 20 * 1024 * 1024;

type Item = {
  id: string;
  title: string;
  torrentFile?: string;
  magnetUri?: string;
  payloadName: string;
  totalBytes: number;
  fileCount?: number;
  destination: { type: "movie" | "show"; path: string };
  organize?:
    | { strategy: "moveRoot"; seasonRenames?: Record<string, string>; fileRenames?: Record<string, string> }
    | { strategy: "mergeRoot"; targetSubdir?: string }
    | { strategy: "singleFile"; source: string; finalName: string }
    | { strategy: "singleEpisode"; source: string; finalName: string };
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

function textValue(value: unknown): string {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value ?? "");
}

function bdecode(bytes: Uint8Array) {
  const decoder = new TextDecoder();
  const parse = (offset: number): [unknown, number] => {
    const char = String.fromCharCode(bytes[offset]);
    if (char === "i") {
      const end = bytes.indexOf(101, offset);
      return [Number(decoder.decode(bytes.slice(offset + 1, end))), end + 1];
    }
    if (char === "l") {
      const values: unknown[] = [];
      let cursor = offset + 1;
      while (bytes[cursor] !== 101) {
        const [value, next] = parse(cursor);
        values.push(value);
        cursor = next;
      }
      return [values, cursor + 1];
    }
    if (char === "d") {
      const values: Record<string, unknown> = {};
      let cursor = offset + 1;
      while (bytes[cursor] !== 101) {
        const [key, keyNext] = parse(cursor);
        const [value, valueNext] = parse(keyNext);
        values[textValue(key)] = value;
        cursor = valueNext;
      }
      return [values, cursor + 1];
    }
    if (/\d/.test(char)) {
      let colon = offset;
      while (bytes[colon] !== 58) colon += 1;
      const length = Number(decoder.decode(bytes.slice(offset, colon)));
      const start = colon + 1;
      return [bytes.slice(start, start + length), start + length];
    }
    throw new Error(`Invalid torrent metadata at byte ${offset}`);
  };
  return parse(0)[0] as Record<string, unknown>;
}

function torrentMetadata(bytes: Uint8Array, filename: string) {
  const decoded = bdecode(bytes);
  const info = decoded.info as Record<string, unknown> | undefined;
  if (!info) throw new Error("Torrent is missing info dictionary");
  const payloadName = textValue(info.name || basename(filename, ".torrent"));
  const fileEntries = Array.isArray(info.files)
    ? info.files.map((entry) => {
        const record = entry as Record<string, unknown>;
        const parts = Array.isArray(record.path) ? record.path.map(textValue) : [];
        return { path: parts.join("/"), length: Number(record.length) || 0 };
      })
    : [{ path: payloadName, length: Number(info.length) || 0 }];
  const totalBytes = fileEntries.reduce((sum, entry) => sum + entry.length, 0);
  return {
    filename,
    payloadName,
    totalBytes,
    fileCount: fileEntries.length,
    files: fileEntries.slice(0, 40),
    suggested: suggestManifestFields(payloadName, filename, fileEntries),
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "torrent-item";
}

function cleanTitle(value: string) {
  return value
    .replace(/\.(?=[A-Za-z0-9])/g, " ")
    .replace(/\b(complete|proper|repack|web-dl|webrip|bluray|brrip|x264|x265|hevc|h264|h265|aac|ddp?5?\.?1|atmos|multi|subs?|esubs|dv|hdr|dolby|vision|profile|mp4|mkv|1080p|2160p|720p|10bit|8bit)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function suggestManifestFields(payloadName: string, filename: string, files: Array<{ path: string; length: number }>) {
  const source = cleanTitle(payloadName || filename.replace(/\.torrent$/i, ""));
  const seasonMatch = source.match(/\bS(?:eason)?\s*0?(\d{1,2})\b/i) || filename.match(/\bS(?:eason)?\s*0?(\d{1,2})\b/i);
  const yearMatch = source.match(/\b(19\d{2}|20\d{2})\b/);
  const isShow = Boolean(seasonMatch || files.filter((entry) => /\.(mkv|mp4|m4v|avi)$/i.test(entry.path)).length > 2);
  const titleBase = source
    .replace(/\bS(?:eason)?\s*0?\d{1,2}\b/ig, "")
    .replace(/\bCOMPLETE\b/ig, "")
    .replace(/\s+/g, " ")
    .trim();
  const displayTitle = yearMatch && !titleBase.includes(yearMatch[1]) ? `${titleBase} (${yearMatch[1]})` : titleBase;
  const season = seasonMatch ? Number(seasonMatch[1]) : 1;
  const destinationRoot = isShow ? tvDir : moviesDir;
  const title = isShow ? `${displayTitle} S${String(season).padStart(2, "0")}` : displayTitle;
  return {
    id: slugify(title),
    title,
    mediaType: isShow ? "show" : "movie",
    destinationPath: `${destinationRoot}/${displayTitle || payloadName}`,
    organizeStrategy: isShow ? "mergeRoot" : "moveRoot",
    targetSubdir: isShow ? `Season ${season}` : "",
  };
}

function safeTorrentFilename(name: string) {
  const cleaned = basename(name).replace(/[^\w .()[\]{}+,&:;'!@#%=-]/g, "_").trim();
  return cleaned.toLowerCase().endsWith(".torrent") ? cleaned : `${cleaned || "upload"}.torrent`;
}

function magnetMetadata(uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("Magnet link is invalid");
  }
  if (url.protocol !== "magnet:") throw new Error("Magnet link must start with magnet:");
  const xt = url.searchParams.getAll("xt").find((value) => /^urn:btih:[a-z0-9]+$/i.test(value));
  if (!xt) throw new Error("Magnet link is missing a btih hash");
  const hash = xt.split(":").at(-1) ?? "";
  if (!/^[a-z0-9]{32,40}$/i.test(hash)) throw new Error("Magnet link has an invalid btih hash");
  const displayName = url.searchParams.get("dn")?.trim() || `Magnet ${hash.slice(0, 12)}`;
  const suggested = suggestManifestFields(displayName, `${displayName}.torrent`, []);
  return {
    magnetUri: uri,
    hash,
    filename: "",
    payloadName: displayName,
    totalBytes: 0,
    fileCount: 0,
    files: [],
    suggested,
  };
}

async function saveManifest(manifest: Manifest) {
  const path = join(root, "manifest.json");
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, path);
}

function parseAmount(value: string, unit: string): number {
  return Number(value) * (byteUnits[unit] ?? 1);
}

function parseRateBytesPerSecond(rate: string): number {
  const match = String(rate || "").match(/^([0-9.]+)(B|KiB|MiB|GiB|TiB)$/);
  return match ? parseAmount(match[1], match[2]) : 0;
}

function formatEtaSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const rounded = Math.max(1, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${secs}s`;
  return `${secs}s`;
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
  const proc = Bun.spawnSync(["df", "-h", diskUsagePath]);
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

export async function buildStatus() {
  const manifest = readJson<Manifest>(join(root, "manifest.json"), { createdAt: "", items: [] });
  const state = readJson<State>(join(root, "state.json"), {});
  const stateItems = state.items ?? {};
  let completedBytes = 0;
  let activeBytes = 0;
  let activeTotalBytes = 0;
  let activeRateBytesPerSecond = 0;
  let activeConnections = 0;
  let activeSeeders = 0;

  const items = manifest.items.map((item) => {
    const itemState = stateItems[item.id] ?? {};
    const log = readTail(join(root, "logs", `${item.id}.log`));
    const progress = parseProgress(log);
    const status = itemState.status ?? "pending";
    const effectiveTotalBytes = item.totalBytes || progress.totalBytes;
    if (status === "completed") {
      completedBytes += effectiveTotalBytes;
    } else if (status === "active" || status === "organizing") {
      activeBytes += Math.min(progress.downloadedBytes, effectiveTotalBytes || progress.downloadedBytes);
      activeTotalBytes += effectiveTotalBytes;
      activeRateBytesPerSecond += parseRateBytesPerSecond(progress.rate);
      activeConnections += progress.connections;
      activeSeeders += progress.seeders;
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

  const totalBytes = items.reduce((sum, item) => sum + (item.totalBytes || item.progress.totalBytes), 0);
  const activeItems = items.filter((item) => item.status === "active" || item.status === "organizing");
  const activeRemainingBytes = Math.max(0, activeTotalBytes - activeBytes);
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
      activeItems: activeItems.length,
      activeBytes,
      activeTotalBytes,
      activePercent: activeTotalBytes ? Math.floor((activeBytes / activeTotalBytes) * 1000) / 10 : 0,
      activeRateBytesPerSecond,
      activeEta: activeRateBytesPerSecond > 0 ? formatEtaSeconds(activeRemainingBytes / activeRateBytesPerSecond) : "",
      activeConnections,
      activeSeeders,
    },
    disk: await diskUsage(),
    swarm: await swarmPeers({ connections: activeConnections, seeders: activeSeeders }),
    items,
    logs: await listLogs(),
    batchLogTail: rawLog.split(/\r?\n/).slice(-80).join("\n"),
  };
}

function formString(form: FormData, key: string, fallback = "") {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : fallback;
}

function formBool(form: FormData, key: string, fallback = false) {
  const value = form.get(key);
  if (typeof value !== "string") return fallback;
  return value === "1" || value === "true" || value === "on";
}

async function torrentFromForm(form: FormData) {
  const upload = form.get("torrent");
  if (!(upload instanceof File) || !upload.name) throw new Error("Missing torrent file");
  if (!upload.name.toLowerCase().endsWith(".torrent")) throw new Error("Upload must be a .torrent file");
  const bytes = new Uint8Array(await upload.arrayBuffer());
  if (bytes.length > maxTorrentBytes) throw new Error("Torrent file is too large");
  if (!bytes.length) throw new Error("Torrent file is empty");
  return { bytes, filename: safeTorrentFilename(upload.name) };
}

export async function inspectTorrentUpload(req: Request) {
  const form = await req.formData();
  const magnetUri = formString(form, "magnetUri");
  if (magnetUri) {
    return Response.json(magnetMetadata(magnetUri), { headers: { "cache-control": "no-store" } });
  }
  const { bytes, filename } = await torrentFromForm(form);
  return Response.json(torrentMetadata(bytes, filename), { headers: { "cache-control": "no-store" } });
}

export async function addTorrentUpload(req: Request) {
  const form = await req.formData();
  const magnetUri = formString(form, "magnetUri");
  const torrentInput = magnetUri ? null : await torrentFromForm(form);
  const metadata = magnetUri ? magnetMetadata(magnetUri) : torrentMetadata(torrentInput!.bytes, torrentInput!.filename);
  const filename = torrentInput?.filename ?? "";
  const manifest = readJson<Manifest>(join(root, "manifest.json"), { createdAt: new Date().toISOString(), items: [] });
  const id = slugify(formString(form, "id", metadata.suggested.id));
  const title = formString(form, "title", metadata.suggested.title);
  const mediaType = formString(form, "mediaType", metadata.suggested.mediaType) === "movie" ? "movie" : "show";
  const destinationPath = formString(form, "destinationPath", metadata.suggested.destinationPath);
  const strategyInput = formString(form, "organizeStrategy", metadata.suggested.organizeStrategy);
  const targetSubdir = formString(form, "targetSubdir", metadata.suggested.targetSubdir);
  if (!id || !title || !destinationPath) throw new Error("Missing required manifest fields");
  const allowedRoots = [moviesDir, tvDir].map((path) => path.replace(/\/$/, ""));
  if (!allowedRoots.some((root) => destinationPath === root || destinationPath.startsWith(`${root}/`))) {
    throw new Error(`Destination must be under ${moviesDir} or ${tvDir}`);
  }
  if (manifest.items.some((item) => item.id === id)) throw new Error(`Manifest already has item id ${id}`);
  if (filename && manifest.items.some((item) => item.torrentFile === filename)) throw new Error(`Manifest already uses ${filename}`);
  if (magnetUri && manifest.items.some((item) => item.magnetUri === magnetUri)) throw new Error("Manifest already has this magnet link");

  const organize =
    strategyInput === "moveRoot"
      ? { strategy: "moveRoot" as const }
      : { strategy: "mergeRoot" as const, ...(targetSubdir ? { targetSubdir } : {}) };

  const item = {
    id,
    ...(filename ? { torrentFile: filename } : {}),
    ...(magnetUri ? { magnetUri } : {}),
    title,
    destination: { type: mediaType, path: destinationPath },
    organize,
    payloadName: metadata.payloadName,
    totalBytes: metadata.totalBytes,
    fileCount: metadata.fileCount,
  };

  if (torrentInput) {
    await mkdir(join(root, "torrents"), { recursive: true });
    await writeFile(join(root, "torrents", filename), torrentInput.bytes);
  }
  manifest.items.push(item);
  await saveManifest(manifest);


  return Response.json({ ok: true, item, restartMessage: "Queued; runner will pick it up automatically" }, { headers: { "cache-control": "no-store" } });
}

export function statusStream() {
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
