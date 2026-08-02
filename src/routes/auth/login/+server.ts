import { json, redirect } from "@sveltejs/kit";
import { appOrigin, authConfig, setSession, verifyPassword } from "$lib/server/auth";

function loginPage(message = "") {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Torplex Login</title>
    <style>
      @font-face { font-family: "BigBlue TerminalPlus"; src: url("/fonts/big-blue-terminal/BigBlue_TerminalPlus.ttf") format("truetype"); font-display: swap; }
      :root { color-scheme: dark; font-family: "BigBlue TerminalPlus", ui-monospace, monospace; background: #000b06; color: #bbf7d0; }
      * { box-sizing: border-box; letter-spacing: 0; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; overflow: hidden; color: #bbf7d0; background: radial-gradient(ellipse at center, rgba(3,24,13,.96), #000b06 72%); text-shadow: 0 0 4px rgba(134,239,172,.42), 0 0 11px rgba(34,197,94,.18); }
      body::before, body::after { position: fixed; inset: 0; z-index: 3; content: ""; pointer-events: none; }
      body::before { opacity: .62; background: repeating-linear-gradient(to bottom, rgba(187,247,208,.028) 0, rgba(187,247,208,.028) 1px, transparent 1px, transparent 3px, rgba(0,0,0,.22) 3px, rgba(0,0,0,.22) 5px); background-size: 100% 5px; animation: scan 1.6s linear infinite; }
      body::after { background: radial-gradient(ellipse at center, transparent 46%, rgba(0,0,0,.5) 100%); box-shadow: inset 0 0 72px rgba(0,0,0,.5); }
      form { position: relative; width: min(430px, calc(100vw - 32px)); display: grid; gap: 14px; padding: 22px; border: 1px solid rgba(74,222,128,.34); border-radius: 2px; background: rgba(3,24,13,.82); box-shadow: inset 0 0 12px rgba(74,222,128,.055), 0 0 10px rgba(34,197,94,.08); }
      form::before { content: "> AUTH_GATE / TORPLEX"; color: rgba(134,239,172,.7); font-size: 11px; }
      h1 { margin: 0; color: #dcfce7; font-size: 30px; line-height: 1; text-shadow: 0 0 6px rgba(134,239,172,.72); }
      p { margin: 0; color: rgba(134,239,172,.66); }
      label { color: #86efac; font-size: 12px; text-transform: uppercase; }
      input, button { min-height: 42px; border-radius: 2px; font: inherit; }
      input { border: 1px solid rgba(74,222,128,.34); padding: 8px 10px; color: #bbf7d0; caret-color: #dcfce7; background: rgba(0,11,6,.88); outline: 0; }
      input:focus { border-color: rgba(134,239,172,.78); box-shadow: 0 0 12px rgba(34,197,94,.2); }
      button { border: 1px solid rgba(134,239,172,.62); color: #dcfce7; background: rgba(34,197,94,.18); cursor: pointer; }
      button:hover { background: rgba(34,197,94,.32); box-shadow: 0 0 10px rgba(74,222,128,.26); }
      .error { min-height: 20px; color: #dcfce7; font-size: 13px; }
      @keyframes scan { from { background-position: 0 0; } to { background-position: 0 5px; } }
      @media (prefers-reduced-motion: reduce) { body::before { animation: none; } }
    </style>
  </head>
  <body>
    <form id="login-form" method="post" action="/auth/login">
      <h1>Torplex</h1>
      <p>Enter the server password to continue.</p>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
      <button type="submit">Unlock</button>
      <div id="login-error" class="error">${message}</div>
    </form>
    <script>
      const form = document.getElementById("login-form");
      const error = document.getElementById("login-error");
      const button = form.querySelector("button");

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        error.textContent = "";

        try {
          const response = await fetch("/auth/login", {
            method: "POST",
            headers: {
              "accept": "application/json",
              "content-type": "application/json"
            },
            body: JSON.stringify({ password: form.elements.password.value })
          });
          const result = await response.json();
          if (!response.ok) {
            error.textContent = result.error || "Unable to sign in";
            return;
          }
          window.location.assign("/");
        } catch {
          error.textContent = "Unable to reach Torplex";
        } finally {
          button.disabled = false;
        }
      });
    </script>
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
  const isJson = request.headers.get("content-type")?.includes("application/json");
  const password = isJson
    ? String(((await request.json()) as { password?: unknown }).password || "")
    : String((await request.formData()).get("password") || "");
  if (!verifyPassword(password)) {
    if (isJson) {
      return json({ error: "Incorrect password" }, { status: 401 });
    }
    return new Response(loginPage("Incorrect password"), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  setSession(cookies, origin);
  if (isJson) {
    return json({ ok: true });
  }
  throw redirect(303, "/");
}
