// apps/web/src/routes/api/agent/stream/+server.ts

import { AttachmentError, flushLangSmithCallbacks, processAttachments } from "@devops-agent/agent";
import { traceSpan } from "@devops-agent/observability";
import { AttachmentBlockSchema, DataSourceContextSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getPendingInterrupt, invokeAgent } from "$lib/server/agent";
import { emitTopicShiftPrompt, pumpEventStream } from "$lib/server/sse-pump";
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
	// SIO-649: Elastic deployment IDs to fan out to. Undefined = legacy single-deployment behavior.
	targetDeployments: z.array(z.string()).optional(),
	attachments: z.array(AttachmentBlockSchema).max(10).optional(),
	isFollowUp: z.boolean().optional(),
	dataSourceContext: DataSourceContextSchema.optional(),
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = StreamRequestSchema.parse(await request.json());
		const threadId = body.threadId ?? crypto.randomUUID();
		const requestId = crypto.randomUUID();
		const runId = crypto.randomUUID();

		// SIO-610: Process attachments server-side before invoking the agent
		let processedAttachments: Awaited<ReturnType<typeof processAttachments>> | undefined;
		if (body.attachments && body.attachments.length > 0) {
			try {
				processedAttachments = await processAttachments(body.attachments);
			} catch (err) {
				if (err instanceof AttachmentError) {
					return json({ error: "Attachment error", details: err.message }, { status: 422 });
				}
				throw err;
			}
		}

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

							// Send attachment warnings if any
							if (processedAttachments?.warnings.length) {
								send({ type: "attachment_warnings", warnings: processedAttachments.warnings });
							}

							const eventStream = await invokeAgent(body.messages, {
								threadId,
								runId,
								dataSources: body.dataSources,
								targetDeployments: body.targetDeployments,
								isFollowUp: body.isFollowUp,
								dataSourceContext: body.dataSourceContext,
								attachmentContentBlocks: processedAttachments?.contentBlocks,
								attachmentMeta: processedAttachments?.metadata,
								metadata: {
									request_id: requestId,
									session_id: threadId,
								},
							});

							// SIO-751: shared event-routing helper. Both the initial stream
							// handler (here) and the resume endpoint use the same logic so
							// resumed graphs surface identical events.
							const { toolsUsed } = await pumpEventStream(eventStream, send);

							await flushLangSmithCallbacks();

							// SIO-751: if detectTopicShift paused the graph via interrupt(),
							// the snapshot still has the interrupt pending and no "done"
							// event has fired. Surface the prompt to the UI instead of done;
							// the UI POSTs the user's decision to /api/agent/topic-shift.
							const pendingInterrupt = await getPendingInterrupt(threadId);
							if (pendingInterrupt) {
								const surfaced = emitTopicShiftPrompt(send, threadId, pendingInterrupt.value);
								if (surfaced) return;
							}

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
								toolsUsed,
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
