import { existsSync } from "fs";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

const root = process.env.BATCH_DIR ?? "/media/plex/.downloads/torrent-batch";
const plexUrl = (process.env.PLEX_URL ?? "http://127.0.0.1:32400").replace(/\/$/, "");
const plexPreferencesPath =
  process.env.PLEX_PREFERENCES_PATH ?? "/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml";
const plexMovieSectionId = process.env.PLEX_MOVIE_SECTION_ID ?? "1";
const plexShowSectionId = process.env.PLEX_SHOW_SECTION_ID ?? "2";
const mediaChown = process.env.MEDIA_CHOWN ?? "";
const mediaDirMode = process.env.MEDIA_DIR_MODE ?? "775";
const mediaFileMode = process.env.MEDIA_FILE_MODE ?? "664";

type ManifestItem = {
  id: string;
  title: string;
  torrentFile: string;
  payloadName: string;
  totalBytes: number;
  destination: { type: "movie" | "show"; path: string };
  organize:
    | { strategy: "moveRoot"; seasonRenames?: Record<string, string>; fileRenames?: Record<string, string> }
    | { strategy: "mergeRoot"; targetSubdir?: string }
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
    await Bun.write(batchLogPath, `${existsSync(batchLogPath) ? await readFile(batchLogPath, "utf8") : ""}${line}\n`);
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

async function movePath(source: string, destination: string) {
  await ensureDir(dirname(destination));
  await rename(source, destination);
}

async function runCommand(args: string[], logPath: string) {
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

function sourceRoot(item: ManifestItem) {
  return join(root, "staging", item.id, item.payloadName);
}

async function organize(item: ManifestItem) {
  const staging = join(root, "staging", item.id);
  const dest = item.destination.path;

  if (item.organize.strategy === "moveRoot") {
    if (await pathExists(dest)) throw new Error(`Destination already exists: ${dest}`);
    await movePath(sourceRoot(item), dest);
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
  } else if (item.organize.strategy === "mergeRoot") {
    await ensureDir(dest);
    const targetDir = item.organize.targetSubdir ? join(dest, item.organize.targetSubdir) : dest;
    await ensureDir(targetDir);
    const source = sourceRoot(item);
    const entries = new Bun.Glob("*").scan(source);
    for await (const entry of entries) {
      const target = join(targetDir, entry);
      if (await pathExists(target)) throw new Error(`Destination already exists: ${target}`);
      await movePath(join(source, entry), target);
    }
  } else if (item.organize.strategy === "singleFile") {
    if (await pathExists(dest)) throw new Error(`Destination already exists: ${dest}`);
    await ensureDir(dest);
    await movePath(join(staging, item.organize.source), join(dest, item.organize.finalName));
  } else {
    await ensureDir(dest);
    const target = join(dest, item.organize.finalName);
    if (await pathExists(target)) throw new Error(`Destination already exists: ${target}`);
    await movePath(join(sourceRoot(item), item.organize.source), target);
  }

  await rm(staging, { recursive: true, force: true });
  if (mediaChown) {
    const chown = Bun.spawnSync(["sudo", "chown", "-R", mediaChown, dest]);
    if (chown.exitCode !== 0) throw new Error(`chown failed for ${dest}`);
  }
  if (mediaDirMode) Bun.spawnSync(["find", dest, "-type", "d", "-exec", "chmod", mediaDirMode, "{}", "+"]);
  if (mediaFileMode) Bun.spawnSync(["find", dest, "-type", "f", "-exec", "chmod", mediaFileMode, "{}", "+"]);
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

await ensureDir(root);
await ensureDir(join(root, "torrents"));
await ensureDir(join(root, "logs"));

const initialState = await loadState();
await enqueueState(async () => saveState({ ...initialState, startedAt: initialState.startedAt ?? now(), finishedAt: undefined }));
await appendBatch(`Batch started ${now()}`);

async function processItem(item: ManifestItem) {
  const state = await loadState();
  if (state.items[item.id]?.status === "completed") {
    await appendBatch(`Skipping completed item ${item.id}`);
    return;
  }
  const staging = join(root, "staging", item.id);
  const logPath = join(root, "logs", `${item.id}.log`);
  await ensureDir(staging);
  await ensureDir(join(root, "logs"));
  await setItemState(item.id, { status: "active", startedAt: now(), error: null });
  await appendBatch(`Starting ${item.title}`);

  const exitCode = await runCommand(
    [
      "aria2c",
      `--dir=${staging}`,
      "--continue=true",
      "--file-allocation=none",
      "--seed-time=0",
      "--seed-ratio=0.0",
      "--max-upload-limit=1K",
      "--bt-max-peers=80",
      "--bt-enable-lpd=false",
      "--enable-peer-exchange=true",
      "--summary-interval=30",
      "--console-log-level=notice",
      join(root, "torrents", item.torrentFile),
    ],
    logPath,
  );
  if (exitCode !== 0) {
    await setItemState(item.id, { status: "failed", failedAt: now(), error: `aria2c exited ${exitCode}` });
    await appendBatch(`FAILED ${item.title}: aria2c exited ${exitCode}`);
    throw new Error(`${item.title}: aria2c exited ${exitCode}`);
  }

  await setItemState(item.id, { status: "organizing" });
  await appendBatch(`Organizing ${item.title}`);
  try {
    await organize(item);
    await scanPlex(item.destination.type);
  } catch (error) {
    await setItemState(item.id, { status: "failed", failedAt: now(), error: error instanceof Error ? error.message : String(error) });
    await appendBatch(`FAILED ${item.title}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  await setItemState(item.id, { status: "completed", completedAt: now() });
  await appendBatch(`Completed ${item.title}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const running = new Map<string, Promise<void>>();
let completionLogged = false;

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
      await appendBatch(`Task error ${item.title}: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      running.delete(item.id);
    });
  running.set(item.id, task);
}

while (true) {
  const manifest = await loadManifest();
  const state = await loadState();
  for (const item of manifest.items) {
    if (running.has(item.id)) continue;
    const status = state.items[item.id]?.status;
    if (status === "completed" || status === "failed" || status === "organizing") continue;
    completionLogged = false;
    startItem(item);
  }
  await markBatchCompleteIfIdle(manifest);
  await sleep(2_000);
}
