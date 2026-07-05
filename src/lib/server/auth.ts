import type { Cookies } from "@sveltejs/kit";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SessionUser = {
  email: string;
  name?: string;
  picture?: string;
};

const sessionCookie = "plex_batch_session";
const oauthStateCookie = "plex_oauth_state";
const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;
const allowedEmails = new Set(
  (process.env.AUTH_ALLOWED_EMAILS ?? "alex@hivetech.ai")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

function secret() {
  return process.env.AUTH_COOKIE_SECRET || "dev-only-change-me";
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
    configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    allowedEmails: [...allowedEmails],
  };
}

export function isAllowedEmail(email: string) {
  return allowedEmails.has(email.trim().toLowerCase());
}

export function createStateCookie(cookies: Cookies, origin: string) {
  const state = randomBytes(24).toString("base64url");
  cookies.set(oauthStateCookie, state, {
    ...cookieOptions(origin),
    maxAge: 10 * 60,
  });
  return state;
}

export function consumeStateCookie(cookies: Cookies, state: string) {
  const expected = cookies.get(oauthStateCookie) || "";
  cookies.delete(oauthStateCookie, { path: "/" });
  return expected && state && safeEqual(expected, state);
}

export function setSession(cookies: Cookies, origin: string, user: SessionUser) {
  const payload = base64Url(
    JSON.stringify({
      email: user.email,
      name: user.name,
      picture: user.picture,
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
    if (!decoded.email || !decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    if (!isAllowedEmail(decoded.email)) return null;
    return {
      email: decoded.email,
      name: decoded.name,
      picture: decoded.picture,
    };
  } catch {
    return null;
  }
}

export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<SessionUser> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google auth is not configured");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
  if (!tokenResponse.ok || typeof tokenPayload.access_token !== "string") {
    throw new Error(String(tokenPayload.error_description || tokenPayload.error || "Google token exchange failed"));
  }

  const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
    },
  });
  const userPayload = (await userResponse.json()) as Record<string, unknown>;
  if (!userResponse.ok) throw new Error("Google user lookup failed");

  const email = String(userPayload.email || "");
  if (userPayload.email_verified !== true) throw new Error("Google account email is not verified");
  if (!isAllowedEmail(email)) throw new Error(`${email || "This account"} is not allowed`);

  return {
    email,
    name: typeof userPayload.name === "string" ? userPayload.name : undefined,
    picture: typeof userPayload.picture === "string" ? userPayload.picture : undefined,
  };
}
