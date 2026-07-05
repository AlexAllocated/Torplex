import { redirect } from "@sveltejs/kit";
import { appOrigin, authConfig, createStateCookie } from "$lib/server/auth";

export async function GET({ cookies, url }) {
  const origin = appOrigin(url);
  if (!authConfig().configured) {
    throw redirect(303, "/?auth=missing_config");
  }

  const state = createStateCookie(cookies, origin);
  const redirectUri = `${origin}/auth/callback`;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });

  throw redirect(303, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
