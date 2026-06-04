// apps/web/src/routes/api/events/+server.ts
import { mcpEvents } from "@devops-agent/agent";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	let onReplaced: ((event: unknown) => void) | null = null;

	const cleanup = () => {
		if (onReplaced) {
			mcpEvents.off("mcp_replaced", onReplaced);
			onReplaced = null;
		}
	};

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			let closed = false;

			onReplaced = (event: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: mcp_replaced\ndata: ${JSON.stringify(event)}\n\n`));
				} catch {
					// SIO-906: controller already closed (client disconnected mid-emit). Stop
					// trying and deregister so a dead controller can never throw back into
					// mcpEvents.emit() and crash the MCP health-poll cycle.
					closed = true;
					cleanup();
				}
			};

			mcpEvents.on("mcp_replaced", onReplaced);
			controller.enqueue(encoder.encode(":ok\n\n"));
		},
		// SIO-906: client disconnect invokes cancel(), NOT the start() return value, so
		// listener removal must live here to avoid leaking a listener per dropped client.
		cancel() {
			cleanup();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
};
