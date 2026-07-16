// apps/web/src/routes/api/tickets/[provider]/projects/+server.ts
import { json } from "@sveltejs/kit";
import { resolveAvailableTicketProvider } from "$lib/server/tickets";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url }) => {
	const provider = await resolveAvailableTicketProvider(params.provider);
	if (!provider) {
		return json({ error: `Unknown or unavailable ticket provider: ${params.provider}` }, { status: 404 });
	}
	try {
		const query = url.searchParams.get("query")?.trim();
		const projects = await provider.listProjects(query || undefined);
		return json({ projects });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 502 });
	}
};
