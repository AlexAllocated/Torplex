import { json } from "@sveltejs/kit";
import { authConfig, getSession } from "$lib/server/auth";

export async function GET({ cookies }) {
  const user = getSession(cookies);
  return json(
    {
      ...authConfig(),
      authenticated: Boolean(user),
      user,
      loginUrl: "/auth/login",
      logoutUrl: "/auth/logout",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
