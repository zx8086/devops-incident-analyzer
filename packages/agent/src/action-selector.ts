// agent/src/action-selector.ts
// SIO-1839: pick a sub-agent's actions by what the query MEANS, not by which
// literal keyword it happens to contain.
//
// "Which tools does this query need" is currently one decision split across
// three mechanisms that do not know about each other:
//
//   1. matchActionsByKeywords, over hand-written keyword lists. `top 10`,
//      `top n` and `noisiest` are three list entries for one intent.
//   2. inferClusterHealthActions: six regexes, kafka only, added purely to patch
//      the first mechanism's false negatives ("Kafka Rest", "how is my Kafka
//      doing") -- a patch on a heuristic is the tell.
//   3. narrowOnHighPrecisionIntent: a drop-table with a documented failure --
//      a query asking for BOTH dead-letter queues and a topic's partition layout
//      had describe_topic dropped, so the tool was never bound and the run scored
//      0.5 on expected_tools_fired twice (SIO-1398).
//
// One Noul per action replaces the guessing. Multi-label rather than a Choice
// because several actions genuinely apply at once -- which is exactly what case 3
// gets wrong. Every action of a datasource is asked in ONE request (max 16 today,
// far inside the limits), so this is one round trip per sub-agent dispatch.
//
// The keyword pass stays as the fallback: on any failure this returns null and
// the caller keeps today's behaviour exactly.
import { getLogger } from "@devops-agent/observability";
import { askSystemOne, asNoul, resolveTypeSafeApiKey } from "./typesafe-client.ts";

const logger = getLogger("agent:action-selector");

// Default ON, kill-switch only.
export function isActionSelectorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.ACTION_SELECTOR_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// One deadline for the whole request. This sits on the critical path before the
// sub-agent fan-out, so it must not become the reason a turn feels slow.
export const SELECT_DEADLINE_MS = 4000;

// An action is included at or above this. Deliberately LOW relative to the
// monitor gate's 0.85: there the wrong answer suppresses an investigation, here
// it binds one more tool out of a 25-slot belt. Missing a needed tool is the
// expensive error (the model cannot answer), so this errs toward including.
export const ACTION_INCLUDE_THRESHOLD = 0.5;

export interface ActionSelection {
	actions: string[];
	model: string;
	inputTokens: number;
	latencyMs: number;
	// Per-action probabilities, for the decision-metrics row and for debugging a
	// surprising belt.
	scores: Record<string, number>;
}

// Why a round produced nothing. Returned instead of a bare null so a caller (and
// a test) can tell a well-handled incomplete answer from a crash that the catch
// happened to absorb -- without this the missing-answer guard could be deleted
// and every test would still pass, because `answer.noul` on undefined throws a
// TypeError straight into the same catch.
export type SelectFailure = "incomplete" | "error";

export type SelectResult = { ok: true; selection: ActionSelection } | { ok: false; reason: SelectFailure };

export type AskSystemOne = typeof askSystemOne;

/**
 * Ask, for each action, whether this query needs it.
 *
 * `actionKeywords` is the YAML's own keyword list per action: it is the only
 * description of an action's intent the repo has, and phrasing the question
 * around those terms keeps the judgement anchored to what the action actually
 * covers rather than to the model's guess about a bare identifier.
 *
 * Returns null on any failure, which means "use the keyword pass".
 */
export async function selectActions(
	query: string,
	actionKeywords: Record<string, string[]>,
	deps: { apiKey: string; ask?: AskSystemOne; signal?: AbortSignal },
): Promise<SelectResult> {
	const names = Object.keys(actionKeywords);
	if (names.length === 0 || query.trim().length === 0) return { ok: false, reason: "incomplete" };
	const ask = deps.ask ?? askSystemOne;
	const started = Date.now();

	// Question ids must round-trip an arbitrary action name. They are code-side
	// keys the model never sees (the docs are explicit), so a positional id keeps
	// the mapping exact regardless of what an action is called.
	const idFor = (i: number) => `a${i}`;
	const questions: Record<string, { type: "noul"; instructions: string }> = {};
	names.forEach((name, i) => {
		const kws = actionKeywords[name] ?? [];
		const covers = kws.length > 0 ? ` It covers: ${kws.join(", ")}.` : "";
		questions[idFor(i)] = {
			type: "noul",
			instructions: `To answer \`query\`, does the investigation need the "${name}" capability?${covers}`,
		};
	});

	try {
		const response = await ask({
			state: { query },
			questions,
			apiKey: deps.apiKey,
			signal: deps.signal ?? AbortSignal.timeout(SELECT_DEADLINE_MS),
		});

		const scores: Record<string, number> = {};
		const actions: string[] = [];
		for (const [i, name] of names.entries()) {
			const answer = asNoul(response.answers[idFor(i)]);
			// A missing answer for ANY action voids the round: a partial belt looks
			// like a considered selection while silently omitting whatever the model
			// did not answer for. The keyword pass is a better fallback than a
			// half-answered one.
			if (answer?.noul === undefined) {
				logger.warn(
					{ event: "action_selector.incomplete", action: name, asked: names.length },
					"Action selection incomplete; falling back to keywords",
				);
				return { ok: false, reason: "incomplete" };
			}
			scores[name] = answer.noul;
			if (answer.noul >= ACTION_INCLUDE_THRESHOLD) actions.push(name);
		}

		return {
			ok: true,
			selection: {
				actions,
				model: response.model,
				inputTokens: response.usage?.input_tokens ?? 0,
				latencyMs: Date.now() - started,
				scores,
			},
		};
	} catch (error) {
		logger.warn(
			{
				event: "action_selector.failed",
				actionCount: names.length,
				durationMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error),
			},
			"Action selection failed; falling back to keywords",
		);
		return { ok: false, reason: "error" };
	}
}

export { resolveTypeSafeApiKey };
