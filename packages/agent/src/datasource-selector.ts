// agent/src/datasource-selector.ts
// SIO-1840: which datasources does this query need?
//
// The entityExtractor answers this today inside a structured-output call that
// ALSO extracts a time window, service names and a severity. Only the datasource
// half is a closed-set decision; the rest is generation, which a classifier
// cannot do. So this replaces one half and leaves the extractor to do the rest
// -- it stays the fallback, and on any failure here the turn is exactly as it
// was before.
//
// Why bother, given the extractor already works: it is the one narrow decision on
// every complex turn with no fast path and no cache, and its failure mode is
// silent and expensive. When the schema drifts, the catch falls back to ALL SEVEN
// datasources (SIO-1233), so a query naming one service fans out to everything.
// Seven independent Nouls cannot drift in that way: each is answerable on its own,
// and a missing answer is visible rather than collapsing the whole extraction.
import { getLogger } from "@devops-agent/observability";
import { asNoul, askSystemOne, resolveTypeSafeApiKey } from "./typesafe-client.ts";

const logger = getLogger("agent:datasource-selector");

export function isDatasourceSelectorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.DATASOURCE_SELECTOR_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// On the critical path before the fan-out, so it is bounded tightly.
export const SELECT_DEADLINE_MS = 4000;

// A datasource is queried at or above this. Low on purpose, and lower than it
// looks: a false positive costs one sub-agent that reports nothing useful, while
// a false negative means the evidence is never fetched and the answer is wrong
// with no sign that anything is missing. The existing fallback errs the same way
// (all seven), so this only ever narrows what that would have done.
export const DATASOURCE_INCLUDE_THRESHOLD = 0.4;

export interface DatasourceSelection {
	ids: string[];
	model: string;
	inputTokens: number;
	latencyMs: number;
	scores: Record<string, number>;
}

export type SelectFailure = "incomplete" | "error" | "empty";

export type DatasourceResult =
	| { ok: true; selection: DatasourceSelection }
	| { ok: false; reason: SelectFailure };

export type AskSystemOne = typeof askSystemOne;

/**
 * One Noul per datasource, all in one request.
 *
 * `descriptions` maps a datasource id to what it holds, so the question is about
 * the DATA rather than about a bare identifier -- "kafka" as a word appears in
 * plenty of queries that do not need the kafka sub-agent.
 */
export async function selectDatasources(
	query: string,
	descriptions: Record<string, string>,
	deps: { apiKey: string; ask?: AskSystemOne; signal?: AbortSignal },
): Promise<DatasourceResult> {
	const ids = Object.keys(descriptions);
	if (ids.length === 0 || query.trim().length === 0) return { ok: false, reason: "empty" };
	const ask = deps.ask ?? askSystemOne;
	const started = Date.now();

	// Positional ids: a datasource id is a safe key today, but the mapping should
	// not depend on that staying true.
	const idFor = (i: number) => `d${i}`;
	const questions: Record<string, { type: "noul"; instructions: string }> = {};
	ids.forEach((id, i) => {
		questions[idFor(i)] = {
			type: "noul",
			instructions: `Would answering \`query\` require evidence from ${descriptions[id]}?`,
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
		const selected: string[] = [];
		for (const [i, id] of ids.entries()) {
			const answer = asNoul(response.answers[idFor(i)]);
			// A partial answer is not a narrower selection, it is an unanswered
			// question -- and here an unasked datasource is evidence never fetched.
			if (answer?.noul === undefined) {
				logger.warn(
					{ event: "datasource_selector.incomplete", datasource: id, asked: ids.length },
					"Datasource selection incomplete; falling back to the entity extractor",
				);
				return { ok: false, reason: "incomplete" };
			}
			scores[id] = answer.noul;
			if (answer.noul >= DATASOURCE_INCLUDE_THRESHOLD) selected.push(id);
		}

		// Selecting NOTHING is never right for a complex turn: the query got this far
		// because the classifier called it complex, so something must be queried.
		// Treat it as a failure and let the extractor (and its all-datasources
		// fallback) decide, rather than dispatching to nobody.
		if (selected.length === 0) {
			logger.warn(
				{ event: "datasource_selector.empty", scores },
				"Datasource selection chose nothing; falling back to the entity extractor",
			);
			return { ok: false, reason: "empty" };
		}

		return {
			ok: true,
			selection: {
				ids: selected,
				model: response.model,
				inputTokens: response.usage?.input_tokens ?? 0,
				latencyMs: Date.now() - started,
				scores,
			},
		};
	} catch (error) {
		logger.warn(
			{
				event: "datasource_selector.failed",
				asked: ids.length,
				durationMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error),
			},
			"Datasource selection failed; falling back to the entity extractor",
		);
		return { ok: false, reason: "error" };
	}
}

export { resolveTypeSafeApiKey };
