// apps/web/src/routes/api/agent/topic-shift/+server.ts
//
// SIO-751: resume endpoint for the detectTopicShift HITL gate. The initial
// stream handler in /api/agent/stream surfaces a topic_shift_prompt event
// when the graph pauses on interrupt(); the UI POSTs the user's decision
// here, which resumes the graph and pipes the rest of the events back as
// a normal SSE stream.

import { flushLangSmithCallbacks } from "@devops-agent/agent";
import { traceSpan } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getPendingInterrupt, resumeAgent } from "$lib/server/agent";
import { emitTopicShiftPrompt, pumpEventStream } from "$lib/server/sse-pump";
import type { RequestHandler } from "./$types";

const ResumeRequestSchema = z.object({
	threadId: z.string().min(1),
	decision: z.enum(["continue", "fresh"]),
});

export const POST: RequestHandler = async ({ request }) => {
	let body: z.infer<typeof ResumeRequestSchema>;
	try {
		body = ResumeRequestSchema.parse(await request.json());
	} catch {
		return json({ error: "Invalid request" }, { status: 400 });
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
					"agent.topic-shift.resume",
					async () => {
						const startTime = Date.now();
						// Clear the UI banner first thing so the user sees the
						// resumed graph's progress events without stale prompt UI.
						send({ type: "topic_shift_resolved" });

						const eventStream = await resumeAgent({
							threadId: body.threadId,
							resumeValue: { decision: body.decision },
						});

						const { toolsUsed } = await pumpEventStream(eventStream, send);
						await flushLangSmithCallbacks();

						// Defensive: a second topic shift could theoretically fire if
						// the resumed graph re-enters detectTopicShift on a future
						// turn (not this turn). Within this resume call that path is
						// impossible -- but check anyway so we never hang the SSE.
						const pendingInterrupt = await getPendingInterrupt(body.threadId);
						if (pendingInterrupt) {
							const surfaced = emitTopicShiftPrompt(send, body.threadId, pendingInterrupt.value);
							if (surfaced) return;
						}

						send({
							type: "done",
							threadId: body.threadId,
							responseTime: Date.now() - startTime,
							toolsUsed,
						});
					},
					{ "thread.id": body.threadId, "topic_shift.decision": body.decision },
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
};
