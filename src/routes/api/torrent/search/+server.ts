import { json } from "@sveltejs/kit";
import { normalizeQualityProfile } from "$lib/search-quality";
import { getSession } from "$lib/server/auth";
import { finishSearchJob, startSearchJob } from "$lib/server/search-jobs";
import {
  appendSearchProgress,
  cancelSearchSession,
  completeSearchSession,
  createSearchSession,
  failSearchSession,
  getLatestSearchSession,
  getSearchSession,
} from "$lib/server/search-sessions";
import { createTorrentSearchProposal } from "$lib/server/torrent-search";

export async function GET({ cookies, url }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to inspect a search" }, { status: 401 });
  const searchId = url.searchParams.get("searchId");
  const session = searchId ? await getSearchSession(searchId) : await getLatestSearchSession();
  if (!session) return json({ session: null }, { headers: { "cache-control": "no-store" } });
  return json({ session }, { headers: { "cache-control": "no-store" } });
}

export async function POST({ cookies, request }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to search" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: "Search request must be valid JSON" }, { status: 400 });
  }
  if (body.rightsConfirmed !== true) {
    return json({ error: "Confirm that you will search only for content you have the rights to download" }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const searchId = typeof body.searchId === "string" ? body.searchId : "";
  const qualityProfile = normalizeQualityProfile(body.qualityProfile);
  let searchController: AbortController | null = null;
  try {
    searchController = startSearchJob(searchId);
    await createSearchSession({ id: searchId, prompt, qualityProfile });
  } catch (error) {
    if (searchController) finishSearchJob(searchId, searchController);
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  const controller = searchController;

  void (async () => {
    let progressWrites = Promise.resolve();
    const progress = (message: string) => {
      progressWrites = progressWrites.then(() => appendSearchProgress(searchId, message)).then(() => undefined);
    };
    try {
      progress("Preparing a rights-gated catalog search");
      const proposal = await createTorrentSearchProposal(prompt, progress, controller.signal, qualityProfile);
      await progressWrites;
      await completeSearchSession(searchId, proposal);
    } catch (error) {
      await progressWrites.catch(() => {});
      if (controller.signal.aborted) {
        const session = await getSearchSession(searchId);
        if (session?.status === "running") await cancelSearchSession(searchId);
      } else {
        await failSearchSession(searchId, error instanceof Error ? error.message : String(error));
      }
    } finally {
      finishSearchJob(searchId, controller);
    }
  })();

  return json({ session: await getSearchSession(searchId) }, { status: 202 });
}
