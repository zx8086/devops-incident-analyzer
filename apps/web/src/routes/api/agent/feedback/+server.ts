// apps/web/src/routes/api/agent/feedback/+server.ts
import { recordTurnFeedback } from "@devops-agent/agent";
import { getLogger } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getLastAssistantText } from "$lib/server/agent";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.feedback");

// Greptile PR #918: the learning write is best-effort and must not block the
// provider write, so it gets a hard deadline. Overridable so a test can prove
// the bound without waiting the full default.
function feedbackMemoryDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.LEARNING_FEEDBACK_DEADLINE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`learning feedback exceeded ${ms}ms`)), ms);
		work.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

const FeedbackSchema = z.object({
	runId: z.string(),
	score: z.number().min(0).max(1),
	comment: z.string().optional(),
	// SIO-1890: which thread and agent the feedback belongs to, so it can reach the
	// learning candidates that thread produced. Optional: older clients omit them.
	threadId: z.string().min(1).optional(),
	agentName: z.string().min(1).optional(),
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = FeedbackSchema.parse(await request.json());

		// SIO-1890: the learning signal first, independent of LangSmith being
		// configured or reachable. Best-effort: a memory failure never fails the
		// request. Only a whole score is a verdict; a fractional one is not.
		if (body.threadId && body.agentName && (body.score === 0 || body.score === 1)) {
			try {
				// Greptile PR #918: the body names the thread, so bind the verdict to a
				// thread that has an assistant turn for that agent in the checkpointer
				// before any candidate state changes; and bound the memory work so a
				// stalled backend can never hold up the LangSmith write below.
				const deadlineMs = feedbackMemoryDeadlineMs();
				const known = await withDeadline(getLastAssistantText(body.threadId, body.agentName), deadlineMs);
				if (!known) {
					log.warn({ threadId: body.threadId, agentName: body.agentName }, "learning feedback ignored: unknown thread");
				} else {
					const { transitions } = await withDeadline(
						recordTurnFeedback(body.agentName, body.threadId, body.score),
						deadlineMs,
					);
					log.info(
						{ threadId: body.threadId, agentName: body.agentName, score: body.score, transitions },
						"learning feedback",
					);
				}
			} catch (error) {
				log.warn(
					{ threadId: body.threadId, error: error instanceof Error ? error.message : String(error) },
					"learning feedback failed; LangSmith feedback continues",
				);
			}
		}

		const apiKey = process.env.LANGSMITH_API_KEY;

		if (!apiKey) {
			return json({ success: false, error: "LangSmith not configured" }, { status: 500 });
		}

		const response = await fetch("https://api.smith.langchain.com/api/v1/feedback", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify({
				run_id: body.runId,
				key: "user-feedback",
				score: body.score,
				comment: body.comment,
			}),
		});

		// SIO-1835: the response was never checked, so a rejected score still returned
		// success: true. That hid the real defect for as long as it existed -- feedback was
		// being filed against a run id LangSmith never created, and nothing said so.
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			log.error(
				{ status: response.status, runId: body.runId, detail: detail.slice(0, 200) },
				"LangSmith rejected user feedback",
			);
			return json({ success: false, error: "Feedback was not recorded" }, { status: 502 });
		}

		return json({ success: true });
	} catch (error) {
		log.error({ error: error instanceof Error ? error.message : String(error) }, "user feedback failed");
		return json({ error: "Invalid feedback" }, { status: 400 });
	}
};
