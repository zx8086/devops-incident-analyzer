// apps/web/src/routes/api/tickets/[provider]/+server.ts
import { CreateTicketRequestSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { resolveAvailableTicketProvider } from "$lib/server/tickets";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
	const provider = await resolveAvailableTicketProvider(params.provider);
	if (!provider) {
		return json({ error: `Unknown or unavailable ticket provider: ${params.provider}` }, { status: 404 });
	}
	try {
		const body = CreateTicketRequestSchema.parse(await request.json());
		return json(await provider.createTicket(body));
	} catch (err) {
		if (err instanceof z.ZodError) {
			return json({ error: "Invalid request", details: err.issues }, { status: 400 });
		}
		return json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 502 });
	}
};
