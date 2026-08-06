// packages/agent/src/eval/tool-trajectory.ts
//
// SIO-1398: projects the tool-call trajectory out of graph state so evaluators can grade
// TOOL-CALL correctness, not just report prose. Before this, every feedback key graded
// run.outputs.output.response (see dataset.ts's header and evaluators.ts's judge note), so
// "the LLM called the tool wrong" was structurally ungradeable.
//
// Source is DataSourceResult.toolErrors[]/toolOutputs[] -- already in memory on every run,
// already PII-redacted (extractToolErrors redacts + caps message at 500 chars). Deliberately
// NOT the SIO-1379 tool-calls-<leg>.jsonl audit trail: that is gated behind
// EVAL_FIXTURE_MODE=record (so it is absent on a normal run), it APPENDS across runs (a
// second run of the same leg double-counts every call), and it desynchronises under
// replay-outputs, which returns a frozen output without touching MCP at all. The JSONL keeps
// its own job -- a local, human-supervised source for backfilling expectedToolUse ground truth.

import {
	type DataSourceResult,
	isDegradingCategory,
	type ToolErrorCategory,
	type ToolErrorKind,
} from "@devops-agent/shared";
import { TOOL_NOT_FOUND_PATTERNS } from "../sub-agent.ts";

// A model-invented tool name can be arbitrarily long; cap it so one hallucination cannot
// bloat the LangSmith run output.
const HALLUCINATED_NAME_CAP = 100;

// PRIVACY INVARIANT -- this record NEVER carries tool `args` or `rawJson`, and never the raw
// error `message`. Only tool names, closed-enum classifications, and counts leave the process.
// That is the whole reason no redaction step is needed here: redactPiiContent deliberately
// does NOT redact IPs, hostnames, or account ids (SIO-861 -- they are core diagnostic data),
// so it could not have made payloads safe. Projecting no payload is the safety property.
// Do not add an `args` field to "improve" the efficiency metric -- see toolEfficiency's note.
export interface ToolCallRecord {
	dataSourceId: string;
	// Present when the elastic sub-agent fanned out across deployments (SIO-649); part of the
	// identity used to dedupe calls, so the same tool against two deployments is not "redundant".
	deploymentId?: string;
	toolName: string;
	outcome: "success" | "error";
	// Error-only. `category` is the coarse bucket the aggregator acts on; `kind` is the
	// fine-grained SDK-mapped discriminator, absent when a server fell back to regex
	// classification that only produces a category.
	category?: ToolErrorCategory;
	kind?: ToolErrorKind;
	statusCode?: number;
	// SIO-1164: a later same-tool success followed this error -- the sub-agent self-corrected.
	recovered?: boolean;
	// Set ONLY for a hallucinated tool name (see splitHallucination). Agent-side these carry
	// category "not-found", which conflates an invented tool with a genuinely absent resource.
	hallucinatedName?: string;
	// The call was part of an alignment retry (the supervisor re-dispatching a failed
	// sub-agent), not a fresh model decision. Excluded from the efficiency metric.
	isAlignmentRetry: boolean;
}

export interface ToolTrajectory {
	calls: ToolCallRecord[];
	byDataSource: { [dataSourceId: string]: { total: number; errors: number } };
	totalCalls: number;
}

// Pulls the invented name out of a `Tool "X" not found` message. Matches on the SAME exported
// constant sub-agent.ts classifies with, so the two cannot drift. Messages are matched
// lowercased there; here the raw message is used because the captured NAME must keep its
// original casing to be actionable, and the patterns are already lowercase-only literals
// apart from the capture group.
export function extractHallucinatedToolName(message: string): string | undefined {
	const lowered = message.toLowerCase();
	for (const pattern of TOOL_NOT_FOUND_PATTERNS) {
		const match = lowered.match(pattern);
		const captured = match?.[1];
		if (captured) return captured.slice(0, HALLUCINATED_NAME_CAP);
	}
	return undefined;
}

export function buildToolTrajectory(results: DataSourceResult[]): ToolTrajectory {
	const calls: ToolCallRecord[] = [];

	for (const result of results) {
		const base = {
			dataSourceId: result.dataSourceId,
			...(result.deploymentId === undefined ? {} : { deploymentId: result.deploymentId }),
			isAlignmentRetry: result.isAlignmentRetry === true,
		};

		// Successes first: toolOutputs[] is the record of tools that returned. rawJson is read
		// only by the response-health checks below and never copied onto the record.
		for (const output of result.toolOutputs ?? []) {
			calls.push({ ...base, toolName: output.toolName, outcome: "success" });
		}

		for (const error of result.toolErrors ?? []) {
			const hallucinatedName = extractHallucinatedToolName(error.message);
			calls.push({
				...base,
				toolName: error.toolName,
				outcome: "error",
				category: error.category,
				...(error.kind == null ? {} : { kind: error.kind }),
				...(error.statusCode == null ? {} : { statusCode: error.statusCode }),
				...(error.recovered == null ? {} : { recovered: error.recovered }),
				...(hallucinatedName === undefined ? {} : { hallucinatedName }),
			});
		}
	}

	const byDataSource: ToolTrajectory["byDataSource"] = {};
	for (const call of calls) {
		let bucket = byDataSource[call.dataSourceId];
		if (!bucket) {
			bucket = { total: 0, errors: 0 };
			byDataSource[call.dataSourceId] = bucket;
		}
		bucket.total++;
		if (call.outcome === "error") bucket.errors++;
	}

	return { calls, byDataSource, totalCalls: calls.length };
}

// --- Argument / name validity -------------------------------------------------------------

// A call whose ARGUMENTS the server rejected. `bad-query` is a first-class category (malformed
// query string/DSL); `bad-input` is the finer kind for other client-side validation failures
// (zod parse failures and MCP InvalidParams/-32602 -- see mcp-server-kafka/src/tools/wrap.ts).
// bad-input is checked at the KIND layer deliberately: it collapses to category "unknown"
// (agent-state.ts), which is exactly the lossy mapping SIO-1399 tracks -- so reading only the
// category here would miss every -32602 the model caused.
export function isBadArgumentCall(call: ToolCallRecord): boolean {
	if (call.outcome !== "error") return false;
	return call.category === "bad-query" || call.kind === "bad-input";
}

export function isHallucinatedCall(call: ToolCallRecord): boolean {
	return call.hallucinatedName !== undefined;
}

// Identity for redundancy: same tool, same datasource, same deployment. Args are NOT part of
// state (and deliberately not projected), so this cannot distinguish a paginated sweep with an
// advancing cursor from a genuinely repeated call. That imprecision is why the efficiency
// metric is a comparative signal only and gates nothing.
export function callIdentity(call: ToolCallRecord): string {
	return `${call.dataSourceId}::${call.deploymentId ?? ""}::${call.toolName}`;
}

// --- Response health ----------------------------------------------------------------------

export type ResponseHealthRule =
	| "prose-only-error" // an error that never carried the shared { _error } envelope
	| "empty-anchor" // a declared known-good anchor returned no rows
	| "latency-unit-confusion" // latency_us surfaced as ms/ns (see known-bug regressions below)
	| "future-dated-window"; // a result timestamped in a year the incident could not be in

export interface ResponseHealthFinding {
	rule: ResponseHealthRule;
	dataSourceId: string;
	toolName: string;
	detail: string;
}

// Known-bug regression: `latency_us` is microseconds by name, but couchbase's completed-requests
// payload reports it in NANOseconds (divide by 1e6 for ms), and a prior report rendered it
// directly as ms -- a 1000x overstatement. A value this large is the fingerprint of the unit
// bug rather than a real latency.
const IMPLAUSIBLE_LATENCY_US = 60_000_000; // 60s expressed in microseconds

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Fields whose value is legitimately in the future: certificate/token/subscription expiry and
// scheduled maintenance. Checked against the KEY, since the value alone cannot distinguish
// "this log line is year-shifted" from "this certificate expires in 2027".
const EXPIRY_FIELD_PATTERN = /(valid.?(till|until|to)|expir|not.?after|renew|scheduled|next.?run|due)/i;

export function isExpiryField(key: string): boolean {
	return EXPIRY_FIELD_PATTERN.test(key);
}

// Walks a tool payload looking for the known-bug fingerprints. Bounded depth: a deeply nested
// or cyclic payload must never hang the projection, and the markers we look for are shallow.
function scanPayload(value: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
	if (depth > 6) return;
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 50)) scanPayload(item, visit, depth + 1);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		visit(key, child);
		scanPayload(child, visit, depth + 1);
	}
}

// SIO-1398: the "right data returned" half. Reads toolOutputs[].rawJson IN-PROCESS and reduces
// it to findings -- the payload itself is never copied onto the trajectory or returned.
// `anchorTools` are tools the dataset declared must return rows for this example (a
// known-good live anchor); an empty result from one of those is a finding, not a result --
// the tool-audit runbook's "suspicious emptiness is a finding" rule.
export function checkResponseHealth(
	results: DataSourceResult[],
	anchorTools: ReadonlySet<string> = new Set(),
): ResponseHealthFinding[] {
	const findings: ResponseHealthFinding[] = [];
	const currentYear = new Date().getUTCFullYear();

	for (const result of results) {
		// A degrading error that carried no structured `kind` never went through
		// buildToolErrorEnvelope -- it reached the agent as prose and classified as "unknown",
		// which silently degrades confidence. Routine outcomes (no-data/not-found) are excluded:
		// those are legitimate findings, not malformed error reporting.
		for (const error of result.toolErrors ?? []) {
			if (error.kind == null && isDegradingCategory(error.category)) {
				findings.push({
					rule: "prose-only-error",
					dataSourceId: result.dataSourceId,
					toolName: error.toolName,
					detail: `error classified "${error.category}" with no structured kind -- no { _error } envelope`,
				});
			}
		}

		for (const output of result.toolOutputs ?? []) {
			if (anchorTools.has(output.toolName) && isEmptyPayload(output.rawJson)) {
				findings.push({
					rule: "empty-anchor",
					dataSourceId: result.dataSourceId,
					toolName: output.toolName,
					detail: "declared known-good anchor returned no rows",
				});
			}

			scanPayload(output.rawJson, (key, value) => {
				if (key === "latency_us" && typeof value === "number" && value > IMPLAUSIBLE_LATENCY_US) {
					findings.push({
						rule: "latency-unit-confusion",
						dataSourceId: result.dataSourceId,
						toolName: output.toolName,
						detail: `latency_us=${value} exceeds 60s -- likely nanoseconds reported as microseconds`,
					});
				}
				// AWS year-shift: a window anchored on the wrong year returns logs stamped in a
				// year that has not happened. Cheap, high-signal check against a real prior defect.
				//
				// EXPIRY fields are excluded. A future date is CORRECT for them, and the first
				// live run proved it: aws_rds_describe_db_instances returns `ValidTill` for each
				// instance's CA certificate (2027-03-05 etc), which this rule flagged 16 times as
				// a year-shift defect. Only fields naming an OBSERVED moment can be year-shifted;
				// a certificate that expires next year is healthy infrastructure.
				if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !isExpiryField(key)) {
					const year = Number.parseInt(value.slice(0, 4), 10);
					if (year > currentYear) {
						findings.push({
							rule: "future-dated-window",
							dataSourceId: result.dataSourceId,
							toolName: output.toolName,
							detail: `timestamp ${value} is in the future (year ${year} > ${currentYear})`,
						});
					}
				}
			});
		}
	}

	return findings;
}

// "No rows" across the shapes tool payloads actually take: a bare array, a wrapper object with
// a rows/hits/results array, or an empty object. A non-empty scalar/string payload counts as
// data -- only structurally empty results are flagged.
export function isEmptyPayload(raw: unknown): boolean {
	if (raw === null || raw === undefined) return true;
	if (Array.isArray(raw)) return raw.length === 0;
	if (typeof raw === "string") return raw.trim().length === 0;
	if (!isRecord(raw)) return false;

	const entries = Object.entries(raw);
	if (entries.length === 0) return true;
	// Wrapper objects: empty iff every array-valued collection key is empty and nothing else
	// carries content. `total`/`count` of 0 alongside an empty collection is still empty.
	const collectionKeys = ["rows", "hits", "results", "items", "documents", "records", "data"];
	const collections = entries.filter(([key]) => collectionKeys.includes(key));
	if (collections.length === 0) return false;
	return collections.every(([, value]) => {
		if (Array.isArray(value)) return value.length === 0;
		// elastic-style { hits: { hits: [] } }
		if (isRecord(value)) return Object.values(value).some((inner) => Array.isArray(inner) && inner.length === 0);
		return value === null || value === undefined;
	});
}
