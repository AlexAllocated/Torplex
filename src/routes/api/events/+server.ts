import { dashboardAccess } from "$lib/server/auth";
import { statusStream } from "$lib/server/batch";

export async function GET({ cookies }) {
  const access = dashboardAccess(cookies);
  if (!access.ok) return new Response(access.error, { status: access.status });
  return new Response(statusStream(), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
