import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const defaultPlexUrl = "http://127.0.0.1:32400";
const pageSize = 200;
const maximumItems = 5_000;

function requestSignal(signal: AbortSignal | undefined) {
  const timeout = AbortSignal.timeout(20_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type LibraryInventoryItem = {
  id: string;
  title: string;
  year: number | null;
  type: "movie" | "show";
  source: "plex" | "queue";
  status: string;
};

type PlexMetadata = {
  ratingKey?: string;
  title?: string;
  year?: number;
};

type PlexSection = {
  key?: string;
  type?: string;
};

type QueueManifest = {
  items?: Array<{
    id?: string;
    title?: string;
    destination?: { type?: string; path?: string };
  }>;
};

type QueueState = {
  items?: Record<string, { status?: string }>;
};

export function normalizeLibraryTitle(value: string) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleAndYear(value: string) {
  const clean = String(value || "").trim();
  const match = clean.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  return {
    title: (match?.[1] || clean).trim(),
    year: match ? Number(match[2]) : null,
  };
}

export function findLibraryMatch(
  work: { title: string; year: number | null; type: "movie" | "show" },
  inventory: LibraryInventoryItem[],
) {
  const title = normalizeLibraryTitle(work.title);
  return inventory.find((item) => {
    if (item.type !== work.type || normalizeLibraryTitle(item.title) !== title) return false;
    if (work.year !== null) return item.year === work.year;
    return true;
  });
}

async function plexSectionInventory(
  sectionId: string,
  type: "movie" | "show",
  token: string,
  plexUrl: string,
  signal?: AbortSignal,
) {
  const items: LibraryInventoryItem[] = [];
  const metadataType = type === "movie" ? "1" : "2";
  for (let start = 0; start < maximumItems; start += pageSize) {
    const url = new URL(`${plexUrl}/library/sections/${encodeURIComponent(sectionId)}/all`);
    url.searchParams.set("type", metadataType);
    url.searchParams.set("X-Plex-Container-Start", String(start));
    url.searchParams.set("X-Plex-Container-Size", String(pageSize));
    const response = await fetch(url, {
      headers: { Accept: "application/json", "X-Plex-Token": token },
      signal: requestSignal(signal),
    });
    if (!response.ok) throw new Error(`Plex ${type} inventory returned HTTP ${response.status}`);
    const payload = await response.json() as {
      MediaContainer?: { Metadata?: PlexMetadata[]; totalSize?: number; size?: number };
    };
    const metadata = payload.MediaContainer?.Metadata ?? [];
    for (const entry of metadata) {
      if (!entry.title) continue;
      items.push({
        id: `plex-${type}-${entry.ratingKey || `${start + items.length}`}`,
        title: entry.title,
        year: Number.isInteger(entry.year) ? entry.year! : null,
        type,
        source: "plex",
        status: "in library",
      });
    }
    const totalSize = payload.MediaContainer?.totalSize;
    if (metadata.length < pageSize || (typeof totalSize === "number" && start + metadata.length >= totalSize)) break;
  }
  return items;
}

async function plexSections(token: string, plexUrl: string, signal?: AbortSignal) {
  const response = await fetch(`${plexUrl}/library/sections`, {
    headers: { Accept: "application/json", "X-Plex-Token": token },
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`Plex library inventory returned HTTP ${response.status}`);
  const payload = await response.json() as { MediaContainer?: { Directory?: PlexSection[] } };
  return (payload.MediaContainer?.Directory ?? []).flatMap((section): Array<[string, "movie" | "show"]> => {
    if (!section.key || (section.type !== "movie" && section.type !== "show")) return [];
    return [[section.key, section.type]];
  });
}

async function queueInventory(batchDir: string) {
  let manifest: QueueManifest = {};
  let state: QueueState = {};
  try {
    manifest = JSON.parse(await readFile(join(batchDir, "manifest.json"), "utf8")) as QueueManifest;
    state = JSON.parse(await readFile(join(batchDir, "state.json"), "utf8")) as QueueState;
  } catch {
    return [];
  }
  return (manifest.items ?? []).flatMap((item): LibraryInventoryItem[] => {
    if (!item.id || !item.destination?.path || !["movie", "show"].includes(item.destination.type || "")) return [];
    const status = state.items?.[item.id]?.status || "pending";
    if (status === "failed" && !existsSync(item.destination.path)) return [];
    const destination = titleAndYear(basename(item.destination.path));
    const fallback = titleAndYear(item.title || "");
    const title = destination.title || fallback.title;
    if (!title) return [];
    return [{
      id: `queue-${item.id}`,
      title,
      year: destination.year ?? fallback.year,
      type: item.destination.type as "movie" | "show",
      source: "queue",
      status,
    }];
  });
}

export async function loadLibraryInventory(signal?: AbortSignal) {
  const plexUrl = (process.env.PLEX_URL || defaultPlexUrl).replace(/\/$/, "");
  const token = (process.env.PLEX_TOKEN || "").trim();
  const batchDir = process.env.BATCH_DIR || "/media/plex/.downloads/torrent-batch";
  const warnings: string[] = [];
  const queueItems = await queueInventory(batchDir);
  let plexItems: LibraryInventoryItem[] = [];
  if (!token) {
    warnings.push("PLEX_TOKEN is not configured, so Find with AI could only check the Torplex queue");
  } else {
    let sections: Array<[string, "movie" | "show"]>;
    try {
      sections = await plexSections(token, plexUrl, signal);
      if (!sections.length) throw new Error("Plex reported no movie or show libraries");
    } catch (error) {
      warnings.push(`${error instanceof Error ? error.message : String(error)}; using configured section IDs`);
      sections = [
        [process.env.PLEX_MOVIE_SECTION_ID || "1", "movie"],
        [process.env.PLEX_SHOW_SECTION_ID || "2", "show"],
      ];
    }
    const results = await Promise.allSettled(sections.map(([sectionId, type]) =>
      plexSectionInventory(sectionId, type, token, plexUrl, signal)
    ));
    for (const result of results) {
      if (result.status === "fulfilled") plexItems.push(...result.value);
      else warnings.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  const deduped = new Map<string, LibraryInventoryItem>();
  for (const item of [...plexItems, ...queueItems]) {
    const key = `${item.type}:${normalizeLibraryTitle(item.title)}:${item.year ?? ""}`;
    if (!deduped.has(key)) deduped.set(key, item);
  }
  return { items: [...deduped.values()], warnings };
}
