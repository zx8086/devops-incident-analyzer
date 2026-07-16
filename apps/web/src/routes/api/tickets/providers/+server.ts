// apps/web/src/routes/api/tickets/providers/+server.ts
import { listAvailableTicketProviders } from "@devops-agent/agent";
import { json } from "@sveltejs/kit";
import { ensureMcpConnected } from "$lib/server/agent";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	await ensureMcpConnected();
	return json({ providers: listAvailableTicketProviders() });
};
