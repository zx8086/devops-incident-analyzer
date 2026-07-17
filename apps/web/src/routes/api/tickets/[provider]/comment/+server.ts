// apps/web/src/routes/api/tickets/[provider]/comment/+server.ts
import { getLogger } from "@devops-agent/observability";
import { AddCommentRequestSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { resolveAvailableTicketProvider } from "$lib/server/tickets";
import type { RequestHandler } from "./$types";

const log = getLogger("api.tickets.comment");

// SIO-1145: post a follow-up answer as a comment on the thread's existing ticket.
// No curation here -- the incident was already curated at ticket creation.
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		// Resolution inside the boundary so ensureMcpConnected() rejections surface
		// as JSON 502s, not SvelteKit's framework error page (matches the create route).
		const provider = await resolveAvailableTicketProvider(params.provider);
		if (!provider) {
			return json({ error: `Unknown or unavailable ticket provider: ${params.provider}` }, { status: 404 });
		}
		// Parse JSON in an inner boundary so a malformed body is a 400 (client error),
		// not a 502 (provider failure) from the outer catch.
		let payload: unknown;
		try {
			payload = await request.json();
		} catch {
			return json({ error: "Invalid request" }, { status: 400 });
		}
		const body = AddCommentRequestSchema.parse(payload);
		const { id } = await provider.addComment(body.issueKey, body.body);
		log.info({ issueKey: body.issueKey, commentId: id }, "comment added to ticket");
		return json({ ok: true, id });
	} catch (err) {
		if (err instanceof z.ZodError) {
			return json({ error: "Invalid request", details: err.issues }, { status: 400 });
		}
		return json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 502 });
	}
};
