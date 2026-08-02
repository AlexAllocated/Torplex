import type { Handle } from "@sveltejs/kit";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const formContentTypes = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
];

function isFormSubmission(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  return formContentTypes.some((type) => contentType.startsWith(type));
}

function isSameHostOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  if (unsafeMethods.has(event.request.method) && isFormSubmission(event.request) && !isSameHostOrigin(event.request)) {
    return new Response(`Cross-site ${event.request.method} form submissions are forbidden`, {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return resolve(event);
};
