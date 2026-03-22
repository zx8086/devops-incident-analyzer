// apps/web/src/hooks.server.ts
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean);

  if (event.request.method === "OPTIONS") {
    const origin = event.request.headers.get("origin") ?? "";
    if (corsOrigins.includes(origin) || corsOrigins.length === 0) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin || "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
  }

  const response = await resolve(event);

  if (event.url.pathname.startsWith("/api/")) {
    const origin = event.request.headers.get("origin") ?? "";
    if (corsOrigins.includes(origin) || corsOrigins.length === 0) {
      response.headers.set("Access-Control-Allow-Origin", origin || "*");
    }
  }

  return response;
};
