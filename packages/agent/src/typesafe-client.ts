// agent/src/typesafe-client.ts
// SIO-1837: the TypeSafe System One (Jev) client. Plain fetch against the single
// documented endpoint rather than @typesafe-ai/sdk: the whole surface we use is
// one POST, and a dependency would need approval for no gain.
//
// Jev is a classifier, not an LLM. It answers typed questions over a supplied
// state with calibrated probabilities and cannot generate text, count, do
// arithmetic, or compare dates -- keep all of that in code (vendor's own
// "jaggedness" page for jev-1.13).
import { z } from "zod";

// Pinned, never the `jev-latest` alias. An alias moves when a release ships and
// the drop threshold in atlassian-rerank.ts is tuned against a specific version's
// score distribution, so a silent model change would silently retune the gate.
export const JEV_MODEL = "jev-1.13.0";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// Captured from a live call on 2026-09-20, not written from the docs: a Score
// answer carries score/confidence/legend/probabilities, and usage reports input
// and output tokens (only input is billed).
const ScoreAnswerSchema = z.object({
	type: z.literal("score"),
	score: z.number(),
	confidence: z.number(),
	legend: z.record(z.string(), z.string()).optional(),
	probabilities: z.record(z.string(), z.number()).optional(),
});

const SystemOneResponseSchema = z.object({
	// The versioned id that actually answered. Logged rather than assumed equal to
	// the id we sent, so a server-side change is visible in the metrics.
	model: z.string(),
	answers: z.record(z.string(), ScoreAnswerSchema),
	usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;

export interface ScoreQuestion {
	type: "score";
	instructions: string;
	// Ordered level descriptions, index 0 lowest. The API accepts 2 to 10.
	criteria: string[];
}

export function resolveTypeSafeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.TYPESAFE_API_KEY?.trim();
	return raw ? raw : undefined;
}

/**
 * One System One request. Throws on a missing key, a non-2xx status, or a body
 * that does not match the captured shape; every caller in this repo treats a
 * throw as "fall back to the deterministic path" rather than failing the turn.
 */
export async function askSystemOne(options: {
	state: unknown;
	questions: Record<string, ScoreQuestion>;
	apiKey: string;
	signal?: AbortSignal;
	model?: string;
}): Promise<SystemOneResponse> {
	const { state, questions, apiKey, signal } = options;
	const response = await fetch(ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: options.model ?? JEV_MODEL, state, questions }),
		...(signal ? { signal } : {}),
	});
	if (!response.ok) {
		// Status only. The body can echo the state back, and this message reaches
		// logs in a public repo.
		throw new Error(`TypeSafe request failed with status ${response.status}`);
	}
	return SystemOneResponseSchema.parse(await response.json());
}
