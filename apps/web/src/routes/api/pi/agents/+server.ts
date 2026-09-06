// apps/web/src/routes/api/pi/agents/+server.ts
// SIO-1650: the pi-fleet pane's peer listing, one row per configured hub.
import { json } from "@sveltejs/kit";
import { listFleetAgents } from "$lib/server/pi-fleet";
import { piFleetErrorResponse } from "$lib/server/pi-fleet-http";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	try {
		return json(await listFleetAgents());
	} catch (err) {
		return piFleetErrorResponse(err);
	}
};
