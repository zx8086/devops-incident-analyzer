// apps/web/src/routes/api/deployments/+server.ts

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

// SIO-649: Expose the configured elastic deployment IDs to the frontend so the user can
// scope incident queries to specific deployments. Reads the same ELASTIC_DEPLOYMENTS env
// the elastic MCP server uses -- both processes must see the same list.
function listDeploymentIds(): string[] {
	const raw = process.env.ELASTIC_DEPLOYMENTS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export const GET: RequestHandler = async () => {
	return json({ deployments: listDeploymentIds() });
};
