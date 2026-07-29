// packages/agent/src/absence-judge.ts
//
// SIO-1158: LLM veto for the premature-absence confidence cap's CONTRADICTED arm.
// detectPrematureAbsence (aggregator.ts, SIO-1085) flags a line as contradicted when it
// makes an absence claim, names a datasource keyword, and that datasource returned ANY
// data this turn -- a datasource-LEVEL boolean with no scope matching. Two production
// false-positive shapes motivated this judge (a 2026-07 production report, capped
// 0.84 -> 0.59):
//   1. a correctly-grounded, phrase-SCOPED zero-hit search result ("zero hits for the
//      HTTP 500 phrase") flagged because the datasource returned OTHER data;
//   2. a claim grounded in a DIFFERENT datasource (an AWS CloudWatch finding) flagged
//      because the line incidentally mentioned "Elasticsearch APM".
// A regex cannot separate those from the genuine SIO-1085 true positive ("0 hits for
// error X" while elastic returned Total results: 91 for X) -- only a judge that sees
// what the flagging datasource actually returned can. Safety property mirrors
// gaps-judge.ts (SIO-1149): the judge only ever sees regex-flagged lines and returns
// per-claim booleans over that set -- it can shrink the contradicted set, never grow
// it -- and any failure (timeout, parse error, shape mismatch) returns null so the
// deterministic verdict stands (fail-closed: the cap applies).
//
// PII note: the evidence digest is raw tool output, the same material the aggregator
// LLM call already receives in its results block; redaction happens on the answer.

import { getLogger } from "@devops-agent/observability";
import type { DataSourceResult } from "@devops-agent/shared";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createLlm, type InvokableLlm, invokeWithDeadline } from "./llm.ts";
import { parseLlmJson } from "./llm-json.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { truncateToolOutput } from "./sub-agent-truncate-tool-output.ts";

const logger = getLogger("agent:absence-judge");

// A contradicted-flagged report line plus the datasource whose returned data flagged it.
export interface AbsenceClaim {
	line: string;
	dataSourceId: string;
	// SIO-1266: set only on the UNVERIFIABLE arm -- the tool this line cites whose calls all failed
	// this turn. Optional because the CONTRADICTED arm (the only one the judge sees) never has one.
	failedTool?: string;
}

// Default ON; "false"/"0" disables the veto entirely (the regex verdict then always
// stands). Read at call time -- no module-scope env reads in packages/agent.
export function isAbsenceJudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.ABSENCE_JUDGE_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// SIO-1270: `reason` is OPTIONAL. Requiring it made a model that returned a perfectly usable
// verdict (index + contradictedByData) fail safeParse -> mapVerdicts returns null -> the caller
// keeps the regex verdict and ships the "treat the returned data as ground truth" caveat. That is
// a whole failure mode traded for a field mapVerdicts discards before it is ever logged. Kept in
// the schema and the prompt because a model asked to justify a verdict is better calibrated than
// one told to emit a bare boolean; it is simply no longer load-bearing.
export const AbsenceJudgeResponseSchema = z.object({
	verdicts: z.array(
		z.object({
			index: z.number().int().min(0),
			contradictedByData: z.boolean(),
			reason: z.string().optional(),
		}),
	),
});

// SIO-1198: verdict schema for the OVERGENERALIZED arm (true = genuinely universal
// absence assertion, keep flagged; false = explicitly scoped claim, veto the flag).
export const OvergeneralizedJudgeResponseSchema = z.object({
	verdicts: z.array(
		z.object({
			index: z.number().int().min(0),
			overgeneralizedAbsence: z.boolean(),
			// SIO-1270: optional for the same reason as the contradicted arm above.
			reason: z.string().optional(),
		}),
	),
});

const JUDGE_PROMPT = `You review flagged sentences from a DevOps incident report. Each sentence makes an ABSENCE claim (zero hits, no records, not present, does not ship) and mentions a datasource whose own sub-agent returned SOME data this turn. A keyword filter flagged the sentence as possibly contradicted by that data. Decide for EACH sentence whether the returned data ACTUALLY CONTRADICTS that sentence's specific claim.

contradictedByData = true ONLY when the evidence for the sentence's labelled datasource contains the very data the sentence declares absent -- for example the sentence says "0 hits for X" or "service does not ship logs" while the evidence shows matching hits for X or log documents from that service.

Evidence lines beginning "- [datasource] ERROR <tool>:" are tool FAILURES, not data. They tell you a call did not produce a result.

contradictedByData = false when:
- the sentence reports a correctly SCOPED negative result (a search for a specific phrase, field, error, or index returned zero) and the evidence merely shows OTHER data from the same datasource -- a scoped zero-hit finding is valid even when the datasource is not empty;
- the sentence's absence claim is actually grounded in a DIFFERENT datasource than the labelled one, which is only mentioned incidentally (for example a CloudWatch/AWS finding in a sentence that also names Elasticsearch APM);
- the sentence CITES A TOOL that the evidence reports as ERROR this turn (and not as recovered): a claim resting on a call that failed was never measured at all, so data returned by OTHER calls cannot contradict it;
- the sentence scopes its claim to a TIME WINDOW ("0 hits between 05:12Z and 06:12Z", "in the last hour", "in the exact window") and the evidence covers a DIFFERENT or WIDER period. Hits outside the sentence's window do not contradict a claim about that window -- 121 hits over 30 days says nothing about one hour. Answer true only if the evidence shows matching data INSIDE the stated window;
- the evidence is unrelated to the entity, phrase, field, or window the sentence names.

Return ONLY JSON, no prose, with exactly one verdict per sentence index. Keep each "reason" under 15 words, and omit "reason" entirely if that helps you finish within the response limit -- a complete set of verdicts matters far more than the justifications:
{"verdicts": [{"index": 0, "contradictedByData": true, "reason": "..."}]}`;

// Byte bounds for the evidence digest: per tool-output/findings entry and per
// datasource, reusing the JSON-aware truncator so structured payloads shrink sanely.
const DIGEST_PER_ENTRY_CAP_BYTES = 2_048;
const DIGEST_PER_DATASOURCE_CAP_BYTES = 8_192;
// SIO-1266: share of a deployment's budget reserved for the ERROR block, carved OUT of the payload
// budget rather than added on top, so DIGEST_PER_DATASOURCE_CAP_BYTES still binds. Applied only to
// labels that actually have errors, so a digest with no toolErrors renders byte-identically to
// pre-SIO-1266 output.
const DIGEST_ERROR_BUDGET_FRACTION = 0.25;
const DIGEST_ERROR_MESSAGE_CAP_BYTES = 256;

// Renders what one datasource's sub-agent returned this turn: the same structures
// dataSourceReturnedData (aggregator.ts) inspects, so the judge sees exactly the
// evidence that caused the regex flag.
export function buildAbsenceEvidenceDigest(results: DataSourceResult[], dataSourceId: string): string {
	const parts: string[] = [];
	const errorParts: string[] = [];
	for (const r of results) {
		if (r.dataSourceId !== dataSourceId) continue;
		const label = r.deploymentId ? `${r.dataSourceId}/${r.deploymentId}` : r.dataSourceId;
		// SIO-1266: the judge could not previously see that a call FAILED. It was shown what the
		// datasource RETURNED and asked "does this contradict the claim?", so a claim resting on a
		// failed query was indistinguishable from one resting on a genuine zero-hit result. On run
		// 2445908e it answered keep:true about a 1-HOUR claim whose msearch had errored, weighed
		// against 30-DAY evidence. `recovered` is surfaced verbatim so the judge can tell a
		// self-corrected call (SIO-1164) from a dead one.
		for (const e of r.toolErrors ?? []) {
			const status = typeof e.statusCode === "number" ? ` (HTTP ${e.statusCode})` : "";
			const recovered = e.recovered ? " [a later call to this tool SUCCEEDED]" : "";
			const message = truncateToolOutput(e.message ?? "", DIGEST_ERROR_MESSAGE_CAP_BYTES).content;
			errorParts.push(`- [${label}] ERROR ${e.toolName}: ${e.kind ?? e.category}${status} -- ${message}${recovered}`);
		}
		for (const out of r.toolOutputs ?? []) {
			const rendered = typeof out.rawJson === "string" ? out.rawJson : JSON.stringify(out.rawJson);
			if (rendered == null || rendered === "") continue;
			parts.push(`- [${label}] ${out.toolName}: ${truncateToolOutput(rendered, DIGEST_PER_ENTRY_CAP_BYTES).content}`);
		}
		const findings: Array<[string, unknown]> = [
			["elasticFindings", r.elasticFindings],
			["kafkaFindings", r.kafkaFindings],
			["couchbaseFindings", r.couchbaseFindings],
			["gitlabFindings", r.gitlabFindings],
			// SIO-1242: awsFindings/atlassianFindings were omitted, so on an AWS-attributed claim the
			// judge saw tool outputs but none of the typed evidence -- part of why it kept a correct
			// confirmed-negative on run 43796e9f.
			["awsFindings", r.awsFindings],
			["atlassianFindings", r.atlassianFindings],
		];
		for (const [name, value] of findings) {
			if (value == null) continue;
			parts.push(
				`- [${label}] findings.${name}: ${truncateToolOutput(JSON.stringify(value), DIGEST_PER_ENTRY_CAP_BYTES).content}`,
			);
		}
	}
	// SIO-1266: a datasource with errors but NO payloads used to render only this placeholder,
	// hiding the failure completely. The exact string is preserved for the genuinely-empty case --
	// an existing test pins it for an unknown datasource.
	const placeholder = "(no data returned by this datasource this turn)";
	if (parts.length === 0 && errorParts.length === 0) return placeholder;
	// SIO-1242: the cap used to apply to the whole datasource, so on a multi-estate turn the first
	// estate could consume the entire 8KB and the second was truncated away -- the judge then ruled
	// on a claim about an estate whose evidence it had never seen. Budget PER deployment instead.
	const deployments = new Set(results.filter((r) => r.dataSourceId === dataSourceId).map((r) => r.deploymentId ?? ""));
	const perGroupBudget = Math.max(1, Math.floor(DIGEST_PER_DATASOURCE_CAP_BYTES / Math.max(1, deployments.size)));
	const labelOf = (part: string) => /^- \[([^\]]+)\]/.exec(part)?.[1] ?? "";
	const byLabel = new Map<string, string[]>();
	for (const part of parts) {
		byLabel.set(labelOf(part), [...(byLabel.get(labelOf(part)) ?? []), part]);
	}
	// SIO-1266: errors are grouped by the same label and emitted FIRST within their group, so they
	// survive any truncation of that group's payloads.
	const errorsByLabel = new Map<string, string[]>();
	for (const part of errorParts) {
		errorsByLabel.set(labelOf(part), [...(errorsByLabel.get(labelOf(part)) ?? []), part]);
	}
	const labels = [...new Set([...byLabel.keys(), ...errorsByLabel.keys()])];
	return labels
		.map((label) => {
			const errs = errorsByLabel.get(label) ?? [];
			const payloads = byLabel.get(label) ?? [];
			// Only a group that HAS errors pays the reservation, so the no-error path is unchanged.
			if (errs.length === 0) return truncateToolOutput(payloads.join("\n"), perGroupBudget).content;
			const errorBudget = Math.max(1, Math.floor(perGroupBudget * DIGEST_ERROR_BUDGET_FRACTION));
			const rendered = [truncateToolOutput(errs.join("\n"), errorBudget).content];
			if (payloads.length > 0) {
				rendered.push(truncateToolOutput(payloads.join("\n"), perGroupBudget - errorBudget).content);
			} else {
				rendered.push(placeholder);
			}
			return rendered.join("\n");
		})
		.join("\n");
}

// Test seam mirroring _setGapsJudgeLlmForTesting: sibling suites mock @langchain/aws
// at module scope (process-global in unisolated bun test), so this module's tests
// inject the LLM here instead of adding another module mock.
let overrideLlm: InvokableLlm | null = null;
export function _setAbsenceJudgeLlmForTesting(llm: InvokableLlm | null): void {
	overrideLlm = llm;
}

// Returns one boolean per input claim (true = contradiction confirmed, keep flagged),
// or null when the judge is unavailable (any error, timeout, or malformed response).
export async function judgeContradictedAbsenceClaims(
	claims: AbsenceClaim[],
	results: DataSourceResult[],
	config?: { signal?: AbortSignal },
): Promise<boolean[] | null> {
	if (claims.length === 0) return [];
	try {
		const llm = overrideLlm ?? (createLlm("absenceJudge") as unknown as InvokableLlm);
		const dsIds = [...new Set(claims.map((c) => c.dataSourceId))];
		const evidence = dsIds
			.map((ds) => `--- datasource ${ds} returned this turn ---\n${buildAbsenceEvidenceDigest(results, ds)}`)
			.join("\n\n");
		const numbered = claims.map((c, i) => `${i}: [datasource: ${c.dataSourceId}] ${c.line}`).join("\n");
		const result = await invokeWithDeadline(
			llm,
			"absenceJudge",
			[new SystemMessage(JUDGE_PROMPT), new HumanMessage(`Evidence:\n${evidence}\n\nFlagged sentences:\n${numbered}`)],
			config,
		);
		return mapVerdicts(
			extractTextFromContent(result.content),
			claims.length,
			(raw) => {
				const parsed = AbsenceJudgeResponseSchema.safeParse(raw);
				return parsed.success
					? parsed.data.verdicts.map((v) => ({ index: v.index, keep: v.contradictedByData }))
					: null;
			},
			"absence judge",
		);
	} catch (error) {
		// Parity with gaps-judge (CodeRabbit, PR #416): a caller-requested cancellation
		// must propagate -- only judge-local failures (including the 8s role deadline)
		// fail closed to the regex verdict.
		if (config?.signal?.aborted) throw error;
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "absence judge failed");
		return null;
	}
}

// Shared verdict extraction: tolerate fenced/garnished JSON, require exactly one
// verdict per claim, indexes in range, no duplicates -- anything else is malformed
// and the deterministic verdict must stand (fail-closed).
function mapVerdicts(
	content: string,
	claimCount: number,
	extract: (raw: unknown) => Array<{ index: number; keep: boolean }> | null,
	label: string,
): boolean[] | null {
	// SIO-1221: this JSON.parse used to be bare, so a SyntaxError propagated to the
	// callers' catch -- where `if (config?.signal?.aborted) throw error` re-threw it as
	// if it were a caller cancellation whenever the request signal happened to be
	// aborted. parseLlmJson never throws, so malformed JSON now always fails closed here
	// and only genuine invoke-level errors reach that abort check.
	const parsed = parseLlmJson(content, z.unknown());
	if (!parsed.ok) {
		logger.warn(
			{ reason: parsed.reason, detail: parsed.message, contentLength: content.length },
			`${label} response unusable`,
		);
		return null;
	}
	const verdicts = extract(parsed.data);
	if (verdicts === null) {
		logger.warn({ label }, `${label} response failed schema validation`);
		return null;
	}
	if (verdicts.length !== claimCount) {
		logger.warn({ expected: claimCount, got: verdicts.length }, `${label} verdict count mismatch`);
		return null;
	}
	const out: Array<boolean | undefined> = new Array(claimCount).fill(undefined);
	for (const v of verdicts) {
		if (v.index >= claimCount || out[v.index] !== undefined) {
			logger.warn({ index: v.index }, `${label} verdict index out of range or duplicated`);
			return null;
		}
		out[v.index] = v.keep;
	}
	// Reasons are logged upstream of extraction; keep flags logged for audit here.
	logger.info({ label, verdicts }, "judge verdicts");
	return out as boolean[];
}

// SIO-1198 Part A: veto judge for the OVERGENERALIZED arm. The question is TEXTUAL --
// is the claim a genuinely universal absence assertion, or is it explicitly scoped to
// what was actually checked? Tool INPUTS are not persisted in state (toolOutputs hold
// results only), and this arm's regex fires on phrasing, not data contradiction, so no
// evidence digest is sent. Same safety contract: shrink-only, fail-closed on any error.
const OVERGENERALIZED_JUDGE_PROMPT = `You review flagged sentences from a DevOps incident report. Each was flagged by a keyword filter as a possibly OVER-GENERALIZED absence claim (phrases like "absent from all", "all records", "entirely absent", "whole pipeline"). Decide for EACH sentence whether it truly asserts a UNIVERSAL absence beyond what could have been verified.

overgeneralizedAbsence = true ONLY when the sentence asserts absence universally with no stated scope -- "entirely absent from all records", "never populated anywhere", "the whole pipeline is empty" -- claims that a partial investigation cannot support.

overgeneralizedAbsence = false when the sentence explicitly SCOPES its claim to what was checked: it enumerates the specific collections, indexes, tables, or windows examined (e.g. "absent from all queried collections: a.b, c.d, e.f"), or qualifies with words like "queried", "sampled", "checked", "examined", "in the N collections listed". A scoped negative over an enumerated set is a valid finding, not an over-generalization.

Return ONLY JSON, no prose, with exactly one verdict per sentence index. Keep each "reason" under 15 words, and omit "reason" entirely if that helps you finish within the response limit -- a complete set of verdicts matters far more than the justifications:
{"verdicts": [{"index": 0, "overgeneralizedAbsence": true, "reason": "..."}]}`;

export async function judgeOvergeneralizedAbsenceClaims(
	lines: string[],
	config?: { signal?: AbortSignal },
): Promise<boolean[] | null> {
	if (lines.length === 0) return [];
	try {
		const llm = overrideLlm ?? (createLlm("absenceJudge") as unknown as InvokableLlm);
		const numbered = lines.map((line, i) => `${i}: ${line}`).join("\n");
		const result = await invokeWithDeadline(
			llm,
			"absenceJudge",
			[new SystemMessage(OVERGENERALIZED_JUDGE_PROMPT), new HumanMessage(`Flagged sentences:\n${numbered}`)],
			config,
		);
		return mapVerdicts(
			extractTextFromContent(result.content),
			lines.length,
			(raw) => {
				const parsed = OvergeneralizedJudgeResponseSchema.safeParse(raw);
				return parsed.success
					? parsed.data.verdicts.map((v) => ({ index: v.index, keep: v.overgeneralizedAbsence }))
					: null;
			},
			"overgeneralized-absence judge",
		);
	} catch (error) {
		if (config?.signal?.aborted) throw error;
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"overgeneralized-absence judge failed",
		);
		return null;
	}
}
