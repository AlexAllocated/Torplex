import type { Cookies } from "@sveltejs/kit";
import { createHmac, timingSafeEqual } from "node:crypto";

export type SessionUser = {
  name: string;
};

const sessionCookie = "plex_batch_session";
const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;

function secret() {
  return process.env.AUTH_COOKIE_SECRET || process.env.AUTH_PASSWORD || "dev-only-change-me";
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieOptions(origin: string) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: origin.startsWith("https://"),
  };
}

export function appOrigin(url: URL) {
  return (process.env.APP_ORIGIN || url.origin).replace(/\/$/, "");
}

export function authConfig() {
  return {
    configured: Boolean(process.env.AUTH_PASSWORD),
    required: authRequired(),
  };
}

export function authRequired() {
  return !["0", "false", "no", "off"].includes((process.env.AUTH_REQUIRED ?? "true").trim().toLowerCase());
}

export function dashboardAccess(cookies: Cookies) {
  if (!authRequired()) return { ok: true as const, user: null };
  const user = getSession(cookies);
  if (user) return { ok: true as const, user };
  const configured = authConfig().configured;
  return {
    ok: false as const,
    status: configured ? 401 : 503,
    error: configured ? "Sign in to view Torplex" : "AUTH_PASSWORD is not configured",
  };
}

export function setSession(cookies: Cookies, origin: string) {
  const payload = base64Url(
    JSON.stringify({
      name: "Torplex",
      exp: Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds,
    }),
  );
  cookies.set(sessionCookie, `${payload}.${sign(payload)}`, {
    ...cookieOptions(origin),
    maxAge: sessionMaxAgeSeconds,
  });
}

export function clearSession(cookies: Cookies) {
  cookies.delete(sessionCookie, { path: "/" });
}

export function getSession(cookies: Cookies): SessionUser | null {
  const raw = cookies.get(sessionCookie);
  if (!raw) return null;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionUser & { exp?: number };
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      name: decoded.name || "Torplex",
    };
  } catch {
    return null;
  }
}

export function verifyPassword(password: string) {
  const expected = process.env.AUTH_PASSWORD || "";
  return Boolean(expected) && safeEqual(password, expected);
}
