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

      :root, :root[data-crt-theme="green"] {
        --phosphor-screen: 3 24 13; --phosphor-black: 0 11 6; --phosphor-shadow: 20 83 45;
        --phosphor-deep: 34 197 94; --phosphor-main: 74 222 128; --phosphor-soft: 134 239 172;
        --phosphor-text: 187 247 208; --phosphor-bright: 220 252 231;
      }
      :root[data-crt-theme="red"] {
        --phosphor-screen: 28 6 6; --phosphor-black: 12 0 0; --phosphor-shadow: 100 20 20;
        --phosphor-deep: 220 38 38; --phosphor-main: 248 72 72; --phosphor-soft: 252 165 165;
        --phosphor-text: 254 202 202; --phosphor-bright: 254 226 226;
      }
      :root[data-crt-theme="orange"] {
        --phosphor-screen: 28 13 3; --phosphor-black: 12 5 0; --phosphor-shadow: 110 46 12;
        --phosphor-deep: 234 88 12; --phosphor-main: 251 146 60; --phosphor-soft: 253 186 116;
        --phosphor-text: 254 215 170; --phosphor-bright: 255 237 213;
      }
      :root[data-crt-theme="yellow"] {
        --phosphor-screen: 26 22 3; --phosphor-black: 11 9 0; --phosphor-shadow: 100 78 10;
        --phosphor-deep: 202 138 4; --phosphor-main: 250 204 21; --phosphor-soft: 253 224 71;
        --phosphor-text: 254 240 138; --phosphor-bright: 254 249 195;
      }
      :root[data-crt-theme="blue"] {
        --phosphor-screen: 3 12 28; --phosphor-black: 0 4 12; --phosphor-shadow: 15 52 110;
        --phosphor-deep: 37 99 235; --phosphor-main: 59 130 246; --phosphor-soft: 147 197 253;
        --phosphor-text: 191 219 254; --phosphor-bright: 219 234 254;
      }
      :root[data-crt-theme="purple"] {
        --phosphor-screen: 18 5 28; --phosphor-black: 7 0 12; --phosphor-shadow: 70 20 105;
        --phosphor-deep: 126 34 206; --phosphor-main: 168 85 247; --phosphor-soft: 216 180 254;
        --phosphor-text: 233 213 255; --phosphor-bright: 243 232 255;
      }
      body {
        color: rgb(var(--phosphor-text));
        background: radial-gradient(ellipse at center, rgb(var(--phosphor-screen) / .96), rgb(var(--phosphor-black)) 72%);
        text-shadow: 0 0 4px rgb(var(--phosphor-soft) / .42), 0 0 11px rgb(var(--phosphor-deep) / .18);
      }
      body::before { background: repeating-linear-gradient(to bottom, rgb(var(--phosphor-text) / .028) 0, rgb(var(--phosphor-text) / .028) 1px, transparent 1px, transparent 3px, rgb(0 0 0 / .22) 3px, rgb(0 0 0 / .22) 5px); }
      form { border-color: rgb(var(--phosphor-main) / .34); background: rgb(var(--phosphor-screen) / .82); box-shadow: inset 0 0 12px rgb(var(--phosphor-main) / .055), 0 0 10px rgb(var(--phosphor-deep) / .08); }
      form::before, p { color: rgb(var(--phosphor-soft) / .7); }
      h1, .error { color: rgb(var(--phosphor-bright)); }
      h1 { text-shadow: 0 0 6px rgb(var(--phosphor-soft) / .72); }
      label { color: rgb(var(--phosphor-soft)); }
      input { border-color: rgb(var(--phosphor-main) / .34); color: rgb(var(--phosphor-text)); caret-color: rgb(var(--phosphor-bright)); background: rgb(var(--phosphor-black) / .88); }
      input:focus { border-color: rgb(var(--phosphor-soft) / .78); box-shadow: 0 0 12px rgb(var(--phosphor-deep) / .2); }
      button { border-color: rgb(var(--phosphor-soft) / .62); color: rgb(var(--phosphor-bright)); background: rgb(var(--phosphor-deep) / .18); }
      button:hover { background: rgb(var(--phosphor-deep) / .32); box-shadow: 0 0 10px rgb(var(--phosphor-main) / .26); }
      .theme-switcher { position: fixed; top: 14px; left: 50%; z-index: 4; display: flex; gap: 12px; transform: translateX(-50%); }
      .theme-dot { width: 16px; height: 16px; min-height: 0; padding: 0; border: 1px solid rgb(255 255 255 / .46); border-radius: 50%; background: var(--theme-swatch); box-shadow: 0 0 8px color-mix(in srgb, var(--theme-swatch), transparent 50%); }
      .theme-dot:hover { background: var(--theme-swatch); scale: 1.18; }
      .theme-dot[aria-pressed="true"] { outline: 2px solid rgb(var(--phosphor-bright) / .92); outline-offset: 3px; }
      .theme-dot[data-theme="red"] { --theme-swatch: #f84848; }
      .theme-dot[data-theme="orange"] { --theme-swatch: #fb923c; }
      .theme-dot[data-theme="yellow"] { --theme-swatch: #facc15; }
      .theme-dot[data-theme="green"] { --theme-swatch: #4ade80; }
      .theme-dot[data-theme="blue"] { --theme-swatch: #3b82f6; }
      .theme-dot[data-theme="purple"] { --theme-swatch: #a855f7; }
    </style>
  </head>
  <body>
    <div class="theme-switcher" role="group" aria-label="Terminal phosphor color">
      <button class="theme-dot" type="button" data-theme="red" aria-label="Red phosphor"></button>
      <button class="theme-dot" type="button" data-theme="orange" aria-label="Orange phosphor"></button>
      <button class="theme-dot" type="button" data-theme="yellow" aria-label="Yellow phosphor"></button>
      <button class="theme-dot" type="button" data-theme="green" aria-label="Green phosphor"></button>
      <button class="theme-dot" type="button" data-theme="blue" aria-label="Blue phosphor"></button>
      <button class="theme-dot" type="button" data-theme="purple" aria-label="Purple phosphor"></button>
    </div>
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
      const themes = new Set(["red", "orange", "yellow", "green", "blue", "purple"]);
      const themeButtons = Array.from(document.querySelectorAll(".theme-dot"));
      const applyTheme = (theme) => {
        const selected = themes.has(theme) ? theme : "green";
        document.documentElement.dataset.crtTheme = selected;
        localStorage.setItem("torplex:crt-theme", selected);
        themeButtons.forEach((themeButton) => {
          themeButton.setAttribute("aria-pressed", String(themeButton.dataset.theme === selected));
        });
      };
      applyTheme(localStorage.getItem("torplex:crt-theme"));
      themeButtons.forEach((themeButton) => {
        themeButton.addEventListener("click", () => applyTheme(themeButton.dataset.theme));
      });

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
