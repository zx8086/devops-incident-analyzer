// agent/src/gaps-judge.ts
//
// SIO-1149: LLM veto for the Gaps confidence cap. The deterministic classifier in
// aggregator.ts (isDegradingGapBullet) flags Gaps bullets that read as tool/query
// failures; when enough flag to trigger the 0.59 cap, this judge re-examines the
// flagged bullets semantically and may EXEMPT false positives (incident-narrative
// vocabulary, recovered-via-alternate-path items, cross-estate absences). Safety
// property: the judge only ever sees regex-flagged bullets and returns per-bullet
// booleans over that set -- it can lower the degrading count, never raise it --
// and any failure (timeout, parse error, shape mismatch) returns null so the
// deterministic verdict stands (fail-closed: the cap applies).

import { getLogger } from "@devops-agent/observability";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createLlm, type InvokableLlm, invokeWithDeadline } from "./llm.ts";

const logger = getLogger("agent:gaps-judge");

// Default ON; "false"/"0" disables the veto entirely (the regex verdict then always
// stands). Read at call time -- no module-scope env reads in packages/agent.
export function isGapsJudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.GAPS_JUDGE_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

export const GapsJudgeResponseSchema = z.object({
	verdicts: z.array(
		z.object({
			index: z.number().int().min(0),
			genuineUnrecoveredFailure: z.boolean(),
			reason: z.string(),
		}),
	),
});

const JUDGE_PROMPT = `You review "Gaps" bullets from a DevOps incident report. Each bullet was flagged by a keyword filter as a possible investigation-tooling failure. Decide for EACH bullet whether it reports a GENUINE UNRECOVERED coverage failure.

genuineUnrecoveredFailure = true ONLY when BOTH hold:
1. An investigation tool, query, or data access malfunctioned (failed, errored, timed out, was denied or unavailable), AND
2. the missing data was NOT obtained via any alternate path (no fallback tool, no other datasource).

genuineUnrecoveredFailure = false when the bullet:
- describes the incident's own errors/failures (the system under investigation), not the tooling used to investigate it;
- says the data was recovered/obtained/completed via a fallback tool or a different datasource;
- reports a service present in one account/estate but absent from another (a scoping finding, not missing data);
- is a routine "no data found / not applicable / not yet queried" outcome.

Return ONLY JSON, no prose, with exactly one verdict per bullet index:
{"verdicts": [{"index": 0, "genuineUnrecoveredFailure": true, "reason": "..."}]}`;

// Test seam mirroring _setAggregatorLoggerForTesting: sibling suites mock
// @langchain/aws at module scope (process-global in unisolated bun test), so this
// module's tests inject the LLM here instead of adding another module mock.
let overrideLlm: InvokableLlm | null = null;
export function _setGapsJudgeLlmForTesting(llm: InvokableLlm | null): void {
	overrideLlm = llm;
}

// Returns one boolean per input bullet (true = confirmed degrading), or null when
// the judge is unavailable (any error, timeout, or malformed response). Bullets
// arrive already PII-redacted: the aggregator redacts the whole answer before
// parsing the Gaps section out of it.
export async function judgeDegradingGapBullets(
	bullets: string[],
	config?: { signal?: AbortSignal },
): Promise<boolean[] | null> {
	if (bullets.length === 0) return [];
	try {
		const llm = overrideLlm ?? (createLlm("gapsJudge") as unknown as InvokableLlm);
		const numbered = bullets.map((b, i) => `${i}: ${b}`).join("\n");
		const result = await invokeWithDeadline(
			llm,
			"gapsJudge",
			[new SystemMessage(JUDGE_PROMPT), new HumanMessage(`Bullets:\n${numbered}`)],
			config,
		);
		const content = typeof result.content === "string" ? result.content : "";
		// Tolerate fenced/garnished JSON: pull the first {...} block (skill-learner idiom).
		const match = content.match(/\{[\s\S]*\}/);
		if (!match) {
			logger.warn({ contentLength: content.length }, "gaps judge returned no JSON object");
			return null;
		}
		const parsed = GapsJudgeResponseSchema.safeParse(JSON.parse(match[0]));
		if (!parsed.success) {
			logger.warn({ issueCount: parsed.error.issues.length }, "gaps judge response failed schema validation");
			return null;
		}
		// Exactly one verdict per bullet, indexes in range, no duplicates -- anything
		// else is malformed and the deterministic verdict must stand.
		if (parsed.data.verdicts.length !== bullets.length) {
			logger.warn({ expected: bullets.length, got: parsed.data.verdicts.length }, "gaps judge verdict count mismatch");
			return null;
		}
		const out: Array<boolean | undefined> = new Array(bullets.length).fill(undefined);
		for (const v of parsed.data.verdicts) {
			if (v.index >= bullets.length || out[v.index] !== undefined) {
				logger.warn({ index: v.index }, "gaps judge verdict index out of range or duplicated");
				return null;
			}
			out[v.index] = v.genuineUnrecoveredFailure;
		}
		// Reasons are logged for audit: a vetoed cap must be explainable after the fact.
		logger.info({ verdicts: parsed.data.verdicts }, "gaps judge verdicts");
		return out as boolean[];
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "gaps judge failed");
		return null;
	}
}
