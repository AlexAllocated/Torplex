import { json } from "@sveltejs/kit";
import { getSession } from "$lib/server/auth";
import { createTorrentSearchProposal } from "$lib/server/torrent-search";
import { finishSearchJob, startSearchJob } from "$lib/server/search-jobs";

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
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const searchId = typeof body.searchId === "string" ? body.searchId : "";
  let searchController: AbortController;
  try {
    searchController = startSearchJob(searchId);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  const encoder = new TextEncoder();
  const abortSearch = () => searchController.abort();
  request.signal.addEventListener("abort", abortSearch, { once: true });
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: Record<string, unknown>) => {
        if (closed || searchController.signal.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      void (async () => {
        try {
          send({ type: "progress", message: "Preparing a rights-gated catalog search" });
          const proposal = await createTorrentSearchProposal(
            prompt,
            (message) => send({ type: "progress", message }),
            searchController.signal,
          );
          send({ type: "result", proposal });
        } catch (error) {
          if (!searchController.signal.aborted) {
            send({ type: "error", error: error instanceof Error ? error.message : String(error) });
          }
        } finally {
          finishSearchJob(searchId, searchController);
          request.signal.removeEventListener("abort", abortSearch);
          if (!closed) {
            closed = true;
            try { controller.close(); } catch { /* client disconnected */ }
          }
        }
      })();
    },
    cancel() {
      closed = true;
      abortSearch();
      finishSearchJob(searchId, searchController);
      request.signal.removeEventListener("abort", abortSearch);
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
