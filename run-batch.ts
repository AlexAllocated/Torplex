import { existsSync } from "fs";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

const root = process.env.BATCH_DIR ?? "/media/plex/.downloads/torrent-batch";

type ManifestItem = {
  id: string;
  title: string;
  torrentFile: string;
  payloadName: string;
  totalBytes: number;
  destination: { type: "movie" | "show"; path: string };
  organize:
    | { strategy: "moveRoot"; seasonRenames?: Record<string, string>; fileRenames?: Record<string, string> }
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

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
const statePath = join(root, "state.json");
const batchLogPath = join(root, "batch.log");

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
  const state = await loadState();
  state.items[id] = { ...(state.items[id] ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete state.items[id][key];
    else state.items[id][key] = value;
  }
  if (values.status === "active" || values.status === "organizing") state.currentItemId = id;
  if (values.status === "completed" || values.status === "failed") state.currentItemId = null;
  await saveState(state);
}

async function appendBatch(line: string) {
  await Bun.write(batchLogPath, `${existsSync(batchLogPath) ? await readFile(batchLogPath, "utf8") : ""}${line}\n`);
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
      if ((await pathExists(source)) && !(await pathExists(target))) await rename(source, target);
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
  const chown = Bun.spawnSync(["sudo", "chown", "-R", "alex:plex", dest]);
  if (chown.exitCode !== 0) throw new Error(`chown failed for ${dest}`);
  Bun.spawnSync(["find", dest, "-type", "d", "-exec", "chmod", "775", "{}", "+"]);
  Bun.spawnSync(["find", dest, "-type", "f", "-exec", "chmod", "664", "{}", "+"]);
}

function plexToken() {
  const pref = "/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml";
  const proc = Bun.spawnSync(["sudo", "sed", "-n", 's/.*PlexOnlineToken="\\([^"]*\\)".*/\\1/p', pref]);
  return proc.stdout.toString().trim();
}

async function scanPlex(section: "movie" | "show") {
  const token = plexToken();
  const key = section === "movie" ? "1" : "2";
  if (!token) throw new Error("Could not read Plex token");
  const url = `http://127.0.0.1:32400/library/sections/${key}/refresh?X-Plex-Token=${encodeURIComponent(token)}`;
  const proc = Bun.spawnSync(["curl", "-fsS", url]);
  if (proc.exitCode !== 0) throw new Error(`Plex scan failed for section ${key}`);
}

const initialState = await loadState();
await saveState({ ...initialState, startedAt: initialState.startedAt ?? now() });
await appendBatch(`Batch started ${now()}`);

for (const item of manifest.items) {
  const state = await loadState();
  if (state.items[item.id]?.status === "completed") {
    await appendBatch(`Skipping completed item ${item.id}`);
    continue;
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
    process.exit(exitCode);
  }

  await setItemState(item.id, { status: "organizing" });
  await appendBatch(`Organizing ${item.title}`);
  try {
    await organize(item);
    await scanPlex(item.destination.type);
  } catch (error) {
    await setItemState(item.id, { status: "failed", failedAt: now(), error: error instanceof Error ? error.message : String(error) });
    await appendBatch(`FAILED ${item.title}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  await setItemState(item.id, { status: "completed", completedAt: now() });
  await appendBatch(`Completed ${item.title}`);
}

const finalState = await loadState();
finalState.finishedAt = now();
finalState.currentItemId = null;
await saveState(finalState);
await appendBatch(`Batch completed ${now()}`);
