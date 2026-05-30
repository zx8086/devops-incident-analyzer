// apps/web/src/routes/api/aws/estates/+server.ts

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

// SIO-836: Expose the configured AWS estate IDs (and per-estate region) to the frontend so the
// user can scope incident queries to specific estates. Reads the same AWS_ESTATES env the AWS
// MCP server uses -- both processes must see the same list. Region falls back to AWS_REGION.
// Validation mirrors aws-estate-router.ts: reject arrays/primitives/parse errors -> empty list.
interface EstateInfo {
	id: string;
	region: string;
}

function listEstates(): EstateInfo[] {
	const raw = process.env.AWS_ESTATES;
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return [];
	}
	const fallbackRegion = process.env.AWS_REGION ?? "";
	return Object.entries(parsed as Record<string, unknown>).map(([id, value]) => {
		const region =
			typeof value === "object" && value !== null && typeof (value as { region?: unknown }).region === "string"
				? (value as { region: string }).region
				: fallbackRegion;
		return { id, region };
	});
}

export const GET: RequestHandler = async () => {
	return json({ estates: listEstates() });
};
