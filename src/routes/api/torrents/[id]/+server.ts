import { json } from "@sveltejs/kit";
import { removeTorrentItem } from "$lib/server/batch";
import { getSession } from "$lib/server/auth";

export async function DELETE({ cookies, params }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to manage torrents" }, { status: 401 });
  try {
    const id = decodeURIComponent(params.id);
    return json(await removeTorrentItem(id), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
