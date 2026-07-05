import { json } from "@sveltejs/kit";
import { hasIntakeAccess, inspectTorrentUpload } from "$lib/server/batch";

export async function POST({ request, url }) {
  if (!hasIntakeAccess(request, url)) return json({ error: "Unauthorized" }, { status: 401 });
  try {
    return await inspectTorrentUpload(request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
