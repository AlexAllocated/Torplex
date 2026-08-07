import { existsSync } from "fs";
import { appendFile, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises";
import { basename, dirname, extname, join, relative } from "path";
import {
  createMetadataCuratorPlan,
  metadataCuratorConfig,
  type MetadataCuratorPatch,
  type MetadataCuratorRecord,
} from "./src/lib/server/metadata-curator";
import { aria2NetworkPolicyArgs } from "./src/lib/server/aria2-policy";

const root = process.env.BATCH_DIR ?? "/media/plex/.downloads/torrent-batch";
const plexUrl = (process.env.PLEX_URL ?? "http://127.0.0.1:32400").replace(/\/$/, "");
const plexPreferencesPath =
  process.env.PLEX_PREFERENCES_PATH ?? "/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml";
const plexMovieSectionId = process.env.PLEX_MOVIE_SECTION_ID ?? "1";
const plexShowSectionId = process.env.PLEX_SHOW_SECTION_ID ?? "2";
const mediaRoot = (process.env.MEDIA_ROOT ?? "/media/plex").replace(/\/$/, "");
const moviesDir = (process.env.MOVIES_DIR ?? `${mediaRoot}/Movies`).replace(/\/$/, "");
const tvDir = (process.env.TV_DIR ?? `${mediaRoot}/TV Shows`).replace(/\/$/, "");
const watchthroughsDir = (process.env.WATCHTHROUGHS_DIR ?? `${mediaRoot}/Watchthroughs`).replace(/\/$/, "");
const mediaChown = process.env.MEDIA_CHOWN ?? "";
const mediaDirMode = process.env.MEDIA_DIR_MODE ?? "775";
const mediaFileMode = process.env.MEDIA_FILE_MODE ?? "664";
const configuredConcurrency = Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS ?? "0", 10);
const maxConcurrentDownloads = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0 ? configuredConcurrency : 0;
const adaptiveConcurrency = /^(1|true|yes)$/i.test(process.env.ADAPTIVE_CONCURRENCY ?? "false");
const adaptiveMinConcurrency = Math.max(1, Number.parseInt(process.env.ADAPTIVE_MIN_CONCURRENCY ?? "1", 10) || 1);
const adaptiveMaxConcurrency = Math.max(
  adaptiveMinConcurrency,
  Number.parseInt(process.env.ADAPTIVE_MAX_CONCURRENCY ?? String(maxConcurrentDownloads || 4), 10) || 4,
);
const diskWriteBudgetBytes = Math.max(1, Number.parseFloat(process.env.DISK_WRITE_BUDGET_MIB ?? "35") || 35) * 1024 * 1024;
const adaptiveIngressThreshold = Math.min(1, Math.max(0.1, Number.parseFloat(process.env.ADAPTIVE_INGRESS_THRESHOLD ?? "0.75") || 0.75));
const adaptiveDiskBusyThreshold = Math.min(100, Math.max(1, Number.parseFloat(process.env.ADAPTIVE_DISK_BUSY_PERCENT ?? "80") || 80));
const adaptiveSettleMs = Math.max(10, Number.parseInt(process.env.ADAPTIVE_SETTLE_SECONDS ?? "30", 10) || 30) * 1000;
const adaptiveScaleDownBusyThreshold = Math.min(
  100,
  Math.max(adaptiveDiskBusyThreshold, Number.parseFloat(process.env.ADAPTIVE_SCALE_DOWN_DISK_BUSY_PERCENT ?? "95") || 95),
);
const adaptiveScaleDownWriteRatio = Math.max(0.5, Number.parseFloat(process.env.ADAPTIVE_SCALE_DOWN_WRITE_RATIO ?? "1") || 1);
const adaptiveScaleDownMs = Math.max(5, Number.parseInt(process.env.ADAPTIVE_SCALE_DOWN_SECONDS ?? "20", 10) || 20) * 1000;
const adaptiveCooldownMs = Math.max(10, Number.parseInt(process.env.ADAPTIVE_COOLDOWN_SECONDS ?? "45", 10) || 45) * 1000;
const checkIntegrity = /^(1|true|yes)$/i.test(process.env.ARIA2_CHECK_INTEGRITY ?? "");
const videoExtensions = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm"]);
const subtitleExtensions = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub"]);
const ancillaryVideoPattern = /(?:^|[. _-])(?:sample|trailer|proof)(?:[. _-]|$)/i;
const riskyAttachmentPattern = /\.(?:exe|dll|com|scr|bat|cmd|ps1|vbs|js|wsf|hta|msi|reg|lnk|desktop|appimage|apk|jar|dmg|pkg|deb|rpm|sh|py|pl|rb)$/i;
const openSubtitlesApiKey = (process.env.OPENSUBTITLES_API_KEY ?? "").trim();
const openSubtitlesUserAgent = (process.env.OPENSUBTITLES_USER_AGENT ?? "Torplex v1").trim() || "Torplex v1";
let openSubtitlesToken = (process.env.OPENSUBTITLES_TOKEN ?? "").trim();
let openSubtitlesBaseUrl = "https://api.opensubtitles.com/api/v1";

type ManifestItem = {
  id: string;
  title: string;
  torrentFile?: string;
  magnetUri?: string;
  payloadName: string;
  totalBytes: number;
  fileCount?: number;
  selectFiles?: number[];
  selectedPaths?: string[];
  rightsAttestedAt?: string;
  replacement?: {
    removeSuperseded: boolean;
  };
  postDownload?: {
    verifyStreams: boolean;
    scanForMalware: boolean;
    ensureEnglishSubtitles: boolean;
    verifyCanonicalMetadata: boolean;
    verifyArtwork: boolean;
    validateMetadataWithAi?: boolean;
    refreshPlex: boolean;
  };
  destination: { type: "movie" | "show"; path: string };
  organize:
    | { strategy: "moveRoot"; seasonRenames?: Record<string, string>; fileRenames?: Record<string, string> }
    | { strategy: "mergeRoot"; targetSubdir?: string }
    | { strategy: "routeDirectories"; routes: Array<{ sourcePath: string; destinationPath: string }> }
    | { strategy: "singleFile"; source: string; finalName: string }
    | { strategy: "singleEpisode"; source: string; finalName: string };
};

type Manifest = {
  createdAt: string;
  items: ManifestItem[];
};

type State = {
  startedAt: string;
  finishedAt?: string;
  currentItemId?: string | null;
  items: Record<string, Record<string, string>>;
};

const statePath = join(root, "state.json");
const batchLogPath = join(root, "batch.log");
let stateQueue: Promise<void> = Promise.resolve();
let logQueue: Promise<void> = Promise.resolve();

async function loadManifest(): Promise<Manifest> {
  const manifestPath = join(root, "manifest.json");
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch {
    const manifest = { createdAt: now(), items: [] };
    await ensureDir(root);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return manifest;
  }
}

async function saveManifest(manifest: Manifest) {
  const manifestPath = join(root, "manifest.json");
  const tmp = `${manifestPath}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, manifestPath);
}

async function updateManifestItem(id: string, values: Partial<ManifestItem>) {
  const manifest = await loadManifest();
  const item = manifest.items.find((entry) => entry.id === id);
  if (!item) return;
  Object.assign(item, values);
  await saveManifest(manifest);
}

function now() {
  return new Date().toISOString();
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as State;
  } catch {
    return { startedAt: now(), currentItemId: null, items: {} };
  }
}

async function saveState(state: State) {
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, statePath);
}

async function setItemState(id: string, values: Record<string, string | null>) {
  await enqueueState(async () => {
    const manifest = await loadManifest();
    const state = await loadState();
    state.items[id] = { ...(state.items[id] ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete state.items[id][key];
      else state.items[id][key] = value;
    }
    if (values.status === "active" || values.status === "organizing") {
      delete state.finishedAt;
    }
    const activeId = manifest.items.find((item) => {
      const status = state.items[item.id]?.status;
      return status === "active" || status === "organizing";
    })?.id;
    state.currentItemId = activeId ?? null;
    await saveState(state);
  });
}

async function appendBatch(line: string) {
  await enqueueLog(async () => {
    await appendFile(batchLogPath, `${line}\n`);
  });
}

async function enqueueState(write: () => Promise<void>) {
  const next = stateQueue.then(write, write);
  stateQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function enqueueLog(write: () => Promise<void>) {
  const next = logQueue.then(write, write);
  logQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
}

async function pathExists(path: string) {
  return existsSync(path);
}

async function stagingHasPayload(staging: string) {
  if (!(await pathExists(staging))) return false;
  const entries = await readdir(staging);
  return entries.some((entry) => !entry.endsWith(".aria2"));
}

async function movePath(source: string, destination: string) {
  await ensureDir(dirname(destination));
  await rename(source, destination);
}

type ReplacementSwap = {
  targetPath: string;
  backupPath: string;
  hadExisting: boolean;
  aliases: Array<{ aliasPath: string; oldRelativePath: string }>;
};

function replacementEnabled(item: ManifestItem) {
  return item.replacement?.removeSuperseded === true || item.id.includes("-directplay-");
}

function replacementTarget(item: ManifestItem) {
  if (!replacementEnabled(item)) return null;
  let target = item.destination.path.replace(/\/$/, "");
  if (item.destination.type === "show" && item.organize.strategy === "mergeRoot" && item.organize.targetSubdir) {
    target = join(target, item.organize.targetSubdir);
  }
  const rootDir = item.destination.type === "movie" ? moviesDir : tvDir;
  if (target === rootDir || !target.startsWith(`${rootDir}/`)) {
    throw new Error(`Unsafe replacement target for ${item.title}: ${target}`);
  }
  return target;
}

async function collectVideoPaths(path: string) {
  const paths: string[] = [];
  if (!(await pathExists(path))) return paths;
  async function visit(current: string) {
    const currentStat = await stat(current);
    if (currentStat.isFile()) {
      if (videoExtensions.has(extname(current).toLowerCase())) paths.push(current);
      return;
    }
    if (!currentStat.isDirectory()) return;
    for (const entry of await readdir(current)) await visit(join(current, entry));
  }
  await visit(path);
  return paths;
}

async function findWatchthroughAliases(targetPath: string) {
  if (!(await pathExists(targetPath)) || !(await pathExists(watchthroughsDir))) return [];
  const inodeToRelative = new Map<string, string>();
  for (const oldPath of await collectVideoPaths(targetPath)) {
    const oldStat = await stat(oldPath);
    if (oldStat.nlink > 1) inodeToRelative.set(`${oldStat.dev}:${oldStat.ino}`, relative(targetPath, oldPath));
  }
  if (!inodeToRelative.size) return [];
  const aliases: Array<{ aliasPath: string; oldRelativePath: string }> = [];
  async function visit(current: string) {
    const currentStat = await stat(current);
    if (currentStat.isFile()) {
      const oldRelativePath = inodeToRelative.get(`${currentStat.dev}:${currentStat.ino}`);
      if (oldRelativePath) aliases.push({ aliasPath: current, oldRelativePath });
      return;
    }
    if (!currentStat.isDirectory()) return;
    for (const entry of await readdir(current)) await visit(join(current, entry));
  }
  await visit(watchthroughsDir);
  return aliases;
}

function episodeKey(path: string) {
  return basename(path).match(/S(\d{1,2})E(\d{1,3})/i)?.slice(1).map(Number).join(":") ?? "";
}

async function replaceHardLink(aliasPath: string, sourcePath: string) {
  const temporaryPath = `${aliasPath}.torplex-new`;
  await rm(temporaryPath, { force: true });
  await link(sourcePath, temporaryPath);
  await rename(temporaryPath, aliasPath);
}

async function relinkWatchthroughAliases(item: ManifestItem, swap: ReplacementSwap | null, destinations: string[]) {
  if (!swap?.aliases.length) return;
  const newVideos = (await Promise.all(destinations.map(collectVideoPaths))).flat();
  const byEpisode = new Map(newVideos.map((path) => [episodeKey(path), path]).filter(([key]) => key));
  for (const alias of swap.aliases) {
    const source = item.destination.type === "movie" && newVideos.length === 1
      ? newVideos[0]
      : byEpisode.get(episodeKey(alias.oldRelativePath));
    if (!source) throw new Error(`Could not map watchthrough alias ${basename(alias.aliasPath)} to the replacement media`);
    await replaceHardLink(alias.aliasPath, source);
  }
  await setItemState(item.id, { replacementAliases: String(swap.aliases.length) });
  await appendBatch(`Repointed ${swap.aliases.length} watchthrough alias(es) for ${item.title}`);
}

async function restoreWatchthroughAliases(swap: ReplacementSwap | null) {
  if (!swap?.aliases.length || !(await pathExists(swap.backupPath))) return;
  for (const alias of swap.aliases) {
    const oldSource = join(swap.backupPath, alias.oldRelativePath);
    if (await pathExists(oldSource)) await replaceHardLink(alias.aliasPath, oldSource);
  }
}

async function beginReplacementSwap(item: ManifestItem): Promise<ReplacementSwap | null> {
  const targetPath = replacementTarget(item);
  if (!targetPath) return null;
  const backupPath = join(root, "replacement-backups", item.id, "previous");
  if (await pathExists(backupPath)) {
    throw new Error(`Replacement backup already exists for ${item.title}; refusing to overwrite it`);
  }
  const hadExisting = await pathExists(targetPath);
  const aliases = hadExisting ? await findWatchthroughAliases(targetPath) : [];
  if (hadExisting) {
    await ensureDir(dirname(backupPath));
    await movePath(targetPath, backupPath);
    await setItemState(item.id, { replacementStatus: "old copy secured", replacementTarget: targetPath, replacementBackup: backupPath });
    await appendBatch(`Secured old copy of ${item.title} before replacement`);
  }
  return { targetPath, backupPath, hadExisting, aliases };
}

async function restoreReplacementSwap(item: ManifestItem, swap: ReplacementSwap | null) {
  if (!swap?.hadExisting || !(await pathExists(swap.backupPath))) return;
  await restoreWatchthroughAliases(swap);
  await rm(swap.targetPath, { recursive: true, force: true });
  await movePath(swap.backupPath, swap.targetPath);
  await rm(dirname(swap.backupPath), { recursive: true, force: true });
  await setItemState(item.id, { replacementStatus: "old copy restored" });
  await appendBatch(`Restored old copy of ${item.title} after replacement failure`);
  try {
    await scanPlex(item.destination.type);
  } catch {
    // The next regular Plex scan will rediscover the restored copy.
  }
}

async function commitReplacementSwap(item: ManifestItem, swap: ReplacementSwap | null) {
  if (!swap) return;
  if (swap.hadExisting) await rm(dirname(swap.backupPath), { recursive: true, force: true });
  await setItemState(item.id, {
    replacementStatus: swap.hadExisting ? "old copy removed" : "new media installed",
    replacementCompletedAt: now(),
  });
  if (swap.hadExisting) await appendBatch(`Removed superseded copy of ${item.title} after validation`);
}

async function collectFileStats(path: string) {
  let totalBytes = 0;
  let fileCount = 0;
  let videoCount = 0;
  async function visit(current: string) {
    const currentStat = await stat(current);
    if (currentStat.isFile()) {
      fileCount += 1;
      totalBytes += currentStat.size;
      if (videoExtensions.has(extname(current).toLowerCase())) videoCount += 1;
      return;
    }
    if (!currentStat.isDirectory()) return;
    for (const entry of await readdir(current)) {
      if (entry.endsWith(".aria2")) continue;
      await visit(join(current, entry));
    }
  }

  if (await pathExists(path)) await visit(path);
  return { totalBytes, fileCount, videoCount };
}

async function collectFiles(path: string, filter: (file: string) => boolean) {
  const files: string[] = [];
  async function visit(current: string) {
    const details = await stat(current);
    if (details.isFile()) {
      if (filter(current)) files.push(current);
      return;
    }
    if (!details.isDirectory()) return;
    for (const entry of await readdir(current)) {
      if (!entry.endsWith(".aria2")) await visit(join(current, entry));
    }
  }
  if (await pathExists(path)) await visit(path);
  return files;
}

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  tags?: { language?: string; title?: string; filename?: string; mimetype?: string };
};

async function captureCommand(args: string[]) {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout ? new Response(proc.stdout).text() : Promise.resolve("");
  const stderr = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");
  const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);
  return { exitCode, stdout: output, stderr: error };
}

async function probeMedia(path: string) {
  const result = await captureCommand([
    "ffprobe", "-v", "error", "-show_entries",
    "format=duration:stream=index,codec_type,codec_name:stream_tags=language,title,filename,mimetype",
    "-of", "json", path,
  ]);
  if (result.exitCode !== 0) throw new Error(`ffprobe could not read ${basename(path)}`);
  const payload = JSON.parse(result.stdout) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const streams = payload.streams ?? [];
  if (!streams.some((stream) => stream.codec_type === "video")) throw new Error(`${basename(path)} has no video stream`);
  const duration = Number(payload.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${basename(path)} has no valid duration`);
  const riskyAttachment = streams.find((stream) => {
    if (stream.codec_type !== "attachment") return false;
    return riskyAttachmentPattern.test(stream.tags?.filename ?? "") || /(?:executable|script|java-archive)/i.test(stream.tags?.mimetype ?? "");
  });
  if (riskyAttachment) throw new Error(`${basename(path)} contains a blocked executable or script attachment`);
  return streams;
}

async function selectedVideoFiles(item: ManifestItem, staging: string) {
  const isVideo = (file: string) => videoExtensions.has(extname(file).toLowerCase());
  if (item.selectedPaths?.length) {
    const rootSource = await resolveSourceRoot(item);
    const requested = item.selectedPaths.filter(isVideo);
    const rootDetails = await stat(rootSource);
    if (rootDetails.isFile()) {
      const selectedName = requested.length === 1 ? basename(safeRelativePath(requested[0])) : "";
      if (selectedName !== basename(rootSource)) {
        throw new Error(`${requested.length} selected video file(s) are missing for ${item.title}`);
      }
      return [rootSource];
    }
    const videos: string[] = [];
    for (const relativePath of requested) {
      const file = join(rootSource, safeRelativePath(relativePath));
      if (await pathExists(file)) videos.push(file);
    }
    if (videos.length !== requested.length) {
      throw new Error(`${requested.length - videos.length} selected video file(s) are missing for ${item.title}`);
    }
    return videos;
  }
  if (item.organize.strategy === "routeDirectories") {
    const rootSource = await resolveSourceRoot(item);
    const routed = await Promise.all(item.organize.routes.map((route) =>
      collectFiles(join(rootSource, safeRelativePath(route.sourcePath)), isVideo)
    ));
    return [...new Set(routed.flat())];
  }
  const videos = await collectFiles(staging, isVideo);
  if (item.selectFiles?.length && !item.selectedPaths?.length) {
    const primaryVideos = videos.filter((file) => !ancillaryVideoPattern.test(basename(file)));
    if (primaryVideos.length) return primaryVideos;
  }
  return videos;
}

async function pruneUnselectedDownloadArtifacts(item: ManifestItem, logPath: string) {
  if (!item.selectFiles?.length || !item.selectedPaths?.length) return;
  const rootSource = await resolveSourceRoot(item);
  const rootDetails = await stat(rootSource);
  if (!rootDetails.isDirectory()) return;

  const selected = new Set(item.selectedPaths.map((path) => safeRelativePath(path)));
  const downloaded = await collectFiles(rootSource, () => true);
  let removedFiles = 0;
  let removedBytes = 0;
  for (const file of downloaded) {
    const relativePath = relative(rootSource, file).replaceAll("\\", "/");
    if (selected.has(relativePath)) continue;
    const details = await stat(file);
    await rm(file, { force: true });
    removedFiles += 1;
    removedBytes += details.size;
  }

  const summary = removedFiles
    ? `Removed ${removedFiles} unselected download artifact(s) (${formatBytes(removedBytes)}).`
    : "No unselected download artifacts were present.";
  await appendFile(logPath, `\n--- Selection cleanup ---\n${summary}\n`);
  await setItemState(item.id, { selectionCleanup: "passed", selectionCleanupSummary: summary });
  await appendBatch(`Selection cleanup for ${item.title}: ${summary}`);
}

async function verifyMediaStreams(item: ManifestItem, path: string, logPath: string) {
  await setItemState(item.id, { mediaVerification: "running" });
  const videos = await selectedVideoFiles(item, path);
  if (!videos.length) throw new Error(`No video files were downloaded for ${item.title}`);
  for (const video of videos) await probeMedia(video);
  await appendFile(logPath, `\n--- Media verification ---\nVerified ${videos.length} readable video container(s) with ffprobe.\n`);
  await setItemState(item.id, { mediaVerification: "passed" });
  await appendBatch(`Verified ${videos.length} media file(s) for ${item.title}`);
}

function hasEnglishLanguage(stream: ProbeStream) {
  const language = (stream.tags?.language ?? "").toLowerCase();
  return stream.codec_type === "subtitle" && (language === "en" || language === "eng" || language.startsWith("en-"));
}

async function normalizeMatchingEnglishSidecar(video: string) {
  const directory = dirname(video);
  const stem = basename(video, extname(video));
  const entries = await readdir(directory);
  const explicitlyEnglish = entries.some((entry) => {
    const extension = extname(entry).toLowerCase();
    if (!subtitleExtensions.has(extension)) return false;
    const name = basename(entry, extension).toLowerCase();
    return name === `${stem.toLowerCase()}.en` || name === `${stem.toLowerCase()}.eng` || name.startsWith(`${stem.toLowerCase()}.en.`);
  });
  if (explicitlyEnglish) return true;
  const plain = entries.find((entry) => {
    const extension = extname(entry).toLowerCase();
    return subtitleExtensions.has(extension) && basename(entry, extension) === stem;
  });
  if (!plain) return false;
  const extension = extname(plain).toLowerCase();
  await rename(join(directory, plain), join(directory, `${stem}.en${extension}`));
  return true;
}

async function openSubtitlesHeaders(authenticated = false) {
  const headers: Record<string, string> = {
    "Api-Key": openSubtitlesApiKey,
    "User-Agent": openSubtitlesUserAgent,
    "Content-Type": "application/json",
  };
  if (authenticated && !openSubtitlesToken) {
    const username = (process.env.OPENSUBTITLES_USERNAME ?? "").trim();
    const password = process.env.OPENSUBTITLES_PASSWORD ?? "";
    if (username && password) {
      const response = await fetch(`${openSubtitlesBaseUrl}/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`OpenSubtitles login failed with HTTP ${response.status}`);
      const payload = await response.json() as { token?: string; base_url?: string };
      openSubtitlesToken = payload.token ?? "";
      if (payload.base_url) openSubtitlesBaseUrl = `https://${payload.base_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}/api/v1`;
    }
  }
  if (openSubtitlesToken) headers.Authorization = `Bearer ${openSubtitlesToken}`;
  return headers;
}

async function openSubtitlesHash(path: string) {
  const handle = await open(path, "r");
  try {
    const details = await handle.stat();
    if (details.size < 128 * 1024) throw new Error("Video is too small for an OpenSubtitles hash");
    const chunkSize = 64 * 1024;
    const first = Buffer.alloc(chunkSize);
    const last = Buffer.alloc(chunkSize);
    await handle.read(first, 0, chunkSize, 0);
    await handle.read(last, 0, chunkSize, details.size - chunkSize);
    let hash = BigInt(details.size);
    for (const chunk of [first, last]) {
      for (let offset = 0; offset < chunk.length; offset += 8) hash = BigInt.asUintN(64, hash + chunk.readBigUInt64LE(offset));
    }
    return { hash: hash.toString(16).padStart(16, "0"), size: details.size };
  } finally {
    await handle.close();
  }
}

async function fetchExactEnglishSubtitle(video: string) {
  if (!openSubtitlesApiKey) return false;
  const identity = await openSubtitlesHash(video);
  const headers = await openSubtitlesHeaders(false);
  const query = new URLSearchParams({
    languages: "en",
    moviehash: identity.hash,
    moviebytesize: String(identity.size),
    order_by: "download_count",
    order_direction: "desc",
  });
  const search = await fetch(`${openSubtitlesBaseUrl}/subtitles?${query}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!search.ok) throw new Error(`OpenSubtitles search failed with HTTP ${search.status}`);
  const payload = await search.json() as {
    data?: Array<{ attributes?: { language?: string; moviehash_match?: boolean; files?: Array<{ file_id?: number }> } }>;
  };
  const match = payload.data?.find((entry) => {
    const attributes = entry.attributes;
    return attributes?.language === "en" && attributes.moviehash_match === true && Number.isInteger(attributes.files?.[0]?.file_id);
  });
  const fileId = match?.attributes?.files?.[0]?.file_id;
  if (!fileId) return false;
  const downloadHeaders = await openSubtitlesHeaders(true);
  const request = await fetch(`${openSubtitlesBaseUrl}/download`, {
    method: "POST",
    headers: downloadHeaders,
    body: JSON.stringify({ file_id: fileId, sub_format: "srt" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!request.ok) throw new Error(`OpenSubtitles download request failed with HTTP ${request.status}`);
  const download = await request.json() as { link?: string };
  if (!download.link) throw new Error("OpenSubtitles returned no download link");
  const downloadUrl = new URL(download.link);
  if (downloadUrl.protocol !== "https:") throw new Error("OpenSubtitles returned an insecure download link");
  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Subtitle download failed with HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Subtitle response had an invalid size");
  const text = new TextDecoder().decode(bytes);
  if (!/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}/.test(text)) {
    throw new Error("Subtitle response was not a valid timed caption file");
  }
  const destination = join(dirname(video), `${basename(video, extname(video))}.en.srt`);
  const temporary = `${destination}.torplex-part`;
  await writeFile(temporary, bytes);
  const scan = await captureCommand(["clamdscan", "--fdpass", "--infected", "--no-summary", temporary]);
  if (scan.exitCode !== 0) {
    await rm(temporary, { force: true });
    throw new Error(`Downloaded subtitle failed its malware scan (exit ${scan.exitCode})`);
  }
  await rename(temporary, destination);
  return true;
}

async function ensureEnglishSubtitles(item: ManifestItem, destinations: string[], logPath: string) {
  await setItemState(item.id, { subtitleStatus: "checking" });
  const videos = (
    await Promise.all(
      destinations.map((path) => collectFiles(path, (file) => videoExtensions.has(extname(file).toLowerCase()))),
    )
  ).flat();
  let normalized = 0;
  let fetched = 0;
  let missing = 0;
  const warnings: string[] = [];
  for (const video of videos) {
    try {
      const streams = await probeMedia(video);
      if (streams.some(hasEnglishLanguage)) continue;
      if (await normalizeMatchingEnglishSidecar(video)) {
        normalized += 1;
        continue;
      }
      if (await fetchExactEnglishSubtitle(video)) {
        fetched += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      } else {
        missing += 1;
      }
    } catch (error) {
      missing += 1;
      warnings.push(`${basename(video)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const providerNote = openSubtitlesApiKey ? "" : " OpenSubtitles is not configured, so missing captions were not fetched.";
  await appendFile(logPath, `\n--- English subtitles ---\nNormalized ${normalized}; fetched ${fetched}; still missing ${missing}.${providerNote}\n${warnings.join("\n")}\n`);
  await setItemState(item.id, {
    subtitleStatus: missing > 0 ? (openSubtitlesApiKey ? "incomplete" : "provider-not-configured") : "ready",
    subtitleSummary: `normalized=${normalized}, fetched=${fetched}, missing=${missing}`,
  });
  await appendBatch(`Subtitle check for ${item.title}: normalized ${normalized}, fetched ${fetched}, missing ${missing}`);
}

const transferUnitBytes: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

async function tailText(path: string, maxBytes = 128 * 1024) {
  try {
    const handle = await open(path, "r");
    try {
      const details = await handle.stat();
      const length = Math.min(details.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, details.size - length));
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function aggregateIngressBytesPerSecond(itemIds: string[]) {
  let total = 0;
  for (const id of itemIds) {
    const lines = (await tailText(join(root, "logs", `${id}.log`))).split(/\r?\n/).reverse();
    const progress = lines.find((line) => /\bDL:[0-9.]+(?:B|KiB|MiB|GiB|TiB)\b/.test(line));
    const match = progress?.match(/\bDL:([0-9.]+)(B|KiB|MiB|GiB|TiB)\b/);
    if (match) total += Number(match[1]) * transferUnitBytes[match[2]];
  }
  return total;
}

type DiskActivity = { writeBytesPerSecond: number; busyPercent: number };

function createDiskActivitySampler(path: string) {
  let blockId = "";
  let previous: { at: number; sectorsWritten: number; ioMilliseconds: number } | null = null;
  let smoothed: DiskActivity = { writeBytesPerSecond: 0, busyPercent: 0 };
  return async (): Promise<DiskActivity> => {
    try {
      if (!blockId) {
        const findMount = Bun.spawnSync(["findmnt", "-n", "-o", "MAJ:MIN", "-T", path]);
        if (findMount.exitCode !== 0) return smoothed;
        blockId = findMount.stdout.toString().trim();
      }
      const fields = (await readFile(`/sys/dev/block/${blockId}/stat`, "utf8")).trim().split(/\s+/).map(Number);
      if (fields.length < 11 || fields.some((value) => !Number.isFinite(value))) return smoothed;
      const current = { at: Date.now(), sectorsWritten: fields[6], ioMilliseconds: fields[9] };
      if (previous) {
        const elapsedMs = Math.max(1, current.at - previous.at);
        const observed = {
          writeBytesPerSecond: Math.max(0, current.sectorsWritten - previous.sectorsWritten) * 512 * 1000 / elapsedMs,
          busyPercent: Math.min(100, Math.max(0, current.ioMilliseconds - previous.ioMilliseconds) * 100 / elapsedMs),
        };
        const weight = 0.25;
        smoothed = {
          writeBytesPerSecond: smoothed.writeBytesPerSecond * (1 - weight) + observed.writeBytesPerSecond * weight,
          busyPercent: smoothed.busyPercent * (1 - weight) + observed.busyPercent * weight,
        };
      }
      previous = current;
    } catch {
      blockId = "";
    }
    return smoothed;
  };
}

function formatRate(bytesPerSecond: number) {
  if (bytesPerSecond >= 1024 ** 2) return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MiB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KiB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

async function runCommand(args: string[], logPath: string) {
  await writeFile(logPath, "");
  const logFile = Bun.file(logPath);
  const writer = logFile.writer();
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
  writer.end();
  return proc.exitCode ?? 1;
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

function stopAria2ForItem(itemId: string) {
  const pids = [...aria2ProcessItems().entries()]
    .filter(([, processItemId]) => processItemId === itemId)
    .map(([pid]) => pid);
  for (const pid of pids) Bun.spawnSync(["kill", "-TERM", pid]);
  if (pids.length) {
    Bun.spawnSync(["sleep", "0.4"]);
    for (const pid of pids) {
      if (Bun.spawnSync(["kill", "-0", pid]).exitCode === 0) Bun.spawnSync(["kill", "-KILL", pid]);
    }
  }
  return pids;
}

async function scanForMalware(item: ManifestItem, staging: string, logPath: string) {
  await setItemState(item.id, { securityScan: "running" });
  await appendBatch(`Scanning ${item.title} for malware`);
  const proc = await captureCommand(["clamdscan", "--fdpass", "--multiscan", "--infected", "--no-summary", staging]);
  const output = `${proc.stdout}${proc.stderr}`.trim();
  if (output) await appendFile(logPath, `\n--- ClamAV malware scan ---\n${output}\n`);
  if (proc.exitCode === 1) {
    await setItemState(item.id, { securityScan: "infected" });
    throw new Error("ClamAV detected malware; downloaded files remain quarantined in staging");
  }
  if (proc.exitCode !== 0) {
    await setItemState(item.id, { securityScan: "error" });
    throw new Error(`ClamAV scan failed with exit code ${proc.exitCode}; files were not organized`);
  }
  await setItemState(item.id, { securityScan: "clean" });
  await appendBatch(`Malware scan clean for ${item.title}`);
}

function cleanPathSegment(value: string) {
  return String(value || "").replace(/\0/g, "").trim();
}

function safeRelativePath(value: string) {
  const cleaned = cleanPathSegment(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!cleaned || cleaned.startsWith("/") || cleaned.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`Unsafe source path: ${value}`);
  }
  return cleaned;
}

function sourceRoot(item: ManifestItem) {
  return join(root, "staging", item.id, cleanPathSegment(item.payloadName));
}

async function resolveSourceRoot(item: ManifestItem) {
  const staging = join(root, "staging", item.id);
  const expected = sourceRoot(item);
  if (await pathExists(expected)) return expected;

  const entries = await readdir(staging, { withFileTypes: true });
  const downloadedRoots = entries.filter((entry) => !entry.name.endsWith(".aria2"));
  const directories = downloadedRoots.filter((entry) => entry.isDirectory());
  if (directories.length === 1) return join(staging, directories[0].name);

  throw new Error(`Downloaded root not found: ${expected}`);
}

async function organize(item: ManifestItem) {
  const staging = join(root, "staging", item.id);
  const dest = item.destination.path;
  const organizedDestinations = new Set<string>();

  if (item.organize.strategy === "moveRoot") {
    if (await pathExists(dest)) throw new Error(`Destination already exists: ${dest}`);
    const source = sourceRoot(item);
    if (await pathExists(source)) {
      const sourceStat = await stat(source);
      if (sourceStat.isFile()) {
        await ensureDir(dest);
        await movePath(source, join(dest, basename(source)));
      } else {
        await movePath(source, dest);
      }
    } else {
      const entries = (await readdir(staging)).filter((entry) => !entry.endsWith(".aria2"));
      if (!entries.length) throw new Error(`No downloaded files found in ${staging}`);
      await ensureDir(dest);
      for (const entry of entries) {
        await movePath(join(staging, entry), join(dest, entry));
      }
    }
    for (const [from, to] of Object.entries(item.organize.seasonRenames ?? {})) {
      const source = join(dest, from);
      const target = join(dest, to);
      if ((await pathExists(source)) && !(await pathExists(target))) await rename(source, target);
    }
    for (const [from, to] of Object.entries(item.organize.fileRenames ?? {})) {
      const source = join(dest, from);
      const target = join(dest, to);
      if ((await pathExists(source)) && !(await pathExists(target))) {
        await ensureDir(dirname(target));
        await rename(source, target);
      }
    }
    organizedDestinations.add(targetDir);
  } else if (item.organize.strategy === "mergeRoot") {
    await ensureDir(dest);
    const targetDir = item.organize.targetSubdir ? join(dest, item.organize.targetSubdir) : dest;
    await ensureDir(targetDir);
    const source = await resolveSourceRoot(item);
    const entries = (await readdir(source)).filter((entry) => !entry.endsWith(".aria2"));
    if (!entries.length) throw new Error(`No downloaded files found in ${source}`);
    for (const entry of entries) {
      const target = join(targetDir, entry);
      if (await pathExists(target)) throw new Error(`Destination already exists: ${target}`);
      await movePath(join(source, entry), target);
    }
    organizedDestinations.add(dest);
  } else if (item.organize.strategy === "routeDirectories") {
    const rootSource = await resolveSourceRoot(item);
    for (const route of item.organize.routes) {
      const source = join(rootSource, safeRelativePath(route.sourcePath));
      const target = route.destinationPath;
      if (!(await pathExists(source))) throw new Error(`Routed source not found: ${route.sourcePath}`);
      await ensureDir(target);
      const sourceStat = await stat(source);
      if (sourceStat.isFile()) {
        const destination = join(target, basename(source));
        if (await pathExists(destination)) throw new Error(`Destination already exists: ${destination}`);
        await movePath(source, destination);
      } else {
        const entries = (await readdir(source)).filter((entry) => !entry.endsWith(".aria2"));
        if (!entries.length) throw new Error(`Routed source is empty: ${route.sourcePath}`);
        for (const entry of entries) {
          const destination = join(target, entry);
          if (await pathExists(destination)) throw new Error(`Destination already exists: ${destination}`);
          await movePath(join(source, entry), destination);
        }
      }
      organizedDestinations.add(target);
    }
  } else if (item.organize.strategy === "singleFile") {
    if (await pathExists(dest)) throw new Error(`Destination already exists: ${dest}`);
    await ensureDir(dest);
    await movePath(join(staging, item.organize.source), join(dest, item.organize.finalName));
    organizedDestinations.add(dest);
  } else {
    await ensureDir(dest);
    const target = join(dest, item.organize.finalName);
    if (await pathExists(target)) throw new Error(`Destination already exists: ${target}`);
    await movePath(join(sourceRoot(item), item.organize.source), target);
    organizedDestinations.add(dest);
  }

  await rm(staging, { recursive: true, force: true });
  let videoCount = 0;
  for (const destination of organizedDestinations) {
    const stats = await collectFileStats(destination);
    videoCount += stats.videoCount;
    if (mediaChown) {
      const chown = Bun.spawnSync(["sudo", "chown", "-R", mediaChown, destination]);
      if (chown.exitCode !== 0) throw new Error(`chown failed for ${destination}`);
    }
    if (mediaDirMode) Bun.spawnSync(["find", destination, "-type", "d", "-exec", "chmod", mediaDirMode, "{}", "+"]);
    if (mediaFileMode) Bun.spawnSync(["find", destination, "-type", "f", "-exec", "chmod", mediaFileMode, "{}", "+"]);
  }
  if (videoCount === 0) throw new Error(`Organized destinations have no video files for ${item.title}`);
  return [...organizedDestinations];
}

function plexToken() {
  if (process.env.PLEX_TOKEN) return process.env.PLEX_TOKEN;
  const proc = Bun.spawnSync(["sudo", "sed", "-n", 's/.*PlexOnlineToken="\\([^"]*\\)".*/\\1/p', plexPreferencesPath]);
  return proc.stdout.toString().trim();
}

async function scanPlex(section: "movie" | "show") {
  const token = plexToken();
  const key = section === "movie" ? plexMovieSectionId : plexShowSectionId;
  if (!key) return;
  if (!token) throw new Error("Could not read Plex token");
  const url = `${plexUrl}/library/sections/${key}/refresh?X-Plex-Token=${encodeURIComponent(token)}`;
  const proc = Bun.spawnSync(["curl", "-fsS", url]);
  if (proc.exitCode !== 0) throw new Error(`Plex scan failed for section ${key}`);
}

type PlexMetadata = {
  ratingKey?: string;
  type?: string;
  title?: string;
  parentTitle?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  summary?: string;
  year?: number;
  originallyAvailableAt?: string;
  guid?: string;
  Guid?: Array<{ id?: string }>;
  thumb?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  Field?: Array<{ name?: string; locked?: boolean | number | string }>;
  Media?: Array<{ Part?: Array<{ file?: string }> }>;
};

async function verifyPlexResult(item: ManifestItem, destinations: string[]) {
  const token = plexToken();
  if (!token) throw new Error("Could not read Plex token");
  const key = item.destination.type === "movie" ? plexMovieSectionId : plexShowSectionId;
  const type = item.destination.type === "movie" ? "1" : "4";
  const normalized = destinations.map((path) => path.replace(/\/$/, ""));
  let matches: PlexMetadata[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
    const url = `${plexUrl}/library/sections/${key}/all?type=${type}&X-Plex-Token=${encodeURIComponent(token)}`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Plex metadata query failed with HTTP ${response.status}`);
    const payload = await response.json() as { MediaContainer?: { Metadata?: PlexMetadata[] } };
    matches = (payload.MediaContainer?.Metadata ?? []).filter((entry) =>
      entry.Media?.some((media) => media.Part?.some((part) => normalized.some((path) => part.file === path || part.file?.startsWith(`${path}/`))))
    );
    if (matches.length) break;
  }
  if (!matches.length) throw new Error("Plex did not expose the organized media after its library refresh");
  if (item.postDownload?.verifyCanonicalMetadata === true) {
    const incomplete = matches.filter((entry) => {
      const hasTitle = Boolean(entry.title && (item.destination.type === "movie" || entry.grandparentTitle));
      const hasDate = Boolean(entry.originallyAvailableAt || entry.year);
      return !hasTitle || !entry.summary || !hasDate;
    });
    await setItemState(item.id, {
      metadataVerification: incomplete.length ? "incomplete" : "passed",
      metadataSummary: `${matches.length - incomplete.length}/${matches.length} Plex item(s) have title, date, and description`,
    });
  }
  if (item.postDownload?.verifyArtwork === true) {
    const missingArtwork = matches.filter((entry) => !entry.thumb && !entry.parentThumb && !entry.grandparentThumb);
    await setItemState(item.id, {
      artworkVerification: missingArtwork.length ? "incomplete" : "passed",
      artworkSummary: `${matches.length - missingArtwork.length}/${matches.length} Plex item(s) have artwork`,
    });
  }
  return matches;
}

function plexFieldIsLocked(value: boolean | number | string | undefined) {
  return value === true || value === 1 || value === "1";
}

function metadataCuratorRecords(matches: PlexMetadata[]): MetadataCuratorRecord[] {
  return matches.flatMap((entry) => {
    if (!entry.ratingKey || !/^\d+$/.test(entry.ratingKey)) return [];
    return [{
      recordId: entry.ratingKey,
      type: entry.type ?? "unknown",
      title: entry.title ?? "",
      parentTitle: entry.parentTitle ?? "",
      grandparentTitle: entry.grandparentTitle ?? "",
      seasonNumber: entry.parentIndex ?? 0,
      episodeNumber: entry.index ?? 0,
      year: entry.year ?? 0,
      originallyAvailableAt: entry.originallyAvailableAt ?? "",
      summary: entry.summary ?? "",
      guid: entry.guid ?? "",
      externalGuids: (entry.Guid ?? []).flatMap((guid) => guid.id ? [guid.id] : []),
      hasArtwork: Boolean(entry.thumb || entry.parentThumb || entry.grandparentThumb),
      lockedFields: (entry.Field ?? []).flatMap((field) =>
        field.name && plexFieldIsLocked(field.locked) ? [field.name] : []
      ),
      files: (entry.Media ?? []).flatMap((media) => media.Part ?? []).flatMap((part) => part.file ? [part.file] : []),
    }];
  });
}

function changedMetadataPatch(patch: MetadataCuratorPatch, record: MetadataCuratorRecord) {
  return {
    ...patch,
    applyTitle: patch.applyTitle && patch.title !== record.title,
    applySummary: patch.applySummary && patch.summary !== record.summary,
    applyOriginallyAvailableAt:
      patch.applyOriginallyAvailableAt && patch.originallyAvailableAt !== record.originallyAvailableAt,
    applyYear: patch.applyYear && patch.year !== record.year,
  };
}

async function applyPlexMetadataPatch(token: string, patch: MetadataCuratorPatch) {
  const params = new URLSearchParams();
  if (patch.applyTitle) params.set("title", patch.title);
  if (patch.applySummary) params.set("summary", patch.summary);
  if (patch.applyOriginallyAvailableAt) params.set("originallyAvailableAt", patch.originallyAvailableAt);
  if (patch.applyYear) params.set("year", String(patch.year));
  if (!params.size) return 0;
  const response = await fetch(
    `${plexUrl}/library/metadata/${encodeURIComponent(patch.recordId)}?${params}`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "X-Plex-Token": token },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`Plex rejected metadata edit for ${patch.recordId} with HTTP ${response.status}`);
  return [patch.applyTitle, patch.applySummary, patch.applyOriginallyAvailableAt, patch.applyYear].filter(Boolean).length;
}

async function fetchPlexMetadataRecord(token: string, recordId: string) {
  const response = await fetch(`${plexUrl}/library/metadata/${encodeURIComponent(recordId)}`, {
    headers: { Accept: "application/json", "X-Plex-Token": token },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Could not verify Plex metadata ${recordId}: HTTP ${response.status}`);
  const payload = await response.json() as { MediaContainer?: { Metadata?: PlexMetadata[] } };
  const record = payload.MediaContainer?.Metadata?.[0];
  if (!record) throw new Error(`Plex metadata ${recordId} disappeared after editing`);
  return record;
}

function verifyAppliedMetadata(patch: MetadataCuratorPatch, record: PlexMetadata) {
  if (patch.applyTitle && record.title !== patch.title) throw new Error(`Plex did not retain the title edit for ${patch.recordId}`);
  if (patch.applySummary && record.summary !== patch.summary) throw new Error(`Plex did not retain the summary edit for ${patch.recordId}`);
  if (patch.applyOriginallyAvailableAt && record.originallyAvailableAt !== patch.originallyAvailableAt) {
    throw new Error(`Plex did not retain the release-date edit for ${patch.recordId}`);
  }
  if (patch.applyYear && record.year !== patch.year) throw new Error(`Plex did not retain the year edit for ${patch.recordId}`);
}

async function curatePlexMetadata(
  item: ManifestItem,
  matches: PlexMetadata[],
  logPath: string,
) {
  const config = metadataCuratorConfig();
  if (!config.available) {
    await setItemState(item.id, {
      aiMetadataStatus: "skipped",
      aiMetadataModel: config.model,
      aiMetadataSummary: "OPENAI_API_KEY is not configured",
    });
    return;
  }
  const token = plexToken();
  if (!token) throw new Error("Could not read Plex token for AI metadata review");
  const hydratedMatches = await Promise.all(matches.map(async (match) => {
    if (!match.ratingKey || !/^\d+$/.test(match.ratingKey)) return match;
    const details = await fetchPlexMetadataRecord(token, match.ratingKey);
    return { ...match, ...details, Media: details.Media ?? match.Media };
  }));
  const records = metadataCuratorRecords(hydratedMatches);
  if (!records.length) throw new Error("Plex matches did not contain editable record IDs");
  await setItemState(item.id, {
    aiMetadataStatus: "researching",
    aiMetadataModel: config.model,
    aiMetadataSummary: `Researching ${records.length} matched Plex record(s)`,
  });
  await appendBatch(`AI metadata review started for ${item.title}`);
  const { model, plan } = await createMetadataCuratorPlan({
    requestedTitle: item.title,
    payloadName: item.payloadName,
    destinationPath: item.destination.path,
    mediaType: item.destination.type,
    records,
  });
  const byId = new Map(records.map((record) => [record.recordId, record]));
  const patches = plan.patches
    .map((patch) => changedMetadataPatch(patch, byId.get(patch.recordId)!))
    .filter((patch) => patch.applyTitle || patch.applySummary || patch.applyOriginallyAvailableAt || patch.applyYear);
  await appendFile(logPath, `\n--- AI metadata review (${model}) ---\n${plan.summary}\n${plan.issues.join("\n")}\n`);
  if (!patches.length) {
    await setItemState(item.id, {
      aiMetadataStatus: "passed",
      aiMetadataModel: model,
      aiMetadataSummary: plan.summary.slice(0, 1000),
      aiMetadataChanges: "[]",
    });
    await appendBatch(`AI metadata review passed for ${item.title}: ${plan.summary}`);
    return;
  }
  await setItemState(item.id, {
    aiMetadataStatus: "applying",
    aiMetadataModel: model,
    aiMetadataSummary: `Applying ${patches.length} high-confidence metadata correction(s)`,
  });
  let changedFields = 0;
  for (const patch of patches) {
    changedFields += await applyPlexMetadataPatch(token, patch);
    verifyAppliedMetadata(patch, await fetchPlexMetadataRecord(token, patch.recordId));
    await appendFile(logPath, `${patch.recordId}: ${patch.reason}\nEvidence: ${patch.evidenceUrls.join(", ")}\n`);
  }
  const summary = `Corrected ${changedFields} field(s) across ${patches.length} Plex record(s). ${plan.summary}`;
  await setItemState(item.id, {
    aiMetadataStatus: "fixed",
    aiMetadataModel: model,
    aiMetadataSummary: summary.slice(0, 1000),
    aiMetadataChanges: JSON.stringify(patches),
  });
  await appendBatch(`AI metadata review fixed ${item.title}: ${changedFields} field(s)`);
}

await ensureDir(root);
await ensureDir(join(root, "torrents"));
await ensureDir(join(root, "logs"));

const initialState = await loadState();
const interruptedItemIds = Object.entries(initialState.items)
  .filter(([, itemState]) => itemState.status === "active" || itemState.status === "organizing")
  .map(([id]) => id);
for (const id of interruptedItemIds) {
  initialState.items[id] = { ...initialState.items[id], status: "pending" };
  await rm(join(root, "control", "preempt", id), { force: true });
}
await enqueueState(async () =>
  saveState({
    ...initialState,
    startedAt: initialState.startedAt ?? now(),
    finishedAt: undefined,
    currentItemId: null,
  }),
);
await appendBatch(`Batch started ${now()}`);
if (interruptedItemIds.length > 0) {
  await appendBatch(`Recovered ${interruptedItemIds.length} interrupted item(s) to pending`);
}

async function processItem(item: ManifestItem) {
  const state = await loadState();
  if (state.items[item.id]?.status === "completed" && existsSync(item.destination.path)) {
    await appendBatch(`Skipping completed item ${item.id}`);
    return;
  }
  const staging = join(root, "staging", item.id);
  const logPath = join(root, "logs", `${item.id}.log`);
  await rm(join(root, "control", "preempt", item.id), { force: true });
  await ensureDir(staging);
  await ensureDir(join(root, "logs"));
  await setItemState(item.id, { status: "active", startedAt: now(), error: null });
  await appendBatch(`Starting ${item.title}`);
  const storedTorrent = item.torrentFile ? join(root, "torrents", item.torrentFile) : "";
  let cachedMagnetTorrent = "";
  if (item.magnetUri) {
    try {
      const magnet = new URL(item.magnetUri);
      const hash = magnet.searchParams.getAll("xt")
        .find((value) => /^urn:btih:[a-z0-9]+$/i.test(value))
        ?.split(":")
        .at(-1)
        ?.toLowerCase();
      const candidate = hash ? join(root, "torrent-metadata", hash, "metadata.torrent") : "";
      if (candidate && existsSync(candidate)) cachedMagnetTorrent = candidate;
    } catch {
      // The download command will report malformed magnet links normally.
    }
  }
  const torrentSource = storedTorrent && existsSync(storedTorrent)
    ? storedTorrent
    : cachedMagnetTorrent || item.magnetUri || "";
  if (!torrentSource) throw new Error(`${item.title}: missing torrent file or magnet link`);
  if (cachedMagnetTorrent && torrentSource === cachedMagnetTorrent) {
    await appendBatch(`Using cached torrent metadata for ${item.title}`);
  }

  const selectedFiles = [...new Set(item.selectFiles ?? [])]
    .filter((index) => Number.isInteger(index) && index > 0)
    .sort((left, right) => left - right);
  const compactSelection = selectedFiles.reduce<string[]>((parts, index) => {
    const last = parts.at(-1);
    const match = last?.match(/^(\d+)(?:-(\d+))?$/);
    const end = match ? Number(match[2] ?? match[1]) : -1;
    if (end + 1 !== index) {
      parts.push(String(index));
      return parts;
    }
    const start = Number(match?.[1]);
    parts[parts.length - 1] = `${start}-${index}`;
    return parts;
  }, []).join(",");

  const payloadAlreadyComplete = state.items[item.id]?.payloadStatus === "complete" && await stagingHasPayload(staging);
  if (payloadAlreadyComplete) {
    await writeFile(logPath, "");
    await appendFile(logPath, "--- Download ---\nReusing the completed staged payload.\n");
    await appendBatch(`Reusing completed staged payload for ${item.title}`);
  } else {
    await setItemState(item.id, { payloadStatus: "downloading", payloadCompletedAt: null });
    const exitCode = await runCommand(
      [
        "aria2c",
        `--dir=${staging}`,
        "--continue=true",
        ...(checkIntegrity ? ["--check-integrity=true"] : []),
        "--file-allocation=none",
        ...aria2NetworkPolicyArgs(),
        "--bt-max-peers=80",
        "--bt-enable-lpd=false",
        "--enable-peer-exchange=true",
        "--summary-interval=30",
        "--console-log-level=notice",
        ...(compactSelection ? [`--select-file=${compactSelection}`] : []),
        torrentSource,
      ],
      logPath,
    );
    if (exitCode !== 0) {
      const preemptPath = join(root, "control", "preempt", item.id);
      if (await pathExists(preemptPath)) {
        await rm(preemptPath, { force: true });
        await setItemState(item.id, { status: "pending", startedAt: null, failedAt: null, error: null });
        await appendBatch(`Paused ${item.title}: queue priority changed`);
        return;
      }
      await setItemState(item.id, { status: "failed", failedAt: now(), error: `aria2c exited ${exitCode}` });
      await appendBatch(`FAILED ${item.title}: aria2c exited ${exitCode}`);
      throw new Error(`${item.title}: aria2c exited ${exitCode}`);
    }
    await setItemState(item.id, { payloadStatus: "complete", payloadCompletedAt: now() });
  }

  await pruneUnselectedDownloadArtifacts(item, logPath);

  const downloadedStats = await collectFileStats(staging);
  if (downloadedStats.totalBytes > 0 && !item.selectFiles?.length) {
    item.totalBytes = downloadedStats.totalBytes;
    item.fileCount = downloadedStats.fileCount;
    await updateManifestItem(item.id, {
      totalBytes: downloadedStats.totalBytes,
      fileCount: downloadedStats.fileCount,
    });
  }

  if (item.postDownload?.verifyStreams === true) {
    await verifyMediaStreams(item, staging, logPath);
  }

  if (item.postDownload?.scanForMalware === true) {
    await scanForMalware(item, staging, logPath);
  }

  await setItemState(item.id, { status: "organizing" });
  await appendBatch(`Organizing ${item.title}`);
  let replacementSwap: ReplacementSwap | null = null;
  try {
    replacementSwap = await beginReplacementSwap(item);
    const organizedDestinations = await organize(item);
    if (item.postDownload?.ensureEnglishSubtitles === true) {
      try {
        await ensureEnglishSubtitles(item, organizedDestinations, logPath);
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error);
        await setItemState(item.id, { subtitleStatus: "error", subtitleWarning: warning });
        await appendBatch(`Subtitle warning for ${item.title}: ${warning}`);
      }
    }
    if (item.postDownload?.refreshPlex !== false || replacementSwap) {
      try {
        await scanPlex(item.destination.type);
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error);
        await setItemState(item.id, { plexScanWarning: warning });
        await appendBatch(`Plex scan warning for ${item.title}: ${warning}`);
      }
    }
    let plexMatches: PlexMetadata[] = [];
    const validateMetadataWithAi = item.postDownload?.validateMetadataWithAi !== false;
    const verifyInPlex = Boolean(
      replacementSwap
      || item.postDownload?.verifyCanonicalMetadata === true
      || item.postDownload?.verifyArtwork === true
      || validateMetadataWithAi
    );
    if (verifyInPlex) {
      try {
        plexMatches = await verifyPlexResult(item, organizedDestinations);
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error);
        await setItemState(item.id, { plexVerificationWarning: warning });
        await appendBatch(`Plex verification warning for ${item.title}: ${warning}`);
        if (replacementSwap) throw new Error(`Replacement verification failed: ${warning}`);
      }
    }
    if (validateMetadataWithAi) {
      try {
        if (!plexMatches.length) throw new Error("AI metadata review could not find the newly added Plex records");
        await curatePlexMetadata(item, plexMatches, logPath);
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error);
        await setItemState(item.id, { aiMetadataStatus: "warning", aiMetadataSummary: warning });
        await appendFile(logPath, `\n--- AI metadata review warning ---\n${warning}\n`);
        await appendBatch(`AI metadata warning for ${item.title}: ${warning}`);
      }
    }
    await relinkWatchthroughAliases(item, replacementSwap, organizedDestinations);
    await commitReplacementSwap(item, replacementSwap);
  } catch (error) {
    await restoreReplacementSwap(item, replacementSwap);
    const message = error instanceof Error ? error.message : String(error);
    await setItemState(item.id, { status: "failed", failedAt: now(), error: message });
    await appendBatch(`FAILED ${item.title}: ${message}`);
    throw error;
  }
  await setItemState(item.id, { status: "completed", completedAt: now(), error: null, failedAt: null });
  await appendBatch(`Completed ${item.title}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const running = new Map<string, Promise<void>>();
let completionLogged = false;
let lastAdaptiveChangeAt = 0;
let adaptiveOverloadSince = 0;
const sampleDiskActivity = createDiskActivitySampler(root);

async function markBatchCompleteIfIdle(manifest: Manifest) {
  if (running.size > 0 || manifest.items.length === 0) return;
  const state = await loadState();
  const statuses = manifest.items.map((item) => state.items[item.id]?.status);
  const complete = statuses.length > 0 && statuses.every((status) => status === "completed" || status === "failed");
  if (!complete) return;
  if (!state.finishedAt) {
    state.finishedAt = now();
    state.currentItemId = null;
    await saveState(state);
  }
  if (!completionLogged) {
    await appendBatch(`Batch idle ${now()} - waiting for new uploads`);
    completionLogged = true;
  }
}

function startItem(item: ManifestItem) {
  const task = processItem(item)
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const state = await loadState();
      const status = state.items[item.id]?.status;
      if (status !== "completed" && status !== "failed") {
        await setItemState(item.id, { status: "failed", failedAt: now(), error: message });
      }
      await appendBatch(`Task error ${item.title}: ${message}`);
    })
    .finally(() => {
      running.delete(item.id);
    });
  running.set(item.id, task);
}

async function pauseLowestPriorityItem(manifest: Manifest, state: State, reason: string) {
  const item = [...manifest.items].reverse().find((candidate) =>
    running.has(candidate.id) && state.items[candidate.id]?.status === "active"
  );
  if (!item) return false;
  const preemptDir = join(root, "control", "preempt");
  const preemptPath = join(preemptDir, item.id);
  await ensureDir(preemptDir);
  await writeFile(preemptPath, new Date().toISOString());
  const pids = stopAria2ForItem(item.id);
  if (!pids.length) {
    await rm(preemptPath, { force: true });
    return false;
  }
  await appendBatch(`Adaptive scheduler paused ${item.title}: ${reason}`);
  return true;
}

while (true) {
  const manifest = await loadManifest();
  const state = await loadState();
  const diskActivity = adaptiveConcurrency ? await sampleDiskActivity() : { writeBytesPerSecond: 0, busyPercent: 0 };
  const ingressBytesPerSecond = adaptiveConcurrency && running.size > 0
    ? await aggregateIngressBytesPerSecond([...running.keys()])
    : 0;
  if (adaptiveConcurrency && running.size > adaptiveMinConcurrency) {
    const diskWriteOverloaded = diskActivity.writeBytesPerSecond >= diskWriteBudgetBytes * adaptiveScaleDownWriteRatio;
    const diskBusyOverloaded = diskActivity.busyPercent >= adaptiveScaleDownBusyThreshold;
    const ingressOutrunningDisk = (
      diskActivity.busyPercent >= adaptiveDiskBusyThreshold
      && ingressBytesPerSecond >= diskWriteBudgetBytes * adaptiveIngressThreshold
      && ingressBytesPerSecond > diskActivity.writeBytesPerSecond * 1.2
    );
    const overloaded = diskWriteOverloaded || diskBusyOverloaded || ingressOutrunningDisk;
    adaptiveOverloadSince = overloaded ? adaptiveOverloadSince || Date.now() : 0;
    const pressureSustained = adaptiveOverloadSince > 0 && Date.now() - adaptiveOverloadSince >= adaptiveScaleDownMs;
    const cooldownElapsed = Date.now() - lastAdaptiveChangeAt >= adaptiveCooldownMs;
    if (pressureSustained && cooldownElapsed) {
      const reasons = [
        diskBusyOverloaded ? `disk busy ${diskActivity.busyPercent.toFixed(0)}%` : "",
        diskWriteOverloaded ? `disk writes ${formatRate(diskActivity.writeBytesPerSecond)}` : "",
        ingressOutrunningDisk ? `ingress ${formatRate(ingressBytesPerSecond)} outrunning writes` : "",
      ].filter(Boolean).join(", ");
      if (await pauseLowestPriorityItem(manifest, state, reasons)) {
        lastAdaptiveChangeAt = Date.now();
        adaptiveOverloadSince = 0;
      }
    }
  } else {
    adaptiveOverloadSince = 0;
  }
  let openedAdaptiveSlot = false;
  for (const item of manifest.items) {
    if (adaptiveConcurrency) {
      if (running.size >= adaptiveMaxConcurrency) break;
      if (running.size >= adaptiveMinConcurrency) {
        const settled = Date.now() - lastAdaptiveChangeAt >= Math.max(adaptiveSettleMs, adaptiveCooldownMs);
        const ingressHasRoom = ingressBytesPerSecond < diskWriteBudgetBytes * adaptiveIngressThreshold;
        const diskRateHasRoom = diskActivity.writeBytesPerSecond < diskWriteBudgetBytes * 0.85;
        const diskIsResponsive = diskActivity.busyPercent < adaptiveDiskBusyThreshold;
        if (openedAdaptiveSlot || !settled || !ingressHasRoom || !diskRateHasRoom || !diskIsResponsive) break;
      }
    } else if (maxConcurrentDownloads > 0 && running.size >= maxConcurrentDownloads) {
      break;
    }
    if (running.has(item.id)) continue;
    let status = state.items[item.id]?.status;
    if (status === "completed" && !existsSync(item.destination.path)) {
      await setItemState(item.id, { status: "pending", completedAt: null, error: "Completed destination is missing; queued again" });
      await appendBatch(`Re-queued ${item.title}: completed destination is missing`);
      status = "pending";
    }
    if (status === "completed" || status === "failed") continue;
    completionLogged = false;
    if (adaptiveConcurrency && running.size >= adaptiveMinConcurrency) {
      await appendBatch(
        `Adaptive scheduler opened slot ${running.size + 1}/${adaptiveMaxConcurrency}: `
        + `ingress ${formatRate(ingressBytesPerSecond)}, disk ${formatRate(diskActivity.writeBytesPerSecond)}, `
        + `busy ${diskActivity.busyPercent.toFixed(0)}%`,
      );
      openedAdaptiveSlot = true;
    }
    startItem(item);
    if (adaptiveConcurrency) lastAdaptiveChangeAt = Date.now();
  }
  await markBatchCompleteIfIdle(manifest);
  await sleep(2_000);
}
