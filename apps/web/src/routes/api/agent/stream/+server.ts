// apps/web/src/routes/api/agent/stream/+server.ts
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { invokeAgent } from "$lib/server/agent";
import type { RequestHandler } from "./$types";

const StreamRequestSchema = z.object({
	messages: z.array(
		z.object({
			role: z.enum(["user", "assistant"]),
			content: z.string(),
		}),
	),
	threadId: z.string().optional(),
	dataSources: z.array(z.string()).optional(),
	isFollowUp: z.boolean().optional(),
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = StreamRequestSchema.parse(await request.json());
		const threadId = body.threadId ?? crypto.randomUUID();

		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				const send = (event: Record<string, unknown>) => {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				};

				try {
					const startTime = Date.now();

					const eventStream = await invokeAgent(body.messages, {
						threadId,
						dataSources: body.dataSources,
						isFollowUp: body.isFollowUp,
					});

					// Only stream content from final output nodes (aggregate, responder)
					// Internal nodes (classifier, entityExtractor, sub-agents) should not leak to UI
					const OUTPUT_NODES = new Set(["aggregate", "responder"]);

					for await (const event of eventStream) {
						if (event.event === "on_chat_model_stream" && event.data?.chunk?.content) {
							// Filter: only forward LLM output from output-producing nodes
							const tags: string[] = event.tags ?? [];
							const isOutputNode = tags.some((t: string) => OUTPUT_NODES.has(t));
							// LangGraph tags the node name in the event metadata
							const nodeName = event.metadata?.langgraph_node;
							if (isOutputNode || OUTPUT_NODES.has(nodeName)) {
								send({ type: "message", content: String(event.data.chunk.content) });
							}
						}

						if (event.event === "on_chain_start" && event.name) {
							send({ type: "node_start", nodeId: event.name });
						}

						if (event.event === "on_chain_end" && event.name) {
							send({ type: "node_end", nodeId: event.name, duration: 0 });
						}

						if (event.event === "on_tool_start") {
							send({
								type: "tool_call",
								toolName: event.name ?? "unknown",
								args: event.data?.input ?? {},
							});
						}
					}

					send({
						type: "done",
						threadId,
						responseTime: Date.now() - startTime,
					});
				} catch (error) {
					send({ type: "error", message: error instanceof Error ? error.message : "Unknown error" });
				} finally {
					controller.close();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch {
		return json({ error: "Invalid request" }, { status: 400 });
	}
};
