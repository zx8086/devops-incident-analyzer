// apps/web/src/routes/api/agent/stream/+server.ts

import { flushLangSmithCallbacks, generateFallbackSuggestions, generateFollowUpSuggestions } from "@devops-agent/agent";
import { traceSpan } from "@devops-agent/observability";
import { DataSourceContextSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getFollowUpLlm, invokeAgent } from "$lib/server/agent";
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
	dataSourceContext: DataSourceContextSchema.optional(),
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = StreamRequestSchema.parse(await request.json());
		const threadId = body.threadId ?? crypto.randomUUID();
		const requestId = crypto.randomUUID();
		const runId = crypto.randomUUID();

		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				const send = (event: Record<string, unknown>) => {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				};

				try {
					await traceSpan(
						"agent",
						"agent.request",
						async () => {
							const startTime = Date.now();

							// Send run_id immediately so client can submit feedback before graph output
							send({ type: "run_id", runId });

							const eventStream = await invokeAgent(body.messages, {
								threadId,
								runId,
								dataSources: body.dataSources,
								isFollowUp: body.isFollowUp,
								dataSourceContext: body.dataSourceContext,
								metadata: {
									request_id: requestId,
									session_id: threadId,
								},
							});

							const OUTPUT_NODES = new Set(["aggregate", "responder"]);
							const PIPELINE_NODES = new Set([
								"classify",
								"entityExtractor",
								"queryDataSource",
								"align",
								"aggregate",
								"validate",
								"responder",
							]);
							const nodeStartTimes = new Map<string, number>();
							let responseContent = "";
							const toolsUsed = new Set<string>();

							for await (const event of eventStream) {
								if (event.event === "on_chat_model_stream" && event.data?.chunk?.content) {
									const tags: string[] = event.tags ?? [];
									const isOutputNode = tags.some((t: string) => OUTPUT_NODES.has(t));
									const nodeName = event.metadata?.langgraph_node;
									if (isOutputNode || OUTPUT_NODES.has(nodeName)) {
										const content = String(event.data.chunk.content);
										responseContent += content;
										send({ type: "message", content });
									}
								}

								if (event.event === "on_chain_start" && event.name && PIPELINE_NODES.has(event.name)) {
									nodeStartTimes.set(event.name, Date.now());
									send({ type: "node_start", nodeId: event.name });
								}

								if (event.event === "on_chain_end" && event.name && PIPELINE_NODES.has(event.name)) {
									const startTime = nodeStartTimes.get(event.name);
									const duration = startTime ? Date.now() - startTime : 0;
									nodeStartTimes.delete(event.name);
									send({ type: "node_end", nodeId: event.name, duration });
								}

								if (event.event === "on_tool_start") {
									const toolName = event.name ?? "unknown";
									toolsUsed.add(toolName);
									send({
										type: "tool_call",
										toolName,
										args: event.data?.input ?? {},
									});
								}
							}

							// Generate follow-up suggestions after graph completes
							const toolsUsedArray = [...toolsUsed];
							const followUpLlm = getFollowUpLlm();
							let suggestions: string[];
							if (followUpLlm && responseContent.length >= 50) {
								suggestions = await generateFollowUpSuggestions(followUpLlm, responseContent, toolsUsedArray);
							} else {
								suggestions = generateFallbackSuggestions(toolsUsedArray);
							}

							if (suggestions.length > 0) {
								send({ type: "suggestions", suggestions });
							}

							await flushLangSmithCallbacks();

							// Build dataSourceContext from the datasources that were actually queried
							const queriedDataSources = body.dataSources ?? [];
							const dataSourceContext =
								body.dataSourceContext ??
								(queriedDataSources.length > 0
									? {
											type: "EXPLICIT" as const,
											dataSources: queriedDataSources,
											scope: "all" as const,
										}
									: undefined);

							send({
								type: "done",
								threadId,
								requestId,
								runId,
								responseTime: Date.now() - startTime,
								toolsUsed: toolsUsedArray,
								dataSourceContext,
							});
						},
						{ "request.id": requestId, "thread.id": threadId },
					);
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
