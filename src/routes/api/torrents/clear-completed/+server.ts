import { json } from "@sveltejs/kit";
import { clearCompletedItems } from "$lib/server/batch";
import { getSession } from "$lib/server/auth";

export async function POST({ cookies }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to manage torrents" }, { status: 401 });
  try {
    return json(await clearCompletedItems(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
