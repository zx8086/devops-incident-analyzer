// apps/web/src/routes/api/agent/iac/resume/+server.ts
//
// Resume endpoint for the elastic-iac maker graph. The stream handler surfaces an
// iac_clarify or iac_plan_review event when the graph pauses on interrupt(); the UI
// POSTs the resume value here, which resumes the graph and pipes the rest back as a
// normal SSE stream (chaining a follow-on interrupt when one fires).

import { flushLangSmithCallbacks } from "@devops-agent/agent";
import { getLogger, runWithRequestContext, traceSpan } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getLastAssistantText, getPendingInterrupt, resumeAgent } from "$lib/server/agent";
import { buildLangSmithTags } from "$lib/server/langsmith-tags";
import { emitIacInterrupt, pumpEventStream } from "$lib/server/sse-pump";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.iac.resume");

const AGENT = "elastic-iac";

// decision answers the plan-review gate; answer answers a clarify question; direction
// answers the SIO-882 per-stack reconcile gate.
const ResumeRequestSchema = z
	.object({
		threadId: z.string().min(1),
		decision: z.enum(["approved", "rejected"]).optional(),
		answer: z.string().optional(),
		direction: z.enum(["reconcile-to-json", "reconcile-to-live", "skip"]).optional(),
	})
	.refine((b) => b.decision !== undefined || b.answer !== undefined || b.direction !== undefined, {
		message: "Provide a decision, an answer, or a direction",
	});

export const POST: RequestHandler = async ({ request }) => {
	let body: z.infer<typeof ResumeRequestSchema>;
	try {
		body = ResumeRequestSchema.parse(await request.json());
	} catch {
		return json({ error: "Invalid request" }, { status: 400 });
	}

	const resumeValue =
		body.direction !== undefined
			? { direction: body.direction }
			: body.decision !== undefined
				? { decision: body.decision }
				: { answer: body.answer };

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: Record<string, unknown>) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};

			const runId = crypto.randomUUID();
			const requestId = crypto.randomUUID();

			await runWithRequestContext({ threadId: body.threadId, runId, requestId }, async () => {
				log.info("agent.iac.resume.start");
				const startTime = Date.now();
				try {
					await traceSpan(
						"agent",
						"agent.iac.resume",
						async () => {
							const eventStream = await resumeAgent({
								threadId: body.threadId,
								agentName: AGENT,
								resumeValue,
								runName: "agent.request",
								tags: buildLangSmithTags({ threadId: body.threadId, resumed: true }),
								metadata: { request_id: requestId, session_id: body.threadId },
							});

							const { toolsUsed } = await pumpEventStream(eventStream, send);
							await flushLangSmithCallbacks();

							// A follow-on interrupt (e.g. clarify -> plan-review) re-pauses the graph.
							const pending = await getPendingInterrupt(body.threadId, AGENT);
							if (pending && emitIacInterrupt(send, body.threadId, pending.value)) {
								log.info({ responseTime: Date.now() - startTime, interrupted: true }, "agent.iac.resume.end");
								return;
							}

							const finalText = await getLastAssistantText(body.threadId, AGENT);
							if (finalText) send({ type: "message", content: finalText });

							const responseTime = Date.now() - startTime;
							log.info({ responseTime, toolsUsed: toolsUsed.length }, "agent.iac.resume.end");
							send({ type: "done", threadId: body.threadId, responseTime, toolsUsed });
						},
						{ "thread.id": body.threadId, "run.id": runId, "request.id": requestId },
					);
				} catch (error) {
					log.error(
						{
							err: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) },
						},
						"agent.iac.resume.error",
					);
					send({ type: "error", message: error instanceof Error ? error.message : "Unknown error" });
				}
			});

			controller.close();
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
