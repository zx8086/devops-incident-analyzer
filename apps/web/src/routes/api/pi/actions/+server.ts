// apps/web/src/routes/api/pi/actions/+server.ts
// SIO-1778: a verify/investigate card executes as a send plus N short polls, so the
// fleet pane shows it live and no request outlives one hub await slice. POST starts
// the action; GET polls it by msg id. What a msg id is finalized AS (tool, params,
// target) is held server-side by the agent package, never taken from the poll.
import { type PiActionPoll, pollPiAction, startPiAction } from "@devops-agent/agent";
import { type ActionResult, PendingActionSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { piFleetErrorResponse } from "$lib/server/pi-fleet-http";
import type { RequestHandler } from "./$types";

const StartRequestSchema = z.object({
	action: PendingActionSchema,
	reportContent: z.string(),
});

type Outcome = Extract<PiActionPoll, { pending: false }>["outcome"];

function toActionResult(actionId: string, tool: string, outcome: Outcome): ActionResult {
	return outcome.status === "success"
		? {
				actionId,
				tool,
				status: "success",
				result: outcome.result,
				...(outcome.followUpActions && { followUpActions: outcome.followUpActions }),
			}
		: { actionId, tool, status: "error", error: outcome.error ?? "pi-coms action failed" };
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { action, reportContent } = StartRequestSchema.parse(await request.json());
		const start = await startPiAction(action, reportContent);
		if (start.status === "error") {
			return json({ started: false, result: toActionResult(action.id, action.tool, start) });
		}
		const entry = { hubKey: start.hubKey, target: start.target, msgId: start.msgId, prompt: start.prompt };
		if (start.status === "queued") {
			return json({ started: false, ...entry, result: toActionResult(action.id, action.tool, start.outcome) });
		}
		return json({ started: true, ...entry, budgetMs: start.budgetMs });
	} catch (err) {
		return piFleetErrorResponse(err);
	}
};

export const GET: RequestHandler = async ({ url }) => {
	try {
		const msgId = z
			.string()
			.min(1)
			.parse(url.searchParams.get("msgId") ?? undefined);
		const poll = await pollPiAction(msgId);
		if (!poll) return json({ error: "unknown or already finalized pi action" }, { status: 404 });
		if (poll.pending) return json({ pending: true, status: poll.status });
		return json({ pending: false, result: toActionResult(poll.actionId, poll.tool, poll.outcome) });
	} catch (err) {
		return piFleetErrorResponse(err);
	}
};
