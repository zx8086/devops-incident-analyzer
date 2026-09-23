// apps/web/src/routes/api/agent/landing-zone/resume/+server.ts

import { flushLangSmithCallbacks } from "@devops-agent/agent";
import { getLogger, runWithRequestContext, traceSpan } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import {
	getLandingZoneTurnTelemetry,
	getLastAssistantText,
	getPendingInterrupt,
	getPipelineNodes,
	pruneThreadState,
	resumeAgent,
	runPostTurn,
} from "$lib/server/agent";
import { buildLangSmithTags } from "$lib/server/langsmith-tags";
import { emitLandingZoneInterrupt, pumpEventStream } from "$lib/server/sse-pump";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.landing-zone.resume");
const AGENT = "landing-zone-terraform";

const ResumeRequestSchema = z.discriminatedUnion("decision", [
	z.object({ threadId: z.string().min(1), reviewId: z.string().uuid(), decision: z.literal("approve") }).strict(),
	z
		.object({
			threadId: z.string().min(1),
			reviewId: z.string().uuid(),
			decision: z.literal("reject"),
			reason: z.string().trim().min(1),
		})
		.strict(),
	z
		.object({
			threadId: z.string().min(1),
			reviewId: z.string().uuid(),
			decision: z.literal("amend"),
			instructions: z.string().trim().min(1),
		})
		.strict(),
]);

export const POST: RequestHandler = async ({ request }) => {
	const parsed = ResumeRequestSchema.safeParse(await request.json().catch(() => undefined));
	if (!parsed.success) return json({ error: "Invalid request" }, { status: 400 });
	const body = parsed.data;
	const pending = await getPendingInterrupt(body.threadId, AGENT);
	if (
		!pending ||
		typeof pending.value !== "object" ||
		pending.value === null ||
		(pending.value as { type?: unknown }).type !== "landing_zone_plan_review"
	) {
		return json({ error: "No Landing Zone review is pending for this thread" }, { status: 409 });
	}
	const pendingReviewId = (pending.value as { review?: { reviewId?: unknown } }).review?.reviewId;
	if (pendingReviewId !== body.reviewId)
		return json({ error: "Landing Zone review capability did not match" }, { status: 403 });

	const resumeValue =
		body.decision === "approve"
			? { decision: "approve" as const }
			: body.decision === "reject"
				? { decision: "reject" as const, reason: body.reason }
				: { decision: "amend" as const, instructions: body.instructions };
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: Record<string, unknown>) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};
			const runId = crypto.randomUUID();
			const requestId = crypto.randomUUID();
			await runWithRequestContext({ threadId: body.threadId, runId, requestId }, async () => {
				const startedAt = Date.now();
				try {
					await traceSpan(
						"agent",
						"agent.landing-zone.resume",
						async () => {
							send({ type: "landing_zone_review_resolved" });
							const events = await resumeAgent({
								threadId: body.threadId,
								agentName: AGENT,
								resumeValue,
								runName: "agent.request",
								tags: buildLangSmithTags({ threadId: body.threadId, agentName: AGENT, resumed: true }),
								metadata: { request_id: requestId, session_id: body.threadId, agent_id: AGENT, graph_used: true },
							});
							const { toolsUsed } = await pumpEventStream(events, send, await getPipelineNodes(AGENT));
							await flushLangSmithCallbacks();
							const next = await getPendingInterrupt(body.threadId, AGENT);
							if (next) {
								if (emitLandingZoneInterrupt(send, body.threadId, next.value)) return;
								send({ type: "error", message: "The resumed Landing Zone turn paused at an unsupported review gate." });
								return;
							}
							const finalText = await getLastAssistantText(body.threadId, AGENT);
							if (finalText) send({ type: "message", content: finalText });
							const telemetry = await getLandingZoneTurnTelemetry(body.threadId);
							await pruneThreadState(body.threadId, AGENT);
							await runPostTurn({ agentName: AGENT, threadId: body.threadId });
							const responseTime = Date.now() - startedAt;
							if (telemetry) log.info({ ...telemetry, responseTime }, "agent.landing-zone.turn");
							send({ type: "done", threadId: body.threadId, requestId, runId, responseTime, toolsUsed, telemetry });
						},
						{ "thread.id": body.threadId, "run.id": runId, "request.id": requestId },
					);
				} catch (error) {
					emitLandingZoneInterrupt(send, body.threadId, pending.value);
					log.error(
						{
							err: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) },
						},
						"agent.landing-zone.resume.error",
					);
					send({ type: "error", message: error instanceof Error ? error.message : "Unknown error" });
				}
			});
			controller.close();
		},
	});

	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
};
