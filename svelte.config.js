import adapter from "@sveltejs/adapter-node";

const config = {
  kit: {
    adapter: adapter(),
    // Runtime host validation lives in hooks.server.ts so one build can safely serve LAN,
    // forwarded-IP, and reverse-proxy hostnames without a static origin allowlist.
    csrf: { trustedOrigins: ["*"] },
  },
};

export default config;
