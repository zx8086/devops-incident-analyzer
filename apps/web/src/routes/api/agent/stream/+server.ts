// apps/web/src/routes/api/agent/stream/+server.ts

import { AttachmentError, flushLangSmithCallbacks, processAttachments } from "@devops-agent/agent";
import { getLogger, runWithRequestContext, traceSpan } from "@devops-agent/observability";
import { AttachmentBlockSchema, DataSourceContextSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import {
	decrementSseConnections,
	getIacTurnOutcome,
	getLastAssistantText,
	getPendingInterrupt,
	incrementSseConnections,
	invokeAgent,
	pruneThreadState,
	runPostTurn,
} from "$lib/server/agent";
import { buildLangSmithTags } from "$lib/server/langsmith-tags";
import { emitIacInterrupt, emitTopicShiftPrompt, pumpEventStream } from "$lib/server/sse-pump";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.stream");

const StreamRequestSchema = z.object({
	messages: z.array(
		z.object({
			role: z.enum(["user", "assistant"]),
			content: z.string(),
		}),
	),
	threadId: z.string().optional(),
	// Which agent/graph to run. Defaults to incident-analyzer.
	agentName: z.enum(["incident-analyzer", "elastic-iac"]).optional(),
	dataSources: z.array(z.string()).optional(),
	// SIO-649: Elastic deployment IDs to fan out to. Undefined = legacy single-deployment behavior.
	targetDeployments: z.array(z.string()).optional(),
	// SIO-836: AWS estate IDs the user explicitly selected. Empty/undefined = LLM router decides.
	uiAwsEstates: z.array(z.string()).optional(),
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
		// SIO-482: track this SSE connection for /health. Decrement exactly once,
		// whether the stream closes normally or the client cancels early.
		let sseCounted = true;
		incrementSseConnections();
		const releaseSse = () => {
			if (sseCounted) {
				sseCounted = false;
				decrementSseConnections();
			}
		};
		const stream = new ReadableStream({
			async start(controller) {
				const send = (event: Record<string, unknown>) => {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				};

				await runWithRequestContext({ threadId, runId, requestId }, async () => {
					log.info("agent.request.start");
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
									agentName: body.agentName,
									dataSources: body.dataSources,
									targetDeployments: body.targetDeployments,
									uiAwsEstates: body.uiAwsEstates,
									isFollowUp: body.isFollowUp,
									dataSourceContext: body.dataSourceContext,
									attachmentContentBlocks: processedAttachments?.contentBlocks,
									attachmentMeta: processedAttachments?.metadata,
									runName: "agent.request",
									tags: buildLangSmithTags({
										threadId,
										dataSources: body.dataSources,
										isFollowUp: body.isFollowUp,
									}),
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

								// elastic-iac maker graph: surface its own interrupt events (clarify /
								// plan-review) and, when complete, emit the final AIMessage (the IaC
								// graph appends messages rather than streaming an output node).
								if (body.agentName === "elastic-iac") {
									const iacInterrupt = await getPendingInterrupt(threadId, "elastic-iac");
									if (iacInterrupt && emitIacInterrupt(send, threadId, iacInterrupt.value)) {
										log.info({ responseTime: Date.now() - startTime, interrupted: true }, "agent.request.end");
										return;
									}
									const finalText = await getLastAssistantText(threadId, "elastic-iac");
									if (finalText) send({ type: "message", content: finalText });
									// SIO-930: label the completion chip with the real turn outcome (rejected/declined/etc.).
									const outcome = await getIacTurnOutcome(threadId);
									// SIO-476: prune the checkpoint after the turn completes (best-effort).
									await pruneThreadState(threadId, body.agentName);
									// SIO-942: persist this turn's live-memory blocks (best-effort).
									await runPostTurn({ agentName: body.agentName, threadId });
									send({
										type: "done",
										threadId,
										requestId,
										runId,
										responseTime: Date.now() - startTime,
										toolsUsed,
										outcome,
									});
									return;
								}

								// SIO-751: if detectTopicShift paused the graph via interrupt(),
								// the snapshot still has the interrupt pending and no "done"
								// event has fired. Surface the prompt to the UI instead of done;
								// the UI POSTs the user's decision to /api/agent/topic-shift.
								const pendingInterrupt = await getPendingInterrupt(threadId);
								if (pendingInterrupt) {
									const surfaced = emitTopicShiftPrompt(send, threadId, pendingInterrupt.value);
									if (surfaced) {
										log.info({ responseTime: Date.now() - startTime, interrupted: true }, "agent.request.end");
										return;
									}
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

								const responseTime = Date.now() - startTime;
								log.info({ responseTime, toolsUsed: toolsUsed.length, toolNames: toolsUsed }, "agent.request.end");
								// SIO-476: prune the checkpoint after the turn completes (best-effort).
								await pruneThreadState(threadId, body.agentName);
								// SIO-942: persist this turn's live-memory blocks (best-effort). Default
								// matches invokeAgent/pruneThreadState when agentName is omitted.
								await runPostTurn({ agentName: body.agentName ?? "incident-analyzer", threadId });
								send({
									type: "done",
									threadId,
									requestId,
									runId,
									responseTime,
									toolsUsed,
									dataSourceContext,
								});
							},
							{ "request.id": requestId, "thread.id": threadId, "run.id": runId },
						);
					} catch (error) {
						log.error(
							{
								err:
									error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) },
							},
							"agent.request.error",
						);
						send({ type: "error", message: error instanceof Error ? error.message : "Unknown error" });
					}
				});
				releaseSse();
				controller.close();
			},
			cancel() {
				// Client disconnected before the stream finished.
				releaseSse();
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
