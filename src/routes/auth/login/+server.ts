import { redirect } from "@sveltejs/kit";
import { appOrigin, authConfig, setSession, verifyPassword } from "$lib/server/auth";

function loginPage(message = "") {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Torplex Login</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; color: #e7edf5; background: radial-gradient(circle at 50% -10%, rgba(87,224,194,.22), transparent 42%), #0c1017; }
      form { width: min(380px, calc(100vw - 32px)); display: grid; gap: 14px; padding: 22px; border: 1px solid rgba(150,167,190,.22); border-radius: 8px; background: rgba(19,25,35,.90); box-shadow: 0 16px 42px rgba(0,0,0,.28); }
      h1 { margin: 0; font-size: 28px; line-height: 1; }
      p { margin: 0; color: #95a3b7; }
      label { color: #95a3b7; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      input, button { min-height: 42px; border-radius: 8px; font: inherit; }
      input { border: 1px solid rgba(150,167,190,.26); padding: 8px 10px; color: #e7edf5; background: rgba(5,10,16,.74); }
      button { border: 1px solid rgba(87,224,194,.50); color: #d9fff6; background: rgba(87,224,194,.14); font-weight: 850; cursor: pointer; }
      .error { min-height: 20px; color: #f47086; font-size: 13px; }
    </style>
  </head>
  <body>
    <form method="post" action="/auth/login">
      <h1>Torplex</h1>
      <p>Enter the server password to continue.</p>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
      <button type="submit">Unlock</button>
      <div class="error">${message}</div>
    </form>
  </body>
</html>`;
}

export async function GET() {
  if (!authConfig().configured) {
    throw redirect(303, "/?auth=missing_config");
  }
  return new Response(loginPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function POST({ cookies, request, url }) {
  const origin = appOrigin(url);
  if (!authConfig().configured) {
    throw redirect(303, "/?auth=missing_config");
  }
  const form = await request.formData();
  const password = String(form.get("password") || "");
  if (!verifyPassword(password)) {
    return new Response(loginPage("Incorrect password"), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  setSession(cookies, origin);
  throw redirect(303, "/");
}
