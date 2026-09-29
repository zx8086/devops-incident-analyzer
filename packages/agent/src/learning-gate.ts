// agent/src/learning-gate.ts
//
// SIO-1889: the Jev learning gate. agent-beacon's three yes/no questions on the
// existing System One seam (typesafe-client.ts), deciding whether a completed
// session, or a redacted fleet journal group (SIO-1892), is worth a full-model
// judge call, and seeding the candidate's task_success. Beacon's rule
// (candidate.go:19-47): task_success >= 0.5 is a hard precondition the mean
// cannot override; only then is the mean of the three compared with 0.6.
//
// Jev judges "reusable and evidence-backed", never "important": SIO-1883 measured
// that it cannot judge urgency from a summary. Priority stays human (SIO-1891).
// Every verdict is a decision_metrics row, so the thresholds can be calibrated
// from the table the way RERANK_DROP_BELOW was.

import { redactPiiContent } from "@devops-agent/shared";
import { recordDecision } from "./decision-recorder.ts";
import { askSystemOne, asNoul, type NoulQuestion, resolveTypeSafeApiKey } from "./typesafe-client.ts";

export const TASK_SUCCESS_FLOOR = 0.5;
export const QUALIFY_MEAN = 0.6;

export type LearningQuestionId = "task_success" | "reusable_correction" | "evidence_supported";

// Backticked `session` names the state key, as the monitor's judge does.
export const LEARNING_QUESTIONS: Record<LearningQuestionId, NoulQuestion> = {
	task_success: {
		type: "noul",
		instructions: "Did `session` complete the user's engineering task successfully?",
	},
	reusable_correction: {
		type: "noul",
		instructions:
			"Does `session` contain a correction, gotcha or investigation procedure that future sessions on similar work should reuse?",
	},
	evidence_supported: {
		type: "noul",
		instructions: "Is that reusable lesson supported by concrete events shown in `session`, not just asserted?",
	},
};

// Default ON, kill-switch read (the HIL_LEARNING_ENABLED idiom). Availability
// still follows infrastructure: without a TypeSafe key the gate self-skips.
export function isLearningJevGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.LEARNING_JEV_GATE_ENABLED;
	return v !== "false" && v !== "0";
}

export type LearningProbabilities = Record<LearningQuestionId, number>;

export interface LearningVerdict {
	qualifies: boolean;
	// Mean of the three probabilities, after any thumbs override.
	score: number;
	taskSuccess: number;
	// "qualifies", or the question that failed. Enum-ish, never model text.
	reason: string;
}

// Pure. A thumbs score (SIO-1890) REPLACES task_success rather than averaging
// with it: a human said whether the task succeeded, so the estimate is moot.
export function judgeLearning(p: LearningProbabilities, thumbs?: 0 | 1): LearningVerdict {
	const taskSuccess = thumbs === undefined ? p.task_success : thumbs;
	const score = (taskSuccess + p.reusable_correction + p.evidence_supported) / 3;
	if (taskSuccess < TASK_SUCCESS_FLOOR) return { qualifies: false, score, taskSuccess, reason: "task_success" };
	if (score < QUALIFY_MEAN) {
		const weakest = p.reusable_correction <= p.evidence_supported ? "reusable_correction" : "evidence_supported";
		return { qualifies: false, score, taskSuccess, reason: weakest };
	}
	return { qualifies: true, score, taskSuccess, reason: "qualifies" };
}

// Head-plus-tail projection (beacon's BuildProjection): the first and last
// PROJECTION_HEAD/TAIL events, each capped and PII-redacted, with the omitted
// middle marked so the judge knows it is looking at a window.
export const PROJECTION_HEAD = 40;
export const PROJECTION_TAIL = 40;
export const PROJECTION_FIELD_CAP = 1200;

export function projectEvents(events: string[]): string[] {
	const clean = events.map((e) => redactPiiContent(e.slice(0, PROJECTION_FIELD_CAP)));
	if (clean.length <= PROJECTION_HEAD + PROJECTION_TAIL) return clean;
	const omitted = clean.length - PROJECTION_HEAD - PROJECTION_TAIL;
	return [...clean.slice(0, PROJECTION_HEAD), `[... ${omitted} events omitted ...]`, ...clean.slice(-PROJECTION_TAIL)];
}

// A transcript string becomes events at paragraph breaks, then single lines
// when a turn has no paragraphs: the same window rule either way.
export function transcriptToEvents(transcript: string): string[] {
	const paragraphs = transcript
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	if (paragraphs.length > 1) return paragraphs;
	return transcript
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

export type LearningGateResult =
	// Jev answered; the verdict decides.
	| { outcome: "applied"; verdict: LearningVerdict; model: string }
	// Flag off or no key: the caller proceeds on its own signals.
	| { outcome: "skipped"; reason: "disabled" | "no-key" }
	// The call threw or returned a malformed answer: same fallback as skipped,
	// recorded separately so the applied/failed ratio stays visible.
	| { outcome: "failed"; reason: string };

export interface LearningGateInput {
	// Already-projected or raw events; projectEvents is applied here so every
	// caller is covered, including the fleet harvest.
	events: string[];
	thumbs?: 0 | 1;
	requestId?: string;
}

export interface LearningGateDeps {
	env?: NodeJS.ProcessEnv;
	apiKey?: string;
	ask?: typeof askSystemOne;
	signal?: AbortSignal;
	now?: () => number;
}

const GATE_DEADLINE_MS = 8_000;

export async function gateLearning(input: LearningGateInput, deps: LearningGateDeps = {}): Promise<LearningGateResult> {
	const env = deps.env ?? process.env;
	const seam = "learning-gate";
	if (!isLearningJevGateEnabled(env)) {
		recordDecision({ seam, outcome: "skipped", requestId: input.requestId, note: "disabled" });
		return { outcome: "skipped", reason: "disabled" };
	}
	const apiKey = deps.apiKey ?? resolveTypeSafeApiKey(env);
	if (!apiKey) {
		recordDecision({ seam, outcome: "skipped", requestId: input.requestId, note: "no-key" });
		return { outcome: "skipped", reason: "no-key" };
	}
	const ask = deps.ask ?? askSystemOne;
	const now = deps.now ?? Date.now;
	const started = now();
	try {
		const response = await ask({
			state: { session: projectEvents(input.events) },
			questions: LEARNING_QUESTIONS,
			apiKey,
			signal: deps.signal ?? AbortSignal.timeout(GATE_DEADLINE_MS),
		});
		const read = (id: LearningQuestionId): number => {
			const n = asNoul(response.answers[id])?.noul;
			if (n === undefined) throw new Error(`missing noul answer for ${id}`);
			return n;
		};
		const verdict = judgeLearning(
			{
				task_success: read("task_success"),
				reusable_correction: read("reusable_correction"),
				evidence_supported: read("evidence_supported"),
			},
			input.thumbs,
		);
		recordDecision({
			seam,
			outcome: "applied",
			requestId: input.requestId,
			model: response.model,
			latencyMs: now() - started,
			inputTokens: response.usage?.input_tokens,
			topScore: verdict.score,
			bottomScore: verdict.taskSuccess,
			note: verdict.reason,
		});
		return { outcome: "applied", verdict, model: response.model };
	} catch (error) {
		// Status or shape only, never upstream text: the metrics DB is read by
		// humans and the repo is public.
		const reason = error instanceof Error && /status \d+/.test(error.message) ? error.message : "call-failed";
		recordDecision({ seam, outcome: "failed", requestId: input.requestId, latencyMs: now() - started, note: reason });
		return { outcome: "failed", reason };
	}
}
