import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { seasonNumbersFromManifest } from "$lib/server/torrent-coverage";
import {
  assessPlexMediaQuality,
  assessSearchQuality,
  normalizeQualityProfile,
  type PlexMediaDescriptor,
  type SearchQualityProfile,
} from "$lib/search-quality";

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
  compatible?: boolean;
  compatibleSeasons?: number[];
  incompatibleReasons?: string[];
};

type PlexMedia = PlexMediaDescriptor & {
  Part?: Array<{ file?: string; container?: string; videoProfile?: string }>;
};

type PlexMetadata = {
  ratingKey?: string;
  title?: string;
  year?: number;
  index?: number;
  type?: string;
  parentIndex?: number;
  Media?: PlexMedia[];
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
  if (work.type !== "show" || !work.requiredSeasons?.length) {
    return matches.find((item) => item.compatible !== false);
  }
  const covered = new Set(matches.flatMap((item) => item.compatibleSeasons ?? item.seasons ?? []));
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
    return item.compatibleSeasons ?? item.seasons ?? [];
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

function mediaDescriptors(entry: PlexMetadata) {
  return (entry.Media ?? []).map((media): PlexMediaDescriptor => ({
    ...media,
    file: media.Part?.[0]?.file,
    container: media.container || media.Part?.[0]?.container,
    videoProfile: media.videoProfile || media.Part?.[0]?.videoProfile,
  }));
}

function plexMediaCompatibility(entry: PlexMetadata, profile: SearchQualityProfile) {
  const assessments = mediaDescriptors(entry).map((media) => assessPlexMediaQuality(profile, media));
  const compatible = assessments.some((assessment) => assessment.allowed);
  const reasons = compatible
    ? []
    : [...new Set(assessments.flatMap((assessment) => assessment.violations))];
  return {
    compatible,
    reasons: reasons.length ? reasons : ["Plex did not report a verifiable video stream"],
  };
}

async function plexShowMediaInventory(
  ratingKey: string,
  token: string,
  plexUrl: string,
  profile: SearchQualityProfile,
  signal?: AbortSignal,
) {
  const episodes: PlexMetadata[] = [];
  for (let start = 0; start < maximumItems; start += pageSize) {
    const url = new URL(`${plexUrl}/library/metadata/${encodeURIComponent(ratingKey)}/allLeaves`);
    url.searchParams.set("includeMedia", "1");
    url.searchParams.set("X-Plex-Container-Start", String(start));
    url.searchParams.set("X-Plex-Container-Size", String(pageSize));
    const response = await fetch(url, {
      headers: { Accept: "application/json", "X-Plex-Token": token },
      signal: requestSignal(signal),
    });
    if (!response.ok) throw new Error(`Plex episode inventory returned HTTP ${response.status}`);
    const payload = await response.json() as {
      MediaContainer?: { Metadata?: PlexMetadata[]; totalSize?: number };
    };
    const page = payload.MediaContainer?.Metadata ?? [];
    episodes.push(...page);
    const totalSize = payload.MediaContainer?.totalSize;
    if (page.length < pageSize || (typeof totalSize === "number" && start + page.length >= totalSize)) break;
  }
  const bySeason = new Map<number, PlexMetadata[]>();
  for (const episode of episodes) {
    const season = Number(episode.parentIndex);
    if (!Number.isInteger(season) || season <= 0) continue;
    bySeason.set(season, [...(bySeason.get(season) ?? []), episode]);
  }
  const seasons = [...bySeason.keys()].sort((left, right) => left - right);
  const compatibleSeasons: number[] = [];
  const incompatibleReasons = new Set<string>();
  for (const season of seasons) {
    const assessments = bySeason.get(season)!.map((episode) => plexMediaCompatibility(episode, profile));
    if (assessments.length && assessments.every((assessment) => assessment.compatible)) compatibleSeasons.push(season);
    else for (const reason of assessments.flatMap((assessment) => assessment.reasons)) incompatibleReasons.add(reason);
  }
  return { seasons, compatibleSeasons, incompatibleReasons: [...incompatibleReasons] };
}

async function plexSectionInventory(
  sectionId: string,
  type: "movie" | "show",
  token: string,
  plexUrl: string,
  profile: SearchQualityProfile,
  signal?: AbortSignal,
) {
  const items: Array<{ item: LibraryInventoryItem; ratingKey: string }> = [];
  const metadataType = type === "movie" ? "1" : "2";
  for (let start = 0; start < maximumItems; start += pageSize) {
    const url = new URL(`${plexUrl}/library/sections/${encodeURIComponent(sectionId)}/all`);
    url.searchParams.set("type", metadataType);
    url.searchParams.set("X-Plex-Container-Start", String(start));
    url.searchParams.set("X-Plex-Container-Size", String(pageSize));
    url.searchParams.set("includeMedia", "1");
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
          ...(type === "movie" ? (() => {
            const assessment = plexMediaCompatibility(entry, profile);
            return {
              compatible: assessment.compatible,
              incompatibleReasons: assessment.reasons,
              status: assessment.compatible ? "in library" : "in library; direct-play replacement needed",
            };
          })() : {}),
        },
      });
    }
    const totalSize = payload.MediaContainer?.totalSize;
    if (metadata.length < pageSize || (typeof totalSize === "number" && start + metadata.length >= totalSize)) break;
  }
  if (type === "movie") return items.map((entry) => entry.item);
  return mapWithConcurrency(items, 6, async ({ item, ratingKey }) => {
    try {
      const media = await plexShowMediaInventory(ratingKey, token, plexUrl, profile, signal);
      return {
        ...item,
        ...media,
        compatible: media.seasons.length > 0 && media.compatibleSeasons.length === media.seasons.length,
        status: media.seasons.length > 0 && media.compatibleSeasons.length === media.seasons.length
          ? "in library"
          : "in library; direct-play replacement needed",
      };
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

async function queueInventory(batchDir: string, profile: SearchQualityProfile) {
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
    const seasons = item.destination.type === "show"
      ? seasonNumbersFromManifest(`${item.title || ""} ${item.payloadName || ""} ${item.destination.path}`, item.selectedPaths || [])
        .filter((season) => season > 0)
      : [];
    const quality = assessSearchQuality(
      profile,
      `${item.title || ""} ${item.payloadName || ""} ${(item.selectedPaths || []).join(" ")}`,
      0,
    );
    return [{
      id: `queue-${item.id}`,
      title,
      year: destination.year ?? fallback.year,
      type: item.destination.type as "movie" | "show",
      source: "queue",
      status,
      seasons,
      compatible: quality.allowed,
      compatibleSeasons: quality.allowed ? seasons : [],
      incompatibleReasons: quality.violations,
    }];
  });
}

export async function loadLibraryInventory(signal?: AbortSignal, qualityInput?: unknown) {
  const qualityProfile = normalizeQualityProfile(qualityInput);
  const plexUrl = (process.env.PLEX_URL || defaultPlexUrl).replace(/\/$/, "");
  const token = (process.env.PLEX_TOKEN || "").trim();
  const batchDir = process.env.BATCH_DIR || "/media/plex/.downloads/torrent-batch";
  const warnings: string[] = [];
  const queueItems = await queueInventory(batchDir, qualityProfile);
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
      plexSectionInventory(sectionId, type, token, plexUrl, qualityProfile, signal)
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
    const compatibleSeasons = [...new Set([
      ...(existing.compatibleSeasons ?? (existing.compatible === false ? [] : existing.seasons || [])),
      ...(item.compatibleSeasons ?? (item.compatible === false ? [] : item.seasons || [])),
    ])].sort((left, right) => left - right);
    const preferred = item.source === "plex" && existing.source !== "plex" ? item : existing;
    const compatible = existing.type === "movie"
      ? existing.compatible !== false || item.compatible !== false
      : seasons.length > 0 && compatibleSeasons.length === seasons.length;
    deduped.set(key, {
      ...preferred,
      seasons,
      compatible,
      compatibleSeasons,
      incompatibleReasons: compatible ? [] : [...new Set([
        ...(existing.incompatibleReasons || []),
        ...(item.incompatibleReasons || []),
      ])],
      status: compatible ? preferred.status.replace(/; direct-play replacement needed$/, "") : "in library; direct-play replacement needed",
    });
  }
  return { items: [...deduped.values()], warnings };
}
