// apps/web/src/routes/api/agents/+server.ts
//
// SIO-1655: the agents this deployment can actually run. The client cannot
// decide this itself: the fleet console is gated on PI_FLEET_GRAPH_ENABLED and a
// configured pi-coms hub, both server-side. Same idea as the SIO-1650 pane,
// which hides until /api/pi/agents reports a configured hub.

import { json } from "@sveltejs/kit";
import { listSelectableAgents } from "$lib/server/graph-registry";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	// Ids, labels and surface only: no graph is compiled and no hub is contacted.
	// SIO-1657: `surface` lets the page partition modes (cycled by the header
	// control) from contextual agents WITHOUT re-listing ids client-side.
	const agents = listSelectableAgents().map((a) => ({ id: a.id, label: a.label, surface: a.surface }));
	return json({ agents });
};
