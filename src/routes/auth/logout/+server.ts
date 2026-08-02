import { redirect } from "@sveltejs/kit";
import { appOrigin, clearSession } from "$lib/server/auth";

export async function GET({ cookies, url }) {
  clearSession(cookies, appOrigin(url));
  throw redirect(303, "/auth/login");
}
