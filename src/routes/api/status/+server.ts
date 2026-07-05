import { json } from "@sveltejs/kit";
import { buildStatus } from "$lib/server/batch";

export async function GET() {
  return json(await buildStatus(), {
    headers: {
      "cache-control": "no-store",
    },
  });
}
