// apps/web/src/routes/api/events/+server.ts
import { mcpEvents } from "@devops-agent/agent";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const onReplaced = (event: unknown) => {
				controller.enqueue(encoder.encode(`event: mcp_replaced\ndata: ${JSON.stringify(event)}\n\n`));
			};
			mcpEvents.on("mcp_replaced", onReplaced);
			controller.enqueue(encoder.encode(":ok\n\n"));
			return () => mcpEvents.off("mcp_replaced", onReplaced);
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
