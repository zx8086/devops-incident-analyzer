// apps/web/src/routes/api/pi/mailbox/+server.ts
// SIO-1650: read a hub's durable inbox (the fallback target by default).
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { PiFleetEnvironmentSchema } from "$lib/pi-fleet-types";
import { readFleetMailbox } from "$lib/server/pi-fleet";
import { piFleetErrorResponse } from "$lib/server/pi-fleet-http";
import type { RequestHandler } from "./$types";

const MailboxQuerySchema = z.object({
	environment: PiFleetEnvironmentSchema,
	name: z.string().min(1).optional(),
	limit: z.coerce.number().int().positive().max(100).optional(),
});

export const GET: RequestHandler = async ({ url }) => {
	try {
		const query = MailboxQuerySchema.parse({
			environment: url.searchParams.get("environment") ?? undefined,
			name: url.searchParams.get("name") ?? undefined,
			limit: url.searchParams.get("limit") ?? undefined,
		});
		return json(await readFleetMailbox(query));
	} catch (err) {
		return piFleetErrorResponse(err);
	}
};
