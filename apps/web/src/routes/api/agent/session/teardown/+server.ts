// apps/web/src/routes/api/agent/session/teardown/+server.ts
//
// SIO-846: explicit session-end seam for agent-session lifecycle teardown. The
// UI POSTs here on "end session" / beforeunload so the agent can flush its
// daily-log breadcrumb and (once EPIC 1 lands) open the memory-review PR. HTTP
// has no reliable session-end signal, so this endpoint is the deterministic
// trigger; an idle-TTL sweep is the backstop.

import { getLogger } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { sessionTeardown } from "$lib/server/agent";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.session.teardown");

const TeardownRequestSchema = z.object({
	threadId: z.string().min(1),
	// SIO-938: which agent ran this thread, so teardown ends the right Agent
	// Memory user's session. Optional; defaults to incident-analyzer.
	agentName: z.string().min(1).optional(),
});

export const POST: RequestHandler = async ({ request }) => {
	let body: z.infer<typeof TeardownRequestSchema>;
	try {
		body = TeardownRequestSchema.parse(await request.json());
	} catch {
		return json({ error: "Invalid request" }, { status: 400 });
	}

	// Teardown is best-effort and must never error the client; sessionTeardown
	// already swallows and logs internally.
	await sessionTeardown(body.threadId, body.agentName);
	log.info({ threadId: body.threadId }, "agent.session.teardown");
	return json({ ok: true });
};
