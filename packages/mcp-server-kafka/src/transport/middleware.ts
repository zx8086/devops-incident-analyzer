// src/transport/middleware.ts
type RouteHandler = (req: Request) => Promise<Response> | Response;

export function withOriginValidation(
  handler: RouteHandler,
  allowedOrigins?: string[],
): RouteHandler {
  return async (req: Request) => {
    const origin = req.headers.get("origin");
    if (!origin) return handler(req);

    if (allowedOrigins && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Origin not allowed" }, id: null },
        { status: 403 },
      );
    }
    return handler(req);
  };
}

export function withApiKeyAuth(handler: RouteHandler, apiKey?: string): RouteHandler {
  return async (req: Request) => {
    if (!apiKey) return handler(req);

    const header = req.headers.get("authorization");
    if (header !== `Bearer ${apiKey}`) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized" }, id: null },
        { status: 401 },
      );
    }
    return handler(req);
  };
}
