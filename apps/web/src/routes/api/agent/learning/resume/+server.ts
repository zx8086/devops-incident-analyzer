// apps/web/src/routes/api/agent/learning/resume/+server.ts
//
// SIO-1126: resume endpoint for the HIL learning lane's two gates. The stream
// handler surfaces hil_learning_match / hil_learning_review events when the
// graph pauses on interrupt(); the UI POSTs the resume value here, which
// resumes the graph and pipes the rest back as a normal SSE stream. The match
// gate chains into the review gate, so a resume may re-pause immediately.

import { flushLangSmithCallbacks } from "@devops-agent/agent";
import { getLogger, runWithRequestContext, traceSpan } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import {
	getLastAssistantText,
	getPendingInterrupt,
	pruneThreadState,
	resumeAgent,
	runPostTurn,
} from "$lib/server/agent";
import { buildLangSmithTags } from "$lib/server/langsmith-tags";
import { emitHilLearningInterrupt, pumpEventStream } from "$lib/server/sse-pump";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.learning.resume");

// match answers the incident-match gate (incidentId null = "none of these" ->
// create a new incident record); review answers the per-item approve/reject gate.
const ResumeRequestSchema = z
	.object({
		threadId: z.string().min(1),
		match: z.object({ incidentId: z.string().min(1).nullable() }).optional(),
		review: z.object({ decisions: z.record(z.string(), z.enum(["approve", "reject"])) }).optional(),
	})
	// Exactly one resume field -- a mixed payload could resume the wrong gate.
	.superRefine((b, ctx) => {
		const provided = [b.match, b.review].filter((v) => v !== undefined).length;
		if (provided !== 1) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one of match or review" });
		}
	});

export const POST: RequestHandler = async ({ request }) => {
	let body: z.infer<typeof ResumeRequestSchema>;
	try {
		body = ResumeRequestSchema.parse(await request.json());
	} catch {
		return json({ error: "Invalid request" }, { status: 400 });
	}

	const resumeValue =
		body.match !== undefined ? { incidentId: body.match.incidentId } : { decisions: body.review?.decisions ?? {} };

	// Bind the request variant to the thread's actual pending gate: a stale or
	// hand-crafted payload must not resume the wrong interrupt (a match payload
	// delivered to the review gate would yield an empty decisions map, and vice
	// versa) -- CodeRabbit, PR #392.
	const expectedGate = body.match !== undefined ? "hil_learning_match" : "hil_learning_review";
	const pendingBefore = await getPendingInterrupt(body.threadId);
	const pendingType = (pendingBefore?.value as { type?: unknown } | undefined)?.type;
	if (pendingType !== expectedGate) {
		return json(
			{
				error: `No pending ${expectedGate} gate for this thread (found: ${typeof pendingType === "string" ? pendingType : "none"})`,
			},
			{ status: 409 },
		);
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: Record<string, unknown>) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};

			const runId = crypto.randomUUID();
			const requestId = crypto.randomUUID();

			await runWithRequestContext({ threadId: body.threadId, runId, requestId }, async () => {
				log.info("agent.learning.resume.start");
				const startTime = Date.now();
				try {
					await traceSpan(
						"agent",
						"agent.learning.resume",
						async () => {
							// Clear the gate card first thing so the user sees the resumed
							// graph's progress events without stale prompt UI.
							send({ type: "hil_learning_resolved" });

							const eventStream = await resumeAgent({
								threadId: body.threadId,
								resumeValue,
								runName: "agent.request",
								tags: buildLangSmithTags({ threadId: body.threadId, resumed: true }),
								metadata: { request_id: requestId, session_id: body.threadId },
							});

							const { toolsUsed } = await pumpEventStream(eventStream, send);
							await flushLangSmithCallbacks();

							// The match gate chains into the review gate; surface it and
							// keep the thread paused for the next POST.
							const pending = await getPendingInterrupt(body.threadId);
							if (pending) {
								if (emitHilLearningInterrupt(send, body.threadId, pending.value)) {
									log.info({ responseTime: Date.now() - startTime, interrupted: true }, "agent.learning.resume.end");
									return;
								}
								// A pending interrupt we do not recognize: never finalize
								// (prune + done) a thread that is still paused -- CodeRabbit,
								// PR #392. Surface an error and leave the state for resume.
								log.error({ threadId: body.threadId }, "agent.learning.resume.unrecognized-interrupt");
								send({ type: "error", message: "The learning flow paused on an unexpected gate; please retry." });
								return;
							}

							// The lane appends its apply summary (or failure explanation) as
							// an AIMessage rather than streaming an output node.
							const finalText = await getLastAssistantText(body.threadId);
							if (finalText) send({ type: "message", content: finalText });

							await pruneThreadState(body.threadId);
							await runPostTurn({ agentName: "incident-analyzer", threadId: body.threadId });
							const responseTime = Date.now() - startTime;
							log.info({ responseTime, toolsUsed: toolsUsed.length }, "agent.learning.resume.end");
							send({ type: "done", threadId: body.threadId, responseTime, toolsUsed });
						},
						{ "thread.id": body.threadId, "run.id": runId, "request.id": requestId },
					);
				} catch (error) {
					log.error(
						{
							err: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) },
						},
						"agent.learning.resume.error",
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
