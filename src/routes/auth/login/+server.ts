import { json, redirect } from "@sveltejs/kit";
import { appOrigin, authConfig, setSession, verifyPassword } from "$lib/server/auth";

export async function POST({ cookies, request, url }) {
  const origin = appOrigin(url);
  if (!authConfig().configured) {
    throw redirect(303, "/?auth=missing_config");
  }
  const isJson = request.headers.get("content-type")?.includes("application/json");
  const password = isJson
    ? String(((await request.json()) as { password?: unknown }).password || "")
    : String((await request.formData()).get("password") || "");
  if (!verifyPassword(password)) {
    return isJson
      ? json({ error: "Incorrect password" }, { status: 401 })
      : new Response("Incorrect password", { status: 401 });
  }

  setSession(cookies, origin);
  if (isJson) return json({ ok: true });
  throw redirect(303, "/");
}
