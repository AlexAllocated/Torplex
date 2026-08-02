import { json } from "@sveltejs/kit";
import { getSession } from "$lib/server/auth";
import { cancelSearchJob } from "$lib/server/search-jobs";

export async function POST({ cookies, request }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to cancel a search" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const searchId = typeof body.searchId === "string" ? body.searchId : "";
  return json({ cancelled: cancelSearchJob(searchId) });
}
