// apps/web/src/routes/api/tickets/[provider]/epics/+server.ts
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { resolveAvailableTicketProvider } from "$lib/server/tickets";
import type { RequestHandler } from "./$types";

const ProjectKeySchema = z.string().trim().min(1, "projectKey is required");

export const GET: RequestHandler = async ({ params, url }) => {
	const provider = await resolveAvailableTicketProvider(params.provider);
	if (!provider) {
		return json({ error: `Unknown or unavailable ticket provider: ${params.provider}` }, { status: 404 });
	}
	const parsed = ProjectKeySchema.safeParse(url.searchParams.get("projectKey") ?? "");
	if (!parsed.success) {
		return json({ error: "Invalid request", details: parsed.error.issues }, { status: 400 });
	}
	try {
		const epics = await provider.listEpics(parsed.data);
		return json({ epics });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 502 });
	}
};
