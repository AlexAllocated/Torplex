import { redirect } from "@sveltejs/kit";
import { authConfig } from "$lib/server/auth";

export function load() {
  if (!authConfig().configured) throw redirect(303, "/?auth=missing_config");
}
