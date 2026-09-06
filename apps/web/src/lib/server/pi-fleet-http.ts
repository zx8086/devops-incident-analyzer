// apps/web/src/lib/server/pi-fleet-http.ts
// SIO-1650: one error envelope for the /api/pi/* routes. Same shape as the
// actions route: { error, details } on validation, { error } otherwise.
import { PiComsHttpError } from "@devops-agent/agent";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { PiFleetRequestError } from "$lib/server/pi-fleet";

export function piFleetErrorResponse(err: unknown): Response {
	if (err instanceof z.ZodError) return json({ error: "Invalid request", details: err.issues }, { status: 400 });
	if (err instanceof PiFleetRequestError) return json({ error: err.message }, { status: err.status });
	// The hub answered with an error status: the upstream is at fault, not the request.
	if (err instanceof PiComsHttpError) return json({ error: err.message }, { status: 502 });
	return json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
}
