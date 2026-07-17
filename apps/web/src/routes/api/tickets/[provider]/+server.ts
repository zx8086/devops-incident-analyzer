// apps/web/src/routes/api/tickets/[provider]/+server.ts
import {
	getGraphStore,
	isKnowledgeGraphEnabled,
	linkIncidentTicket,
	recordKeyDecision,
	writeCurationMirrorFacts,
} from "@devops-agent/agent";
import { getLogger } from "@devops-agent/observability";
import { CreateTicketRequestSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { resolveAvailableTicketProvider } from "$lib/server/tickets";
import type { RequestHandler } from "./$types";

const log = getLogger("api.tickets.create");

// SIO-1134: creating a ticket from a report is the human CURATION signal --
// link the investigation's KG incident to the returned key (best-effort, never
// fails the creation) so learn-from resolves it by exact lookup and enrichment
// treats it as durable memory.
async function curateIncident(requestId: string, ticketKey: string): Promise<void> {
	try {
		if (isKnowledgeGraphEnabled()) {
			const store = await getGraphStore();
			await linkIncidentTicket(store, requestId, ticketKey);
			// SIO-1135: mirror the now-curated incident (+ its root cause) to durable facts
			// by reading the current graph row. The per-run mirror moved to curation time, so
			// without this the incident would not survive a rebuild-from-facts. requestId IS
			// the KG incident node id (graph-knowledge.ts).
			await writeCurationMirrorFacts(store, requestId, { requestId, ticketKey });
		}
		recordKeyDecision({
			requestId,
			decision: `Incident ${requestId} is the canonical record for ${ticketKey} (curated via ticket creation)`,
			annotations: { kind: "kg-incident-ticket", incident_id: requestId, ticket: ticketKey },
		});
		log.info({ requestId, ticketKey }, "incident curated via ticket creation");
	} catch (err) {
		log.warn(
			{ requestId, ticketKey, error: err instanceof Error ? err.message : String(err) },
			"incident curation failed; ticket creation unaffected",
		);
	}
}

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		// Inside the boundary: ensureMcpConnected() rejections must surface as
		// JSON 502s, not SvelteKit's non-JSON framework error page.
		const provider = await resolveAvailableTicketProvider(params.provider);
		if (!provider) {
			return json({ error: `Unknown or unavailable ticket provider: ${params.provider}` }, { status: 404 });
		}
		const body = CreateTicketRequestSchema.parse(await request.json());
		const created = await provider.createTicket(body);
		if (body.requestId && created.key) {
			await curateIncident(body.requestId, created.key);
		}
		return json(created);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return json({ error: "Invalid request", details: err.issues }, { status: 400 });
		}
		return json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 502 });
	}
};
