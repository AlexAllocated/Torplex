import { redirect } from "@sveltejs/kit";
import { authConfig, authRequired, getSession } from "$lib/server/auth";

export function load({ cookies }) {
  if (authRequired() && authConfig().configured && !getSession(cookies)) {
    throw redirect(303, "/auth/login");
  }
}
