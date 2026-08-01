import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "fs";
import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, writeFile } from "fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, join } from "path";
import { createSmartIntakePlan, smartIntakeConfig } from "$lib/server/smart-intake";

export const root = process.env.BATCH_DIR ?? "/media/plex/.downloads/torrent-batch";
const ignoredPeerIps = new Set((process.env.IGNORED_PEER_IPS ?? "").split(",").map((ip) => ip.trim()).filter(Boolean));
const mediaRoot = (process.env.MEDIA_ROOT ?? "/media/plex").replace(/\/$/, "");
const moviesDir = process.env.MOVIES_DIR ?? `${mediaRoot}/Movies`;
const tvDir = process.env.TV_DIR ?? `${mediaRoot}/TV Shows`;
const diskUsagePath = process.env.DISK_USAGE_PATH ?? mediaRoot;
const maxTorrentBytes = 20 * 1024 * 1024;
const maxHtmlBytes = 2 * 1024 * 1024;
const configuredMetadataTimeout = Number.parseInt(process.env.TORPLEX_METADATA_TIMEOUT_SECONDS ?? "60", 10);
const metadataTimeoutSeconds = Number.isFinite(configuredMetadataTimeout)
  ? Math.min(300, Math.max(15, configuredMetadataTimeout))
  : 60;
const configuredMaxMapPeers = Number.parseInt(process.env.MAX_MAP_PEERS ?? "320", 10);
const maxMapPeers = Number.isFinite(configuredMaxMapPeers) && configuredMaxMapPeers > 0 ? configuredMaxMapPeers : 320;
const mapOriginLabel = (process.env.MAP_ORIGIN_LABEL ?? "SERVER").trim() || "SERVER";
const privateSeedIps = new Set((process.env.PRIVATE_SEED_IPS ?? "").split(",").map((ip) => ip.trim()).filter(Boolean));
const privateSeedLabel = (process.env.PRIVATE_SEED_LABEL ?? "VM SEED").trim() || "VM SEED";

type Item = {
  id: string;
  title: string;
  torrentFile?: string;
  magnetUri?: string;
  sourceUrl?: string;
  payloadName: string;
  totalBytes: number;
  fileCount?: number;
  selectFiles?: number[];
  rightsAttestedAt?: string;
  postDownload?: {
    verifyStreams: boolean;
    scanForMalware: boolean;
    ensureEnglishSubtitles: boolean;
    verifyCanonicalMetadata: boolean;
    verifyArtwork: boolean;
    refreshPlex: boolean;
  };
  destination: { type: "movie" | "show"; path: string };
  organize?:
    | { strategy: "moveRoot"; seasonRenames?: Record<string, string>; fileRenames?: Record<string, string> }
    | { strategy: "mergeRoot"; targetSubdir?: string }
    | { strategy: "routeDirectories"; routes: Array<{ sourcePath: string; destinationPath: string }> }
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
  pid?: string;
  itemId?: string;
  bytesReceived?: number;
  infrastructure?: boolean;
  label?: string;
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

type MapOrigin = {
  label: string;
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  lat: number;
  lon: number;
  lookupStatus: "mapped" | "fallback";
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
let mapOriginCache: { expiresAt: number; value: MapOrigin } | null = null;
let peerGeoBlockedUntil = 0;
type PeerSnapshot = {
  updatedAt: string;
  origin: MapOrigin;
  peers: PeerGeo[];
  activeCount: number;
  probingCount: number;
  inactiveCount: number;
  aria2Connections: number;
  aria2Seeders: number;
};
let peerSnapshot: PeerSnapshot = {
  updatedAt: new Date(0).toISOString(),
  origin: { label: mapOriginLabel, lat: 39, lon: -98, lookupStatus: "fallback" },
  peers: [],
  activeCount: 0,
  probingCount: 0,
  inactiveCount: 0,
  aria2Connections: 0,
  aria2Seeders: 0,
};
let lastPeerRefresh = 0;
let peerRefreshPromise: Promise<PeerSnapshot> | null = null;
let diskUsageCache: { expiresAt: number; value: Awaited<ReturnType<typeof readDiskUsage>> } | null = null;
const magnetMetadataResolutions = new Map<string, Promise<{ bytes: Uint8Array; filename: string }>>();
const peerRefreshMs = 5_000;
const peerGeoTtlMs = 12 * 60 * 60 * 1000;
const peerHistoryTtlMs = 15 * 60 * 1000;
const activeStreamIntervalMs = 1_000;
const idleStreamIntervalMs = 5_000;
const streamHeartbeatMs = 30_000;

type BuildStatusOptions = {
  includeBatchLogTail?: boolean;
  includeLogs?: boolean;
};

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readTail(path: string, maxBytes = 160_000): string {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(path, "r");
    const bytesRead = readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
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
  const fileEntries = (Array.isArray(info.files)
    ? info.files.map((entry) => {
        const record = entry as Record<string, unknown>;
        const parts = Array.isArray(record.path) ? record.path.map(textValue) : [];
        return { path: parts.join("/"), length: Number(record.length) || 0 };
      })
    : [{ path: payloadName, length: Number(info.length) || 0 }])
    .map((entry, index) => ({ ...entry, index: index + 1 }));
  const totalBytes = fileEntries.reduce((sum, entry) => sum + entry.length, 0);
  return {
    filename,
    payloadName,
    totalBytes,
    fileCount: fileEntries.length,
    files: fileEntries,
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

function isPrivateHostname(hostname: string) {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost");
}

function isPrivateIp(address: string) {
  const version = isIP(address);
  if (version === 0) return false;
  if (version === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  return (
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

async function assertFetchableSourceUrl(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL must use http or https");
  if (url.username || url.password) throw new Error("URL cannot include credentials");
  if (isPrivateHostname(url.hostname)) throw new Error("URL cannot target localhost");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("URL cannot target private network addresses");
  }
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function filenameFromResponse(url: URL, response: Response) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return safeTorrentFilename(decodeURIComponent(encoded.replace(/^"|"$/g, "")));
    } catch {
      return safeTorrentFilename(encoded);
    }
  }
  const quoted = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  if (quoted) return safeTorrentFilename(quoted);
  const pathName = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "download.torrent");
  return safeTorrentFilename(pathName);
}

async function limitedResponseBytes(response: Response, maxBytes: number, tooLargeMessage: string) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error(tooLargeMessage);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(tooLargeMessage);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(tooLargeMessage);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function fetchExternalSource(inputUrl: URL) {
  let url = inputUrl;
  for (let redirect = 0; redirect < 6; redirect += 1) {
    await assertFetchableSourceUrl(url);
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Torplex/1.0",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/x-bittorrent,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("URL redirect is missing a location");
      url = new URL(location, url);
      continue;
    }
    return { url, response };
  }
  throw new Error("URL redirected too many times");
}

function sourceHttpError(response: Response) {
  if (response.headers.get("cf-mitigated") === "challenge") {
    return `URL returned HTTP ${response.status}: the site is presenting a Cloudflare browser challenge to this server. Open it in a browser and paste the magnet link or upload the .torrent file.`;
  }
  if (response.status === 403) {
    return "URL returned HTTP 403: the site blocked this server or requires an interactive browser challenge. Open it in a browser and paste the magnet link, or download and upload the .torrent file.";
  }
  return `URL returned HTTP ${response.status}`;
}

function looksLikeTorrentResponse(url: URL, response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  const disposition = response.headers.get("content-disposition")?.toLowerCase() || "";
  return (
    url.pathname.toLowerCase().endsWith(".torrent") ||
    disposition.includes(".torrent") ||
    contentType.includes("application/x-bittorrent") ||
    contentType.includes("application/octet-stream")
  );
}

function extractTorrentSourceFromHtml(html: string, baseUrl: URL) {
  const decoded = decodeHtmlEntities(html);
  const magnet = decoded.match(/magnet:\?[^"'<>\s]+/i)?.[0];
  if (magnet) return { magnetUri: magnet };

  const hrefs = [...decoded.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gis)].map((match) => match[2]);
  const torrentHref = hrefs.find((href) => /\.torrent(?:[?#].*)?$/i.test(href) || /\.torrent[?#]/i.test(href));
  if (torrentHref) return { torrentUrl: new URL(torrentHref, baseUrl) };
  return null;
}

async function resolveSourceUrl(sourceUrl: string) {
  let inputUrl: URL;
  try {
    inputUrl = new URL(sourceUrl);
  } catch {
    throw new Error("URL is invalid");
  }

  const fetched = await fetchExternalSource(inputUrl);
  const { url, response } = fetched;
  if (!response.ok) throw new Error(sourceHttpError(response));

  if (looksLikeTorrentResponse(url, response)) {
    const bytes = await limitedResponseBytes(response, maxTorrentBytes, "Torrent file is too large");
    if (!bytes.length) throw new Error("Torrent file is empty");
    return { kind: "torrentUrl" as const, bytes, filename: filenameFromResponse(url, response), sourceUrl, resolvedUrl: url.href };
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (contentType && !contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new Error("URL did not return a torrent file or an HTML page");
  }
  const htmlBytes = await limitedResponseBytes(response, maxHtmlBytes, "HTML page is too large");
  const html = new TextDecoder().decode(htmlBytes);
  const extracted = extractTorrentSourceFromHtml(html, url);
  if (!extracted) throw new Error("No magnet link or .torrent link found on that page");
  if (extracted.magnetUri) return { kind: "magnet" as const, magnetUri: extracted.magnetUri, sourceUrl, resolvedUrl: url.href };
  if (!extracted.torrentUrl) throw new Error("No .torrent link found on that page");

  const torrent = await fetchExternalSource(extracted.torrentUrl);
  if (!torrent.response.ok) throw new Error(sourceHttpError(torrent.response).replace("URL returned", "Torrent link returned"));
  const bytes = await limitedResponseBytes(torrent.response, maxTorrentBytes, "Torrent file is too large");
  if (!bytes.length) throw new Error("Torrent file is empty");
  return {
    kind: "torrentUrl" as const,
    bytes,
    filename: filenameFromResponse(torrent.url, torrent.response),
    sourceUrl,
    resolvedUrl: torrent.url.href,
  };
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

async function resolveMagnetTorrent(uri: string, hash: string, inactivityTimeoutSeconds = metadataTimeoutSeconds) {
  const normalizedHash = hash.toLowerCase();
  const metadataDir = join(root, "torrent-metadata", normalizedHash);
  const filename = "metadata.torrent";
  const torrentPath = join(metadataDir, filename);
  if (existsSync(torrentPath)) {
    const bytes = new Uint8Array(readFileSync(torrentPath));
    if (bytes.length && bytes.length <= maxTorrentBytes) return { bytes, filename };
  }
  const pending = magnetMetadataResolutions.get(normalizedHash);
  if (pending) return pending;

  const resolution = (async () => {
    await mkdir(metadataDir, { recursive: true });
    await new Promise<string>((resolve, reject) => {
      const child = spawn("aria2c", [
        `--dir=${metadataDir}`,
        "--bt-metadata-only=true",
        "--bt-save-metadata=true",
        "--seed-time=0",
        "--seed-ratio=0",
        "--max-upload-limit=1K",
        "--bt-enable-lpd=false",
        "--enable-dht=true",
        "--enable-peer-exchange=true",
        "--file-allocation=none",
        "--summary-interval=0",
        "--console-log-level=warn",
        "--connect-timeout=15",
        "--timeout=15",
        `--bt-stop-timeout=${inactivityTimeoutSeconds}`,
        `--dht-file-path=${join(metadataDir, "dht.dat")}`,
        `--dht-file-path6=${join(metadataDir, "dht6.dat")}`,
        uri,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      const collect = (chunk: Buffer) => {
        log = `${log}${chunk.toString("utf8")}`.slice(-16_000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timeout = setTimeout(() => child.kill("SIGTERM"), (inactivityTimeoutSeconds + 20) * 1000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolve(log);
        else if (code === 7 || signal === "SIGTERM") {
          reject(new Error(`No connected peer supplied this magnet's file list within ${inactivityTimeoutSeconds} seconds. The reported swarm may be stale; retry later or use another source.`));
        }
        else reject(new Error(`aria2c metadata lookup ${signal ? `was stopped by ${signal}` : `exited ${code}`}${log ? `: ${log.trim().split("\n").at(-1)}` : ""}`));
      });
    });
    if (!existsSync(torrentPath)) {
      const resolvedFilename = (await readdir(metadataDir)).find((entry) => entry.toLowerCase().endsWith(".torrent"));
      if (!resolvedFilename) {
        throw new Error("No connected peer supplied this magnet's file list. The torrent may be inactive; retry later or upload its .torrent file.");
      }
      await rename(join(metadataDir, resolvedFilename), torrentPath);
    }
    const bytes = new Uint8Array(readFileSync(torrentPath));
    if (!bytes.length) throw new Error("Resolved magnet metadata is empty");
    if (bytes.length > maxTorrentBytes) throw new Error("Resolved magnet metadata is too large");
    return { bytes, filename };
  })();
  magnetMetadataResolutions.set(normalizedHash, resolution);
  try {
    return await resolution;
  } finally {
    magnetMetadataResolutions.delete(normalizedHash);
  }
}

async function saveManifest(manifest: Manifest) {
  const path = join(root, "manifest.json");
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, path);
}

async function saveState(state: State) {
  const path = join(root, "state.json");
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
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

function completedProgress(totalBytes: number) {
  return {
    line: "",
    downloadedBytes: totalBytes,
    totalBytes,
    percent: totalBytes ? 100 : 0,
    rate: "",
    eta: "",
    connections: 0,
    seeders: 0,
  };
}

function pendingProgress(totalBytes: number) {
  return {
    line: "",
    downloadedBytes: 0,
    totalBytes,
    percent: 0,
    rate: "",
    eta: "",
    connections: 0,
    seeders: 0,
  };
}

function readDiskUsage() {
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

async function diskUsage() {
  if (diskUsageCache && diskUsageCache.expiresAt > Date.now()) return diskUsageCache.value;
  const value = readDiskUsage();
  diskUsageCache = { expiresAt: Date.now() + 5_000, value };
  return value;
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

function aria2ProcessItems() {
  const processes = new Map<string, string>();
  let proc;
  try {
    proc = Bun.spawnSync(["ps", "-eo", "pid=,args="]);
  } catch {
    return processes;
  }
  if (proc.exitCode !== 0) return processes;
  for (const line of proc.stdout.toString().split(/\r?\n/)) {
    if (!line.includes("aria2c") || !line.includes("/staging/")) continue;
    const pid = line.trim().match(/^(\d+)/)?.[1];
    const itemId = line.match(/\/staging\/([^/\s]+)/)?.[1];
    if (pid && itemId) processes.set(pid, itemId);
  }
  return processes;
}

function killAria2ForItem(itemId: string) {
  const processes = aria2ProcessItems();
  const pids = [...processes.entries()]
    .filter(([, processItemId]) => processItemId === itemId)
    .map(([pid]) => pid);
  for (const pid of pids) {
    Bun.spawnSync(["kill", "-TERM", pid]);
  }
  if (pids.length) {
    Bun.spawnSync(["sleep", "0.4"]);
    for (const pid of pids) {
      const alive = Bun.spawnSync(["kill", "-0", pid]);
      if (alive.exitCode === 0) Bun.spawnSync(["kill", "-KILL", pid]);
    }
  }
  return pids;
}

async function removeItemArtifacts(item: Item) {
  await rm(join(root, "staging", item.id), { recursive: true, force: true });
  await rm(join(root, "logs", `${item.id}.log`), { force: true });
  if (item.torrentFile) await rm(join(root, "torrents", item.torrentFile), { force: true });
}

export async function removeTorrentItem(id: string) {
  const manifest = readJson<Manifest>(join(root, "manifest.json"), { createdAt: new Date().toISOString(), items: [] });
  const item = manifest.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`No torrent item found for ${id}`);
  const killedPids = killAria2ForItem(id);
  manifest.items = manifest.items.filter((entry) => entry.id !== id);
  await saveManifest(manifest);

  const state = readJson<State>(join(root, "state.json"), { items: {} });
  if (!state.items) state.items = {};
  delete state.items[id];
  if (state.currentItemId === id) state.currentItemId = null;
  await saveState(state);
  await removeItemArtifacts(item);

  for (const [key, peer] of peerHistory.entries()) {
    if (peer.itemId === id || key.startsWith(`${id}:`)) peerHistory.delete(key);
  }

  return { ok: true, item, killedPids };
}

export async function clearCompletedItems() {
  const manifest = readJson<Manifest>(join(root, "manifest.json"), { createdAt: new Date().toISOString(), items: [] });
  const state = readJson<State>(join(root, "state.json"), { items: {} });
  const stateItems = state.items ?? {};
  const completed = manifest.items.filter((item) => stateItems[item.id]?.status === "completed");
  if (!completed.length) return { ok: true, cleared: 0, items: [] };

  const completedIds = new Set(completed.map((item) => item.id));
  manifest.items = manifest.items.filter((item) => !completedIds.has(item.id));
  await saveManifest(manifest);

  state.items = { ...stateItems };
  for (const id of completedIds) delete state.items[id];
  if (state.currentItemId && completedIds.has(state.currentItemId)) state.currentItemId = null;
  await saveState(state);

  for (const item of completed) {
    await rm(join(root, "logs", `${item.id}.log`), { force: true });
    if (item.torrentFile) await rm(join(root, "torrents", item.torrentFile), { force: true });
  }

  return { ok: true, cleared: completed.length, items: completed };
}

export async function reorderQueueItems(ids: unknown) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("Queue order must be an array of item ids");
  }

  const requestedIds = ids.map((id) => id.trim());
  if (new Set(requestedIds).size !== requestedIds.length) throw new Error("Queue order contains duplicate item ids");

  const manifest = readJson<Manifest>(join(root, "manifest.json"), { createdAt: new Date().toISOString(), items: [] });
  const state = readJson<State>(join(root, "state.json"), { items: {} });
  const stateItems = state.items ?? {};
  const queueItems = manifest.items.filter((item) => {
    const status = stateItems[item.id]?.status ?? "pending";
    return status === "active" || status === "organizing" || status === "pending";
  });
  const queueIds = queueItems.map((item) => item.id);
  const requestedSet = new Set(requestedIds);

  if (requestedIds.length !== queueIds.length || queueIds.some((id) => !requestedSet.has(id))) {
    throw new Error("The queue changed; refresh and try again");
  }

  const runningItems = queueItems.filter((item) => {
    const status = stateItems[item.id]?.status;
    return status === "active" || status === "organizing";
  });
  const desiredRunningIds = new Set(requestedIds.slice(0, runningItems.length));
  const preemptedItems = runningItems.filter((item) => !desiredRunningIds.has(item.id));
  if (preemptedItems.some((item) => stateItems[item.id]?.status === "organizing")) {
    throw new Error("An item is being organized; wait for it to finish before changing the active priority");
  }

  const processItems = aria2ProcessItems();
  for (const item of preemptedItems) {
    if (![...processItems.values()].includes(item.id)) {
      throw new Error(`The active process for ${item.title} changed; refresh and try again`);
    }
  }

  const queueById = new Map(queueItems.map((item) => [item.id, item]));
  const reordered = requestedIds.map((id) => queueById.get(id)!);
  const queueSet = new Set(queueIds);
  let queueIndex = 0;
  manifest.items = manifest.items.map((item) => (queueSet.has(item.id) ? reordered[queueIndex++] : item));

  const preemptDir = join(root, "control", "preempt");
  if (preemptedItems.length) {
    await mkdir(preemptDir, { recursive: true });
    for (const item of preemptedItems) await writeFile(join(preemptDir, item.id), new Date().toISOString());
  }
  try {
    await saveManifest(manifest);
  } catch (error) {
    for (const item of preemptedItems) await rm(join(preemptDir, item.id), { force: true });
    throw error;
  }
  for (const item of preemptedItems) killAria2ForItem(item.id);

  return { ok: true, ids: requestedIds, preemptedIds: preemptedItems.map((item) => item.id) };
}

function peerKey(peer: Pick<Peer, "ip" | "port" | "pid" | "itemId">) {
  return `${peer.itemId || peer.pid || "unknown"}:${peer.ip}:${peer.port}`;
}

function connectedPeers(): Peer[] {
  const processes = aria2ProcessItems();
  let proc;
  try {
    proc = Bun.spawnSync(["ss", "-Htinp"]);
  } catch {
    return [];
  }
  if (proc.exitCode !== 0) return [];
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
    const pid = line.match(/\bpid=(\d+)/)?.[1];
    const infrastructure = privateSeedIps.has(remote.ip);
    current = {
      ip: remote.ip,
      port: remote.port,
      state,
      ...(pid ? { pid, itemId: processes.get(pid) } : {}),
      ...(infrastructure ? { infrastructure: true, label: privateSeedLabel } : {}),
    };
    peers.set(peerKey(current), current);
  }
  return [...peers.values()].slice(0, maxMapPeers);
}

function markPeerActivity(peer: PeerGeo, nowMs: number): PeerGeo {
  const previous = peerHistory.get(peerKey(peer));
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

function peerGeoValue(peer: Peer, data: Record<string, unknown>): PeerGeo {
  return {
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
}

async function lookupPeers(peers: Peer[]): Promise<PeerGeo[]> {
  const nowMs = Date.now();
  const missingIps = [...new Set(peers
    .map((peer) => peer.ip)
    .filter((ip) => !peerGeoCache.get(ip) || Number(peerGeoCache.get(ip)?.expiresAt) <= nowMs))];

  if (missingIps.length && nowMs >= peerGeoBlockedUntil) {
    const fields = "status,country,countryCode,regionName,city,lat,lon,isp,as,query";
    for (let offset = 0; offset < missingIps.length; offset += 100) {
      const chunk = missingIps.slice(offset, offset + 100);
      try {
        const response = await fetch(`http://ip-api.com/batch?fields=${fields}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(5_000),
        });
        const remaining = Number(response.headers.get("x-rl"));
        const retrySeconds = Number(response.headers.get("x-ttl"));
        if (remaining === 0 && Number.isFinite(retrySeconds)) {
          peerGeoBlockedUntil = Date.now() + Math.max(1, retrySeconds) * 1000;
        }
        if (!response.ok) throw new Error(`Peer geolocation returned HTTP ${response.status}`);
        const rows = (await response.json()) as Array<Record<string, unknown>>;
        for (const data of rows) {
          const ip = String(data.query ?? "");
          if (!ip || data.status !== "success") continue;
          const peer = peers.find((entry) => entry.ip === ip);
          if (!peer) continue;
          peerGeoCache.set(ip, { expiresAt: Date.now() + peerGeoTtlMs, value: peerGeoValue(peer, data) });
        }
      } catch {
        for (const ip of chunk) {
          if (peerGeoCache.has(ip)) continue;
          const peer = peers.find((entry) => entry.ip === ip);
          if (peer) {
            peerGeoCache.set(ip, {
              expiresAt: Date.now() + 60_000,
              value: { ...peer, lookupStatus: "unmapped" },
            });
          }
        }
      }
      if (Date.now() < peerGeoBlockedUntil) break;
    }
  }

  return peers.map((peer) => {
    const cached = peerGeoCache.get(peer.ip);
    return cached ? { ...cached.value, ...peer } : { ...peer, lookupStatus: "unmapped" };
  });
}

async function mapOrigin(): Promise<MapOrigin> {
  const configuredLat = process.env.MAP_ORIGIN_LAT?.trim() ? Number(process.env.MAP_ORIGIN_LAT) : Number.NaN;
  const configuredLon = process.env.MAP_ORIGIN_LON?.trim() ? Number(process.env.MAP_ORIGIN_LON) : Number.NaN;
  if (Number.isFinite(configuredLat) && Number.isFinite(configuredLon)) {
    return {
      label: mapOriginLabel,
      ...(process.env.MAP_ORIGIN_IP ? { ip: process.env.MAP_ORIGIN_IP } : {}),
      lat: configuredLat,
      lon: configuredLon,
      lookupStatus: "mapped",
    };
  }
  if (mapOriginCache && mapOriginCache.expiresAt > Date.now()) return mapOriginCache.value;
  const fallback: MapOrigin = { label: mapOriginLabel, lat: 39, lon: -98, lookupStatus: "fallback" };
  try {
    const fields = "status,country,countryCode,regionName,city,lat,lon,query";
    const response = await fetch(`http://ip-api.com/json/?fields=${fields}`, { signal: AbortSignal.timeout(5_000) });
    const data = (await response.json()) as Record<string, unknown>;
    if (response.ok && data.status === "success") {
      const value: MapOrigin = {
        label: mapOriginLabel,
        ip: String(data.query ?? ""),
        country: String(data.country ?? ""),
        countryCode: String(data.countryCode ?? ""),
        region: String(data.regionName ?? ""),
        city: String(data.city ?? ""),
        lat: Number(data.lat),
        lon: Number(data.lon),
        lookupStatus: "mapped",
      };
      mapOriginCache = { expiresAt: Date.now() + peerGeoTtlMs, value };
      return value;
    }
  } catch {
    // A central-US fallback keeps the map usable during a geolocation outage.
  }
  mapOriginCache = { expiresAt: Date.now() + 60_000, value: fallback };
  return fallback;
}

async function refreshSwarmPeers(stats?: { connections?: number; seeders?: number }): Promise<PeerSnapshot> {
  const nowMs = Date.now();
  const peers = connectedPeers();
  const activeKeys = new Set(peers.map(peerKey));
  const [locatedPeers, origin] = await Promise.all([lookupPeers(peers), mapOrigin()]);
  for (const peer of locatedPeers) {
    peerHistory.set(peerKey(peer), markPeerActivity(peer, nowMs));
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
    if (Boolean(a.infrastructure) !== Boolean(b.infrastructure)) return a.infrastructure ? -1 : 1;
    const aRank = a.active ? 0 : a.probing ? 1 : 2;
    const bRank = b.active ? 0 : b.probing ? 1 : 2;
    if (aRank !== bRank) return aRank - bRank;
    return Date.parse(b.lastSeenAt ?? "") - Date.parse(a.lastSeenAt ?? "");
  });
  const displayedPeers = history.slice(0, maxMapPeers);

  peerSnapshot = {
    updatedAt: new Date().toISOString(),
    origin,
    peers: displayedPeers,
    activeCount: displayedPeers.filter((peer) => peer.active).length,
    probingCount: displayedPeers.filter((peer) => peer.probing).length,
    inactiveCount: displayedPeers.filter((peer) => !peer.active && !peer.probing).length,
    aria2Connections: stats?.connections ?? 0,
    aria2Seeders: stats?.seeders ?? 0,
  };
  lastPeerRefresh = Date.now();
  return peerSnapshot;
}

async function swarmPeers(stats?: { connections?: number; seeders?: number }) {
  if (Date.now() - lastPeerRefresh < peerRefreshMs) return peerSnapshot;
  if (!peerRefreshPromise) {
    peerRefreshPromise = refreshSwarmPeers(stats).finally(() => {
      peerRefreshPromise = null;
    });
  }
  return await peerRefreshPromise;
}

async function listLogs() {
  try {
    return (await readdir(join(root, "logs"))).filter((name) => name.endsWith(".log"));
  } catch {
    return [];
  }
}

export async function buildStatus(options: BuildStatusOptions = {}) {
  const includeBatchLogTail = options.includeBatchLogTail ?? true;
  const includeLogs = options.includeLogs ?? true;
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
    const destinationExists = existsSync(item.destination.path);
    const recordedStatus = itemState.status ?? "pending";
    const status = recordedStatus === "completed" && !destinationExists ? "pending" : recordedStatus;
    const hasPartialDownload = status === "pending" && existsSync(join(root, "staging", item.id));
    const shouldReadProgressLog = status === "active" || status === "organizing" || status === "failed" || hasPartialDownload;
    const progress = shouldReadProgressLog
      ? parseProgress(readTail(join(root, "logs", `${item.id}.log`)))
      : status === "completed"
        ? completedProgress(item.totalBytes)
        : pendingProgress(item.totalBytes);
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
      totalBytes: effectiveTotalBytes,
      status,
      startedAt: itemState.startedAt,
      completedAt: itemState.completedAt,
      failedAt: itemState.failedAt,
      error: itemState.error,
      progress,
      destinationExists,
    };
  });

  const totalBytes = items.reduce((sum, item) => sum + (item.totalBytes || item.progress.totalBytes), 0);
  const activeItems = items.filter((item) => item.status === "active" || item.status === "organizing");
  const activeRemainingBytes = Math.max(0, activeTotalBytes - activeBytes);
  const doneBytes = completedBytes + activeBytes;
  const rawLog = includeBatchLogTail ? readTail(join(root, "batch.log"), 80_000).replace(/\x1b\[[0-9;]*[mK]/g, "") : "";
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
    logs: includeLogs ? await listLogs() : [],
    batchLogTail: rawLog.split(/\r?\n/).slice(-80).join("\n"),
  };
}

function streamFingerprint(status: Awaited<ReturnType<typeof buildStatus>>) {
  return JSON.stringify({
    totals: status.totals,
    disk: status.disk,
    items: status.items,
    swarmUpdatedAt: status.swarm?.updatedAt,
  });
}

let streamStatusCache: { createdAt: number; value: Awaited<ReturnType<typeof buildStatus>> } | null = null;
let streamStatusPromise: Promise<Awaited<ReturnType<typeof buildStatus>>> | null = null;

async function buildStreamStatus() {
  if (streamStatusCache && Date.now() - streamStatusCache.createdAt < 750) return streamStatusCache.value;
  if (!streamStatusPromise) {
    streamStatusPromise = buildStatus({ includeBatchLogTail: false, includeLogs: false })
      .then((value) => {
        streamStatusCache = { createdAt: Date.now(), value };
        return value;
      })
      .finally(() => {
        streamStatusPromise = null;
      });
  }
  return await streamStatusPromise;
}

function formString(form: FormData, key: string, fallback = "") {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : fallback;
}

function selectedFileIndexes(form: FormData, files: Array<{ index: number; length: number }>) {
  const raw = formString(form, "selectedFiles");
  if (!raw) return { indexes: [] as number[], totalBytes: files.reduce((sum, file) => sum + file.length, 0) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Selected torrent files are invalid");
  }
  if (!Array.isArray(parsed)) throw new Error("Selected torrent files are invalid");
  const indexes = [...new Set(parsed.map(Number))].sort((left, right) => left - right);
  if (!indexes.length) throw new Error("Select at least one torrent file");
  const available = new Map(files.map((file) => [file.index, file.length]));
  if (indexes.some((index) => !Number.isInteger(index) || !available.has(index))) {
    throw new Error("Selected torrent files do not match this torrent");
  }
  return {
    indexes,
    totalBytes: indexes.reduce((sum, index) => sum + (available.get(index) ?? 0), 0),
  };
}

const riskyTorrentFilePattern = /\.(?:exe|dll|com|scr|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|reg|lnk|desktop|appimage|apk|jar|dmg|pkg|deb|rpm|sh|bash|zsh|fish|py|pl|rb)$/i;

function organizationRoutes(form: FormData, files: Array<{ index: number; path: string }>, selectedIndexes: number[]) {
  const raw = formString(form, "organizationRoutes");
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Organization routes are invalid");
  }
  if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("Organization routes are invalid");
  if (!parsed.length) return [];
  const selected = new Set(selectedIndexes.length ? selectedIndexes : files.map((file) => file.index));
  const allowedRoots = [moviesDir, tvDir].map((path) => path.replace(/\/$/, ""));
  const routes = parsed.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Organization routes are invalid");
    const record = entry as Record<string, unknown>;
    const sourcePath = String(record.sourcePath || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    const destinationPath = String(record.destinationPath || "").trim().replace(/\/$/, "");
    if (!sourcePath || sourcePath.startsWith("/") || sourcePath.split("/").some((part) => !part || part === "..")) {
      throw new Error(`Unsafe organization source: ${sourcePath || "(empty)"}`);
    }
    if (!allowedRoots.some((root) => destinationPath === root || destinationPath.startsWith(`${root}/`))) {
      throw new Error(`Organization destination must be under ${moviesDir} or ${tvDir}`);
    }
    return { sourcePath, destinationPath };
  });
  const unmatched = files.filter((file) => {
    if (!selected.has(file.index)) return false;
    return routes.filter((route) => file.path === route.sourcePath || file.path.startsWith(`${route.sourcePath}/`)).length !== 1;
  });
  if (unmatched.length) throw new Error(`Organization routes must assign exactly one destination to ${unmatched.length} selected file(s)`);
  return routes;
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

async function intakeSourceFromForm(form: FormData) {
  const sourceUrl = formString(form, "sourceUrl") || formString(form, "magnetUri") || formString(form, "torrentUrl");
  if (sourceUrl) {
    if (sourceUrl.toLowerCase().startsWith("magnet:")) return { kind: "magnet" as const, magnetUri: sourceUrl };
    return await resolveSourceUrl(sourceUrl);
  }
  return { kind: "upload" as const, ...(await torrentFromForm(form)) };
}

async function metadataForSource(
  source: Awaited<ReturnType<typeof intakeSourceFromForm>>,
  options: { metadataTimeoutSeconds?: number } = {},
) {
  if (source.kind === "magnet") {
    const magnet = magnetMetadata(source.magnetUri);
    const resolved = await resolveMagnetTorrent(source.magnetUri, magnet.hash, options.metadataTimeoutSeconds);
    return {
      metadata: { ...torrentMetadata(resolved.bytes, resolved.filename), magnetUri: source.magnetUri, hash: magnet.hash },
      filename: "",
      magnetUri: source.magnetUri,
    };
  }
  return { metadata: torrentMetadata(source.bytes, source.filename), filename: source.filename, magnetUri: "" };
}

export async function preflightTorrentSource(sourceUrl: string, options: { metadataTimeoutSeconds?: number } = {}) {
  const source = sourceUrl.toLowerCase().startsWith("magnet:")
    ? { kind: "magnet" as const, magnetUri: sourceUrl }
    : await resolveSourceUrl(sourceUrl);
  const { metadata } = await metadataForSource(source, options);
  return {
    payloadName: metadata.payloadName,
    totalBytes: metadata.totalBytes,
    fileCount: metadata.fileCount,
    sampleFiles: metadata.files.slice(0, 12).map((file) => file.path),
  };
}

export async function inspectTorrentUpload(req: Request) {
  const form = await req.formData();
  const source = await intakeSourceFromForm(form);
  const { metadata } = await metadataForSource(source);
  return Response.json(
    {
      ...metadata,
      source: {
        kind: source.kind,
        sourceUrl: "sourceUrl" in source ? source.sourceUrl : "",
        resolvedUrl: "resolvedUrl" in source ? source.resolvedUrl : "",
      },
      smartSetup: smartIntakeConfig(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export function planTorrentUpload(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      void (async () => {
        try {
          send({ type: "progress", message: "Reading torrent metadata and user instructions" });
          const form = await req.formData();
          const source = await intakeSourceFromForm(form);
          const { metadata, filename } = await metadataForSource(source);
          send({ type: "progress", message: `Prepared ${metadata.files.length} file records for planning` });
          const result = await createSmartIntakePlan({
            filename,
            payloadName: metadata.payloadName,
            files: metadata.files,
            suggested: metadata.suggested,
            additionalInstructions: formString(form, "additionalInstructions"),
            moviesDir,
            tvDir,
          }, (message) => send({ type: "progress", message }));
          send({ type: "result", ...result });
        } catch (error) {
          send({ type: "error", error: error instanceof Error ? error.message : String(error) });
        } finally {
          controller.close();
        }
      })();
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

type PreparedTorrentItem = {
  item: Item;
  torrentWrite?: { filename: string; bytes: Uint8Array };
};

async function prepareTorrentItem(form: FormData, manifestItems: Item[]): Promise<PreparedTorrentItem> {
  const source = await intakeSourceFromForm(form);
  const { metadata, filename, magnetUri } = await metadataForSource(source);
  const selection = selectedFileIndexes(form, metadata.files);
  const selectedSet = new Set(selection.indexes.length ? selection.indexes : metadata.files.map((file) => file.index));
  const riskyFiles = metadata.files.filter((file) => selectedSet.has(file.index) && riskyTorrentFilePattern.test(file.path));
  if (riskyFiles.length) {
    throw new Error(`Selected content contains ${riskyFiles.length} executable or script file(s). Torplex will not queue risky payloads.`);
  }
  const id = slugify(formString(form, "id", metadata.suggested.id));
  const title = formString(form, "title", metadata.suggested.title);
  const mediaType: "movie" | "show" =
    formString(form, "mediaType", metadata.suggested.mediaType) === "movie" ? "movie" : "show";
  const destinationPath = formString(form, "destinationPath", metadata.suggested.destinationPath);
  const strategyInput = formString(form, "organizeStrategy", metadata.suggested.organizeStrategy);
  const targetSubdir = formString(form, "targetSubdir", metadata.suggested.targetSubdir);
  const routes = organizationRoutes(form, metadata.files, selection.indexes);
  if (strategyInput === "routeDirectories" && !routes.length) throw new Error("Add at least one folder route");
  if (!id || !title || !destinationPath) throw new Error("Missing required manifest fields");
  const allowedRoots = [moviesDir, tvDir].map((path) => path.replace(/\/$/, ""));
  if (!allowedRoots.some((root) => destinationPath === root || destinationPath.startsWith(`${root}/`))) {
    throw new Error(`Destination must be under ${moviesDir} or ${tvDir}`);
  }
  if (manifestItems.some((item) => item.id === id)) throw new Error(`Manifest already has item id ${id}`);
  if (filename && manifestItems.some((item) => item.torrentFile === filename)) throw new Error(`Manifest already uses ${filename}`);
  if (magnetUri && manifestItems.some((item) => item.magnetUri === magnetUri)) throw new Error("Manifest already has this magnet link");

  const organize =
    strategyInput === "routeDirectories"
      ? { strategy: "routeDirectories" as const, routes }
      : strategyInput === "moveRoot"
      ? { strategy: "moveRoot" as const }
      : { strategy: "mergeRoot" as const, ...(targetSubdir ? { targetSubdir } : {}) };

  const item: Item = {
    id,
    ...(filename ? { torrentFile: filename } : {}),
    ...(magnetUri ? { magnetUri } : {}),
    ...("sourceUrl" in source && source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
    title,
    destination: { type: mediaType, path: destinationPath },
    organize,
    payloadName: metadata.payloadName,
    totalBytes: selection.totalBytes,
    fileCount: selection.indexes.length || metadata.fileCount,
    ...(selection.indexes.length && selection.indexes.length < metadata.fileCount ? { selectFiles: selection.indexes } : {}),
    rightsAttestedAt: new Date().toISOString(),
    postDownload: {
      verifyStreams: formBool(form, "verifyStreams"),
      scanForMalware: true,
      ensureEnglishSubtitles: formBool(form, "ensureEnglishSubtitles"),
      verifyCanonicalMetadata: formBool(form, "verifyCanonicalMetadata"),
      verifyArtwork: formBool(form, "verifyArtwork"),
      refreshPlex: formBool(form, "refreshPlex"),
    },
  };

  return {
    item,
    ...(source.kind !== "magnet" ? { torrentWrite: { filename, bytes: source.bytes } } : {}),
  };
}

function assertUniquePreparedItems(prepared: PreparedTorrentItem[]) {
  const ids = new Set<string>();
  const filenames = new Set<string>();
  const magnets = new Set<string>();
  for (const { item, torrentWrite } of prepared) {
    if (ids.has(item.id)) throw new Error(`Batch contains duplicate queue id ${item.id}`);
    ids.add(item.id);
    if (torrentWrite) {
      if (filenames.has(torrentWrite.filename)) throw new Error(`Batch contains duplicate torrent file ${torrentWrite.filename}`);
      filenames.add(torrentWrite.filename);
    }
    if (item.magnetUri) {
      if (magnets.has(item.magnetUri)) throw new Error("Batch contains the same magnet link more than once");
      magnets.add(item.magnetUri);
    }
  }
}

async function persistPreparedItems(manifest: Manifest, prepared: PreparedTorrentItem[]) {
  const torrentDir = join(root, "torrents");
  const writes = prepared.flatMap(({ torrentWrite }) => torrentWrite ? [torrentWrite] : []);
  if (writes.length) await mkdir(torrentDir, { recursive: true });
  for (const write of writes) {
    const destination = join(torrentDir, write.filename);
    if (existsSync(destination)) throw new Error(`Torrent descriptor already exists: ${write.filename}`);
  }
  const written: string[] = [];
  try {
    for (const write of writes) {
      const destination = join(torrentDir, write.filename);
      await writeFile(destination, write.bytes, { flag: "wx" });
      written.push(destination);
    }
    manifest.items.push(...prepared.map(({ item }) => item));
    await saveManifest(manifest);
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw error;
  }
}

export async function addTorrentUpload(req: Request) {
  const form = await req.formData();
  if (!formBool(form, "rightsConfirmed")) {
    throw new Error("Confirm that you have the rights to download this content");
  }
  const manifest = readJson<Manifest>(join(root, "manifest.json"), { createdAt: new Date().toISOString(), items: [] });
  const prepared = await prepareTorrentItem(form, manifest.items);
  await persistPreparedItems(manifest, [prepared]);
  return Response.json({ ok: true, item: prepared.item, restartMessage: "Queued; runner will pick it up automatically" }, { headers: { "cache-control": "no-store" } });
}

type BulkIntakeEntry = {
  clientId: string;
  sourceUrl?: string;
  fields?: Record<string, unknown>;
};

function bulkEntryForm(entry: BulkIntakeEntry, upload: FormDataEntryValue | null) {
  const form = new FormData();
  if (entry.sourceUrl) form.set("sourceUrl", entry.sourceUrl);
  if (upload instanceof File && upload.name) form.set("torrent", upload);
  for (const [key, value] of Object.entries(entry.fields || {})) {
    if (typeof value === "boolean") {
      if (value) form.set(key, "on");
    } else if (typeof value === "string" || typeof value === "number") {
      form.set(key, String(value));
    } else if (Array.isArray(value) || (value && typeof value === "object")) {
      form.set(key, JSON.stringify(value));
    }
  }
  return form;
}

export async function addTorrentBatch(req: Request) {
  const form = await req.formData();
  if (!formBool(form, "rightsConfirmed")) {
    throw new Error("Confirm that you have the rights to download every item in this batch");
  }
  const rawItems = formString(form, "items");
  let entries: BulkIntakeEntry[];
  try {
    entries = JSON.parse(rawItems) as BulkIntakeEntry[];
  } catch {
    throw new Error("Bulk intake data is invalid");
  }
  if (!Array.isArray(entries) || !entries.length || entries.length > 40) {
    throw new Error("A batch must contain between 1 and 40 items");
  }
  if (entries.some((entry) => !entry || typeof entry.clientId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.clientId))) {
    throw new Error("Bulk intake item identifiers are invalid");
  }
  const manifest = readJson<Manifest>(join(root, "manifest.json"), { createdAt: new Date().toISOString(), items: [] });
  const prepared = await Promise.all(entries.map((entry) => {
    const upload = form.get(`torrent:${entry.clientId}`);
    if (!entry.sourceUrl && !(upload instanceof File && upload.name)) throw new Error("Every batch item needs a source");
    return prepareTorrentItem(bulkEntryForm(entry, upload), manifest.items);
  }));
  assertUniquePreparedItems(prepared);
  await persistPreparedItems(manifest, prepared);
  return Response.json({
    ok: true,
    items: prepared.map(({ item }) => item),
    restartMessage: `Queued ${prepared.length} item${prepared.length === 1 ? "" : "s"}; runner will pick them up automatically`,
  }, { headers: { "cache-control": "no-store" } });
}

type StatusSubscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  lastFingerprint: string;
  lastSwarmUpdatedAt: string;
  lastHeartbeatAt: number;
};

const statusStreamEncoder = new TextEncoder();
const statusSubscribers = new Set<StatusSubscriber>();
let statusStreamTimer: ReturnType<typeof setTimeout> | undefined;
let statusStreamRunning = false;

function encodeStatusEvent(event: string, data: unknown) {
  return statusStreamEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function removeStatusSubscriber(subscriber: StatusSubscriber) {
  statusSubscribers.delete(subscriber);
  if (!statusSubscribers.size && statusStreamTimer) {
    clearTimeout(statusStreamTimer);
    statusStreamTimer = undefined;
  }
}

function enqueueStatus(subscriber: StatusSubscriber, chunk: Uint8Array) {
  try {
    subscriber.controller.enqueue(chunk);
    return true;
  } catch {
    removeStatusSubscriber(subscriber);
    return false;
  }
}

function scheduleStatusStream(delay: number) {
  if (statusStreamTimer) clearTimeout(statusStreamTimer);
  statusStreamTimer = statusSubscribers.size
    ? setTimeout(() => void pumpStatusStream(), delay)
    : undefined;
}

async function pumpStatusStream() {
  if (statusStreamRunning || !statusSubscribers.size) return;
  statusStreamRunning = true;
  let nextDelay = idleStreamIntervalMs;
  try {
    const status = await buildStreamStatus();
    const active = (status.totals.activeItems ?? 0) > 0;
    const fingerprint = streamFingerprint(status);
    const now = Date.now();
    nextDelay = active ? activeStreamIntervalMs : idleStreamIntervalMs;
    for (const subscriber of [...statusSubscribers]) {
      if (fingerprint !== subscriber.lastFingerprint) {
        subscriber.lastFingerprint = fingerprint;
        const includeSwarm = status.swarm.updatedAt !== subscriber.lastSwarmUpdatedAt;
        if (includeSwarm) subscriber.lastSwarmUpdatedAt = status.swarm.updatedAt;
        enqueueStatus(subscriber, encodeStatusEvent("status", includeSwarm ? status : { ...status, swarm: undefined }));
      } else if (now - subscriber.lastHeartbeatAt >= streamHeartbeatMs) {
        subscriber.lastHeartbeatAt = now;
        enqueueStatus(subscriber, statusStreamEncoder.encode(`: idle ${new Date(now).toISOString()}\n\n`));
      }
    }
  } catch (error) {
    const event = encodeStatusEvent("error", { message: error instanceof Error ? error.message : String(error) });
    for (const subscriber of [...statusSubscribers]) enqueueStatus(subscriber, event);
  } finally {
    statusStreamRunning = false;
    scheduleStatusStream(nextDelay);
  }
}

export function statusStream() {
  let subscriber: StatusSubscriber | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      subscriber = { controller, lastFingerprint: "", lastSwarmUpdatedAt: "", lastHeartbeatAt: 0 };
      statusSubscribers.add(subscriber);
      enqueueStatus(subscriber, statusStreamEncoder.encode("retry: 1000\n\n"));
      if (statusSubscribers.size === 1) void pumpStatusStream();
    },
    cancel() {
      if (subscriber) removeStatusSubscriber(subscriber);
    },
  });
}
