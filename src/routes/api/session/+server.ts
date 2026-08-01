import { json } from "@sveltejs/kit";
import { authConfig, getSession } from "$lib/server/auth";
import { torrentSearchConfig } from "$lib/server/torrent-search";

export async function GET({ cookies }) {
  const user = getSession(cookies);
  return json(
    {
      ...authConfig(),
      authenticated: Boolean(user),
      user,
      loginUrl: "/auth/login",
      logoutUrl: "/auth/logout",
      torrentSearch: torrentSearchConfig(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
