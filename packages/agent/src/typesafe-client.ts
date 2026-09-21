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

// SIO-1839: a Noul answer is just a probability -- no confidence field, because
// for a yes/no the probability IS the confidence. Shape captured from a live
// jev-1.13.0 call, same as the Score one above.
const NoulAnswerSchema = z.object({
	type: z.literal("noul"),
	noul: z.number(),
});

// A request may mix the two, and a caller reads back whichever it asked for.
const AnswerSchema = z.union([ScoreAnswerSchema, NoulAnswerSchema]);

const SystemOneResponseSchema = z.object({
	// The versioned id that actually answered. Logged rather than assumed equal to
	// the id we sent, so a server-side change is visible in the metrics.
	model: z.string(),
	answers: z.record(z.string(), AnswerSchema),
	usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;

export interface ScoreQuestion {
	type: "score";
	instructions: string;
	// Ordered level descriptions, index 0 lowest. The API accepts 2 to 10.
	criteria: string[];
}

export interface NoulQuestion {
	type: "noul";
	instructions: string;
}

export type Question = ScoreQuestion | NoulQuestion;

export type Answer = z.infer<typeof AnswerSchema>;

// Narrowing helpers. The API returns whichever shape the question asked for, but
// a response is untrusted input, so a caller reads its answer through one of
// these rather than asserting the type it expects to get back.
export function asScore(answer: Answer | undefined): z.infer<typeof ScoreAnswerSchema> | undefined {
	return answer?.type === "score" ? answer : undefined;
}

export function asNoul(answer: Answer | undefined): z.infer<typeof NoulAnswerSchema> | undefined {
	return answer?.type === "noul" ? answer : undefined;
}

export function resolveTypeSafeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	// NODE_ENV=test returns nothing, so every seam self-skips and no unit test can
	// reach the network. Bun sets NODE_ENV=test and auto-loads .env, so without this
	// a developer with a real key in .env would have `bun run test` making live
	// billable calls -- measured: the extract-findings suite fired two real requests
	// and only passed because the failure path happens to fall back correctly.
	// Same guard shape as resolveToolCallMetricsDbPath / resolveDecisionMetricsDbPath.
	if (env.NODE_ENV === "test") return undefined;
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
	questions: Record<string, Question>;
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
