import { json } from "@sveltejs/kit";
import { getSession } from "$lib/server/auth";
import { appendSearchProgress, getSearchSession, updateSearchProposal } from "$lib/server/search-sessions";
import { retryTorrentSearchTarget } from "$lib/server/torrent-search";

export async function POST({ cookies, request }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to retry a search target" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const searchId = typeof body.searchId === "string" ? body.searchId : "";
  const targetId = typeof body.targetId === "string" ? body.targetId : "";
  const session = await getSearchSession(searchId);
  if (!session?.proposal) return json({ error: "The saved search proposal was not found" }, { status: 404 });
  if (!targetId) return json({ error: "Choose a search target to retry" }, { status: 400 });
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: Record<string, unknown>) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      void (async () => {
        let writes = Promise.resolve();
        const progress = (message: string) => {
          send({ type: "progress", message });
          writes = writes.then(() => appendSearchProgress(searchId, message)).then(() => undefined);
        };
        try {
          const proposal = await retryTorrentSearchTarget(session.proposal!, targetId, progress, request.signal);
          await writes;
          await updateSearchProposal(searchId, proposal);
          send({ type: "result", proposal });
        } catch (error) {
          if (!request.signal.aborted) send({ type: "error", error: error instanceof Error ? error.message : String(error) });
        } finally {
          closed = true;
          try { controller.close(); } catch { /* disconnected */ }
        }
      })();
    },
    cancel() { closed = true; },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}
