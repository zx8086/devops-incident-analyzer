// apps/web/src/routes/api/agent/actions/available/+server.ts
import { getAvailableActionTools } from "@devops-agent/agent";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	return json({ tools: getAvailableActionTools() });
};
