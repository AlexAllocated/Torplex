import { json } from "@sveltejs/kit";
import { getSession } from "$lib/server/auth";
import { createTorrentSearchProposal } from "$lib/server/torrent-search";

export async function POST({ cookies, request }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to search" }, { status: 401 });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      void (async () => {
        try {
          const body = await request.json() as Record<string, unknown>;
          if (body.rightsConfirmed !== true) {
            throw new Error("Confirm that you will search only for content you have the rights to download");
          }
          const prompt = typeof body.prompt === "string" ? body.prompt : "";
          send({ type: "progress", message: "Preparing a rights-gated catalog search" });
          const proposal = await createTorrentSearchProposal(prompt, (message) => send({ type: "progress", message }));
          send({ type: "result", proposal });
        } catch (error) {
          send({ type: "error", error: error instanceof Error ? error.message : String(error) });
        } finally {
          controller.close();
        }
      })();
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
