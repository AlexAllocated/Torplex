import { json } from "@sveltejs/kit";
import { addTorrentBatch } from "$lib/server/batch";
import { getSession } from "$lib/server/auth";

export async function POST({ cookies, request }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to add torrents" }, { status: 401 });
  try {
    return await addTorrentBatch(request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
