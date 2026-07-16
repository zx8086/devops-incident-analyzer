// apps/web/src/routes/api/tickets/[provider]/assignees/+server.ts
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { resolveAvailableTicketProvider } from "$lib/server/tickets";
import type { RequestHandler } from "./$types";

const AssigneeQuerySchema = z.string().trim().min(2, "query must be at least 2 characters");

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const provider = await resolveAvailableTicketProvider(params.provider);
		if (!provider) {
			return json({ error: `Unknown or unavailable ticket provider: ${params.provider}` }, { status: 404 });
		}
		const parsed = AssigneeQuerySchema.safeParse(url.searchParams.get("query") ?? "");
		if (!parsed.success) {
			return json({ error: "Invalid request", details: parsed.error.issues }, { status: 400 });
		}
		const assignees = await provider.searchAssignees(parsed.data);
		return json({ assignees });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 502 });
	}
};
