import { json } from "@sveltejs/kit";
import { getSession } from "$lib/server/auth";
import { getSearchSession, subscribeSearchSession } from "$lib/server/search-sessions";

export async function GET({ cookies, url, request }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to inspect a search" }, { status: 401 });
  const searchId = url.searchParams.get("searchId") || "";
  const initial = await getSearchSession(searchId);
  if (!initial) return json({ error: "Search session was not found" }, { status: 404 });
  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (session: typeof initial) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify({ type: "session", session })}\n`)); } catch { closed = true; }
        if (session.status !== "running" && !closed) {
          closed = true;
          unsubscribe();
          try { controller.close(); } catch { /* disconnected */ }
        }
      };
      unsubscribe = subscribeSearchSession(searchId, send);
      send(initial);
      request.signal.addEventListener("abort", () => {
        closed = true;
        unsubscribe();
      }, { once: true });
    },
    cancel() {
      closed = true;
      unsubscribe();
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
