// apps/web/src/routes/api/agent/memory/promote/+server.ts
//
// SIO-849: explicit "promote to memory" trigger. The UI POSTs a durable-learning
// proposal (wiki page, key-decision, or skill); the agent stages it on a fresh
// branch and opens a draft review PR. Never merges; secret-scanned; no-op when
// MEMORY_PR_ENABLED is unset.

import { promoteToMemory } from "@devops-agent/agent";
import { MemoryPrProposalSchema } from "@devops-agent/memory-pr";
import { getLogger } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.memory.promote");

export const POST: RequestHandler = async ({ request }) => {
	const parsed = MemoryPrProposalSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return json({ error: "Invalid memory proposal", issues: parsed.error.issues }, { status: 400 });
	}

	try {
		const result = await promoteToMemory(parsed.data);
		log.info({ status: result.status, kind: parsed.data.kind }, "agent.memory.promote");
		return json(result);
	} catch (error) {
		log.error({ err: error instanceof Error ? error.message : String(error) }, "agent.memory.promote.error");
		return json({ error: "Failed to open memory PR" }, { status: 500 });
	}
};
