import { json } from "@sveltejs/kit";
import { getSession } from "$lib/server/auth";
import { reorderPendingItems } from "$lib/server/batch";

export async function POST({ cookies, request }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to manage torrents" }, { status: 401 });
  try {
    const body = await request.json();
    return json(await reorderPendingItems(body?.ids), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
