import { json } from "@sveltejs/kit";
import { getSession } from "$lib/server/auth";
import { cancelSearchJob } from "$lib/server/search-jobs";
import { cancelSearchSession, getSearchSession } from "$lib/server/search-sessions";

export async function POST({ cookies, request }) {
  if (!getSession(cookies)) return json({ error: "Unlock Torplex to cancel a search" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const searchId = typeof body.searchId === "string" ? body.searchId : "";
  const cancelled = cancelSearchJob(searchId);
  const session = await getSearchSession(searchId);
  if (session?.status === "running") await cancelSearchSession(searchId);
  return json({ cancelled, session: await getSearchSession(searchId) });
}
