import { redirect } from "@sveltejs/kit";
import { clearSession } from "$lib/server/auth";

export async function GET({ cookies }) {
  clearSession(cookies);
  throw redirect(303, "/");
}
