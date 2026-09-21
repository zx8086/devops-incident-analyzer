// scripts/monitor/typesafe.ts
// SIO-1838: TypeSafe System One (Jev) client for the monitor.
//
// A deliberate near-duplicate of packages/agent/src/typesafe-client.ts, not a
// shared module: the monitor runs on the spoke hosts from a bundle that carries
// only packages/pi-coms, so it cannot import from packages/agent. Zod is fine
// here -- the nested scripts/package.json has it (the no-Zod rule, SIO-1632, is
// about the Pi EXTENSION, which Pi installs separately).
//
// Jev classifies; it cannot count, do arithmetic, or compare dates, so nothing
// time-based goes through it (vendor's jev-1.13 jaggedness page).
import { z } from "zod";

// Pinned, never the `jev-latest` alias: thresholds are tuned per version, and an
// alias moving would silently retune the gate.
export const JEV_MODEL = "jev-1.13.0";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// Captured from a live jev-1.13.0 call on 2026-09-20, not written from the docs.
const NoulAnswerSchema = z.object({
	type: z.literal("noul"),
	noul: z.number(),
});

const SystemOneResponseSchema = z.object({
	model: z.string(),
	answers: z.record(z.string(), NoulAnswerSchema),
	usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;

export interface NoulQuestion {
	type: "noul";
	instructions: string;
}

export function resolveTypeSafeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	// NODE_ENV=test returns nothing so no unit test can reach the network or spend
	// money. Same guard the agent-side client uses, for the same measured reason.
	if (env.NODE_ENV === "test") return undefined;
	const raw = env.TYPESAFE_API_KEY?.trim();
	return raw ? raw : undefined;
}

/**
 * One System One request. Throws on a non-2xx or a body that does not match the
 * captured shape; every caller treats a throw as "fall back to today's
 * behaviour", never as a reason to fail a monitor cycle.
 */
export async function askSystemOne(options: {
	state: unknown;
	questions: Record<string, NoulQuestion>;
	apiKey: string;
	signal?: AbortSignal;
	model?: string;
}): Promise<SystemOneResponse> {
	const response = await fetch(ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: options.model ?? JEV_MODEL, state: options.state, questions: options.questions }),
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (!response.ok) {
		// Status only: the body can echo the state back, and monitor logs are
		// operator-visible.
		throw new Error(`TypeSafe request failed with status ${response.status}`);
	}
	return SystemOneResponseSchema.parse(await response.json());
}
