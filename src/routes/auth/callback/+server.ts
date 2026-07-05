import { error, redirect } from "@sveltejs/kit";
import { appOrigin, consumeStateCookie, exchangeGoogleCode, setSession } from "$lib/server/auth";

export async function GET({ cookies, url }) {
  const origin = appOrigin(url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const oauthError = url.searchParams.get("error");

  if (oauthError) throw error(400, oauthError);
  if (!code) throw error(400, "Missing Google authorization code");
  if (!consumeStateCookie(cookies, state)) throw error(400, "Invalid login state");

  const user = await exchangeGoogleCode(code, `${origin}/auth/callback`);
  setSession(cookies, origin, user);
  throw redirect(303, "/");
}
