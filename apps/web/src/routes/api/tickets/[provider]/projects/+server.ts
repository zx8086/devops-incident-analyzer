// apps/web/src/routes/api/tickets/[provider]/projects/+server.ts
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { resolveAvailableTicketProvider } from "$lib/server/tickets";
import type { RequestHandler } from "./$types";

const ProjectQuerySchema = z
	.string()
	.trim()
	.max(255)
	.transform((s) => s || undefined)
	.describe("Optional project search term; blank collapses to undefined (list all)");

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const provider = await resolveAvailableTicketProvider(params.provider);
		if (!provider) {
			return json({ error: `Unknown or unavailable ticket provider: ${params.provider}` }, { status: 404 });
		}
		const parsed = ProjectQuerySchema.safeParse(url.searchParams.get("query") ?? "");
		if (!parsed.success) {
			return json({ error: "Invalid request", details: parsed.error.issues }, { status: 400 });
		}
		const projects = await provider.listProjects(parsed.data);
		return json({ projects });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 502 });
	}
};
