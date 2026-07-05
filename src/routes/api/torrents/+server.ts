import { json } from "@sveltejs/kit";
import { addTorrentUpload } from "$lib/server/batch";
import { getSession } from "$lib/server/auth";

export async function POST({ cookies, request }) {
  if (!getSession(cookies)) return json({ error: "Sign in with Google to upload torrents" }, { status: 401 });
  try {
    return await addTorrentUpload(request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
