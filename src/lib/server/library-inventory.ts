import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { seasonNumbersFromManifest } from "$lib/server/torrent-coverage";

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
  seasons: number[];
};

type PlexMetadata = {
  ratingKey?: string;
  title?: string;
  year?: number;
  index?: number;
  type?: string;
};

type PlexSection = {
  key?: string;
  type?: string;
};

type QueueManifest = {
  items?: Array<{
    id?: string;
    title?: string;
    payloadName?: string;
    selectedPaths?: string[];
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
  work: { title: string; year: number | null; type: "movie" | "show"; requiredSeasons?: number[] },
  inventory: LibraryInventoryItem[],
) {
  const title = normalizeLibraryTitle(work.title);
  const matches = inventory.filter((item) => {
    if (item.type !== work.type || normalizeLibraryTitle(item.title) !== title) return false;
    if (work.year !== null) return item.year === work.year;
    return true;
  });
  if (work.type !== "show" || !work.requiredSeasons?.length) return matches[0];
  const covered = new Set(matches.flatMap((item) => item.seasons || []));
  return work.requiredSeasons.every((season) => covered.has(season)) ? matches[0] : undefined;
}

export function missingLibrarySeasons(
  work: { title: string; year: number | null; type: "movie" | "show"; requiredSeasons: number[] },
  inventory: LibraryInventoryItem[],
) {
  if (work.type !== "show" || !work.requiredSeasons.length) return work.requiredSeasons;
  const title = normalizeLibraryTitle(work.title);
  const covered = new Set(inventory.flatMap((item) => {
    if (item.type !== "show" || normalizeLibraryTitle(item.title) !== title) return [];
    if (work.year !== null && item.year !== work.year) return [];
    return item.seasons || [];
  }));
  return work.requiredSeasons.filter((season) => !covered.has(season));
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, callback: (value: T) => Promise<R>) {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await callback(values[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

async function plexShowSeasons(ratingKey: string, token: string, plexUrl: string, signal?: AbortSignal) {
  const response = await fetch(`${plexUrl}/library/metadata/${encodeURIComponent(ratingKey)}/children`, {
    headers: { Accept: "application/json", "X-Plex-Token": token },
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`Plex season inventory returned HTTP ${response.status}`);
  const payload = await response.json() as { MediaContainer?: { Metadata?: PlexMetadata[] } };
  return [...new Set((payload.MediaContainer?.Metadata ?? [])
    .filter((entry) => entry.type === "season" && Number.isInteger(entry.index) && entry.index! > 0)
    .map((entry) => entry.index!))]
    .sort((left, right) => left - right);
}

async function plexSectionInventory(
  sectionId: string,
  type: "movie" | "show",
  token: string,
  plexUrl: string,
  signal?: AbortSignal,
) {
  const items: Array<{ item: LibraryInventoryItem; ratingKey: string }> = [];
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
        ratingKey: entry.ratingKey || `${start + items.length}`,
        item: {
          id: `plex-${type}-${entry.ratingKey || `${start + items.length}`}`,
          title: entry.title,
          year: Number.isInteger(entry.year) ? entry.year! : null,
          type,
          source: "plex",
          status: "in library",
          seasons: [],
        },
      });
    }
    const totalSize = payload.MediaContainer?.totalSize;
    if (metadata.length < pageSize || (typeof totalSize === "number" && start + metadata.length >= totalSize)) break;
  }
  if (type === "movie") return items.map((entry) => entry.item);
  return mapWithConcurrency(items, 6, async ({ item, ratingKey }) => {
    try {
      return { ...item, seasons: await plexShowSeasons(ratingKey, token, plexUrl, signal) };
    } catch {
      return item;
    }
  });
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
    const destinationBase = basename(item.destination.path);
    const showRoot = item.destination.type === "show" && /^Season\s+\d+$/i.test(destinationBase)
      ? basename(dirname(item.destination.path))
      : destinationBase;
    const destination = titleAndYear(showRoot);
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
      seasons: item.destination.type === "show"
        ? seasonNumbersFromManifest(`${item.title || ""} ${item.payloadName || ""} ${item.destination.path}`, item.selectedPaths || [])
          .filter((season) => season > 0)
        : [],
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
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, item);
      continue;
    }
    const seasons = [...new Set([...(existing.seasons || []), ...(item.seasons || [])])].sort((left, right) => left - right);
    if (item.source === "plex" && existing.source !== "plex") deduped.set(key, { ...item, seasons });
    else deduped.set(key, { ...existing, seasons });
  }
  return { items: [...deduped.values()], warnings };
}
