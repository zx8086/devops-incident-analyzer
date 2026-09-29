// apps/web/src/routes/api/agent/memory/candidates/+server.ts

// SIO-1891: the learning review pane's API. GET lists an agent's candidates
// (latest state per skill); POST applies approve / reject / supersede. Approve is
// refused without a confirmed task_success (beacon's precondition) and opens
// the promotion PR through memory-pr; PR merge stays the only activation.
import { isLearningReviewEnabled, listReviewRows, reviewCandidate } from "@devops-agent/agent";
import { getLogger } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { AGENT_IDS } from "$lib/agent-ids";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.memory.candidates");

const ReviewActionSchema = z
	.object({
		agent: z.enum(AGENT_IDS),
		skillName: z.string().regex(/^[a-z0-9-]+$/),
		action: z.enum(["approve", "reject", "supersede"]),
		edits: z.object({ title: z.string().max(200).optional(), body: z.string().max(4000).optional() }).optional(),
		supersedes: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.optional(),
	})
	.strict();

export const GET: RequestHandler = async ({ url }) => {
	if (!isLearningReviewEnabled()) return json({ error: "learning review is disabled" }, { status: 404 });
	const agent = url.searchParams.get("agent") ?? "incident-analyzer";
	if (!(AGENT_IDS as readonly string[]).includes(agent)) return json({ error: "unknown agent" }, { status: 400 });
	try {
		const candidates = await listReviewRows(agent);
		return json({ agent, candidates });
	} catch (error) {
		log.error({ agent, err: error instanceof Error ? error.message : String(error) }, "candidates list failed");
		return json({ error: "Failed to list candidates" }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	if (!isLearningReviewEnabled()) return json({ error: "learning review is disabled" }, { status: 404 });
	const parsed = ReviewActionSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return json({ error: "Invalid review action", issues: parsed.error.issues }, { status: 400 });
	try {
		const result = await reviewCandidate(parsed.data);
		if (!result.ok) return json({ error: result.reason }, { status: result.code });
		log.info(
			{
				agent: parsed.data.agent,
				skill: parsed.data.skillName,
				action: parsed.data.action,
				status: result.status,
				pr: result.prStatus,
			},
			"learning review action",
		);
		return json(result);
	} catch (error) {
		log.error({ err: error instanceof Error ? error.message : String(error) }, "review action failed");
		return json({ error: "Review action failed" }, { status: 500 });
	}
};
