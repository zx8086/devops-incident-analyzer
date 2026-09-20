// apps/web/src/routes/api/agent/feedback/+server.ts
import { getLogger } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.feedback");

const FeedbackSchema = z.object({
	runId: z.string(),
	score: z.number().min(0).max(1),
	comment: z.string().optional(),
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = FeedbackSchema.parse(await request.json());
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
