import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SearchQualityProfile } from "$lib/search-quality";
import type { SearchProposal } from "$lib/server/torrent-search";

export type SearchSessionStatus = "running" | "completed" | "failed" | "cancelled";

export type SearchSession = {
  id: string;
  prompt: string;
  status: SearchSessionStatus;
  qualityProfile: SearchQualityProfile;
  progress: string[];
  proposal: SearchProposal | null;
  error: string;
  createdAt: string;
  updatedAt: string;
};

type SessionStore = { version: 1; sessions: SearchSession[] };
type Listener = (session: SearchSession) => void;

const validSearchId = /^[a-zA-Z0-9_-]{12,100}$/;
const maximumSessions = 20;
const maximumProgressLines = 240;
const listeners = new Map<string, Set<Listener>>();
let sessions = new Map<string, SearchSession>();
let loaded = false;
let loadPromise: Promise<void> | null = null;
let writeChain = Promise.resolve();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function storePath() {
  return join(process.env.BATCH_DIR || "/media/plex/.downloads/torrent-batch", "search-sessions.json");
}

function cloneSession(session: SearchSession) {
  return structuredClone(session);
}

async function ensureLoaded() {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const parsed = JSON.parse(await readFile(storePath(), "utf8")) as SessionStore;
        const now = new Date().toISOString();
        sessions = new Map((Array.isArray(parsed.sessions) ? parsed.sessions : [])
          .filter((session) => session && validSearchId.test(session.id))
          .map((session) => [session.id, session.status === "running"
            ? { ...session, status: "failed" as const, error: "Search was interrupted by a Torplex restart", updatedAt: now }
            : session]));
      } catch {
        sessions = new Map();
      }
      loaded = true;
    })();
  }
  await loadPromise;
}

async function persist() {
  const snapshot = [...sessions.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maximumSessions);
  sessions = new Map(snapshot.map((session) => [session.id, session]));
  writeChain = writeChain.catch(() => {}).then(async () => {
    const path = storePath();
    const temporary = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ version: 1, sessions: snapshot }, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  });
  await writeChain;
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, 250);
}

function publish(session: SearchSession) {
  for (const listener of listeners.get(session.id) || []) listener(cloneSession(session));
}

async function mutate(searchId: string, update: (session: SearchSession) => void, deferred = false) {
  await ensureLoaded();
  const session = sessions.get(searchId);
  if (!session) throw new Error("Search session was not found");
  update(session);
  session.updatedAt = new Date().toISOString();
  sessions.set(searchId, session);
  publish(session);
  if (deferred) persistSoon();
  else {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persist();
  }
  return cloneSession(session);
}

export async function createSearchSession(input: {
  id: string;
  prompt: string;
  qualityProfile: SearchQualityProfile;
}) {
  await ensureLoaded();
  if (!validSearchId.test(input.id)) throw new Error("Search job ID is invalid");
  if (sessions.get(input.id)?.status === "running") throw new Error("Search job is already running");
  const now = new Date().toISOString();
  const session: SearchSession = {
    id: input.id,
    prompt: input.prompt,
    status: "running",
    qualityProfile: input.qualityProfile,
    progress: [],
    proposal: null,
    error: "",
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(session.id, session);
  publish(session);
  await persist();
  return cloneSession(session);
}

export async function appendSearchProgress(searchId: string, message: string) {
  return mutate(searchId, (session) => {
    session.progress = [...session.progress, message].slice(-maximumProgressLines);
  }, true);
}

export async function completeSearchSession(searchId: string, proposal: SearchProposal) {
  return mutate(searchId, (session) => {
    session.status = "completed";
    session.proposal = proposal;
    session.error = "";
  });
}

export async function failSearchSession(searchId: string, error: string) {
  return mutate(searchId, (session) => {
    session.status = "failed";
    session.error = error;
  });
}

export async function cancelSearchSession(searchId: string) {
  return mutate(searchId, (session) => {
    session.status = "cancelled";
    session.error = "";
    if (session.progress.at(-1) !== "Search cancelled") session.progress.push("Search cancelled");
  });
}

export async function updateSearchProposal(searchId: string, proposal: SearchProposal) {
  return mutate(searchId, (session) => {
    session.status = "completed";
    session.proposal = proposal;
    session.error = "";
  });
}

export async function getSearchSession(searchId: string) {
  await ensureLoaded();
  const session = sessions.get(searchId);
  return session ? cloneSession(session) : null;
}

export async function getLatestSearchSession() {
  await ensureLoaded();
  const session = [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return session ? cloneSession(session) : null;
}

export function subscribeSearchSession(searchId: string, listener: Listener) {
  const bucket = listeners.get(searchId) || new Set<Listener>();
  bucket.add(listener);
  listeners.set(searchId, bucket);
  return () => {
    bucket.delete(listener);
    if (!bucket.size) listeners.delete(searchId);
  };
}
