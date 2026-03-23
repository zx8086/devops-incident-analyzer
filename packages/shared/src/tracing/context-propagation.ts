// shared/src/tracing/context-propagation.ts
import { context, propagation } from "@opentelemetry/api";

/**
 * Extract W3C trace context from HTTP request headers and run a function
 * within that extracted context. This connects MCP server OTEL spans to
 * the agent's trace when a traceparent header is present.
 *
 * When no traceparent header is present (e.g., Claude Desktop, n8n),
 * the function runs in the current context unchanged.
 */
export function withExtractedContext<T>(
	headers: Record<string, string | string[] | undefined>,
	fn: () => T,
): T {
	const carrier: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") {
			carrier[key.toLowerCase()] = value;
		}
	}

	// Only extract if traceparent is present
	if (!carrier.traceparent) return fn();

	const extractedContext = propagation.extract(context.active(), carrier);
	return context.with(extractedContext, fn);
}

/**
 * Create a request handler wrapper that extracts W3C trace context from
 * incoming HTTP requests. Use this in MCP server HTTP transport handlers.
 */
export function withTraceContextMiddleware(
	handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
	return async (req: Request) => {
		const headers: Record<string, string> = {};
		req.headers.forEach((value, key) => {
			headers[key] = value;
		});

		return withExtractedContext(headers, () => handler(req));
	};
}
