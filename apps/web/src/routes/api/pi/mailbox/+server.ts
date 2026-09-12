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
	limit: z.coerce.number().int().positive().max(500).optional(),
	// SIO-1705: the selected AWS estates. Present (even empty) switches the read
	// to digest-anchored: each estate returns its newest daily digest and every
	// message after it. Absent keeps the old newest-N behaviour for callers that
	// have no estate scope.
	estates: z.array(z.string().min(1)).optional(),
});

export const GET: RequestHandler = async ({ url }) => {
	try {
		const query = MailboxQuerySchema.parse({
			hubKey: url.searchParams.get("hubKey") ?? undefined,
			name: url.searchParams.get("name") ?? undefined,
			limit: url.searchParams.get("limit") ?? undefined,
			estates: url.searchParams.has("estates")
				? (url.searchParams.get("estates") ?? "").split(",").filter(Boolean)
				: undefined,
		});
		return json(await readFleetMailbox(query));
	} catch (err) {
		return piFleetErrorResponse(err);
	}
};
