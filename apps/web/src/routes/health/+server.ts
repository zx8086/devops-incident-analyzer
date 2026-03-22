// apps/web/src/routes/health/+server.ts
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  return json({
    status: "ok",
    timestamp: new Date().toISOString(),
    services: {
      elastic: !!process.env.ELASTIC_MCP_URL,
      kafka: !!process.env.KAFKA_MCP_URL,
      couchbase: !!process.env.COUCHBASE_MCP_URL,
      konnect: !!process.env.KONNECT_MCP_URL,
    },
  });
};
