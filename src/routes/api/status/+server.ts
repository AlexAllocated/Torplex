import { json } from "@sveltejs/kit";
import { dashboardAccess } from "$lib/server/auth";
import { buildStatus } from "$lib/server/batch";

export async function GET({ cookies }) {
  const access = dashboardAccess(cookies);
  if (!access.ok) return json({ error: access.error }, { status: access.status });
  return json(await buildStatus(), {
    headers: {
      "cache-control": "no-store",
    },
  });
}
