// apps/web/src/routes/api/pi/messages/+server.ts
// SIO-1650: POST sends one operator prompt to one spoke and waits one await
// slice; GET re-awaits the same message by id. The browser loops on GET until
// the reply is terminal or the pane budget is spent, so no request hangs.
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { awaitFleetMessage, sendFleetMessage } from "$lib/server/pi-fleet";
import { piFleetErrorResponse } from "$lib/server/pi-fleet-http";
import type { RequestHandler } from "./$types";

const SendRequestSchema = z.object({
	// SIO-1666: addressed by hub key, not environment.
	hubKey: z.string().min(1),
	target: z.string().min(1),
	prompt: z.string().trim().min(1).max(20_000),
});

const AwaitQuerySchema = z.object({
	// SIO-1666: addressed by hub key, not environment.
	hubKey: z.string().min(1),
	msgId: z.string().min(1),
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = SendRequestSchema.parse(await request.json());
		return json(await sendFleetMessage(body));
	} catch (err) {
		return piFleetErrorResponse(err);
	}
};

export const GET: RequestHandler = async ({ url }) => {
	try {
		const query = AwaitQuerySchema.parse({
			hubKey: url.searchParams.get("hubKey") ?? undefined,
			msgId: url.searchParams.get("msgId") ?? undefined,
		});
		return json(await awaitFleetMessage(query));
	} catch (err) {
		return piFleetErrorResponse(err);
	}
};
