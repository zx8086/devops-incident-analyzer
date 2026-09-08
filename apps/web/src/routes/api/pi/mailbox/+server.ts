// apps/web/src/routes/api/pi/mailbox/+server.ts
// SIO-1650: read a hub's durable inbox (the fallback target by default).
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { readFleetMailbox } from "$lib/server/pi-fleet";
import { piFleetErrorResponse } from "$lib/server/pi-fleet-http";
import type { RequestHandler } from "./$types";

const MailboxQuerySchema = z.object({
	// SIO-1666: addressed by hub key, not environment.
	hubKey: z.string().min(1),
	name: z.string().min(1).optional(),
	limit: z.coerce.number().int().positive().max(100).optional(),
});

export const GET: RequestHandler = async ({ url }) => {
	try {
		const query = MailboxQuerySchema.parse({
			hubKey: url.searchParams.get("hubKey") ?? undefined,
			name: url.searchParams.get("name") ?? undefined,
			limit: url.searchParams.get("limit") ?? undefined,
		});
		return json(await readFleetMailbox(query));
	} catch (err) {
		return piFleetErrorResponse(err);
	}
};
