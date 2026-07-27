// agent/src/sub-agent-truncation-synthesis.ts
//
// SIO-1260: a truncated sub-agent had real evidence and no report. In run
// cbada913-d22f-4618-826b-0c4c38fd8956 the gitlab sub-agent made 15 SUCCESSFUL tool calls
// (toolErrorCount: 0), hit its 24-step recursion limit, and handed the aggregator 152 bytes: a
// 44-character mid-loop sentence plus the 108-byte salvage note. lastTextualResponse RECOVERS the
// last message that happens to carry text; it does not SYNTHESISE.
//
// This module spends one non-tool LLM call to write the report the loop never got to. It reads
// `rawOutputs`, which is the FULL pre-cap capture -- the in-loop model only ever saw
// truncateToolOutput-capped, then applyContextBudget-elided copies -- so the synthesis is grounded
// in better evidence than the loop itself had.
//
// Every failure path returns null. Throwing here would escape into runSubAgent's catch and turn a
// salvaged partial success into `status: "error"`, destroying the very evidence this exists to
// rescue.

import { getLogger } from "@devops-agent/observability";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { type InvokableLlm, invokeWithDeadline } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { truncateToolOutput } from "./sub-agent-truncate-tool-output.ts";

const log = getLogger("agent:subagent-synthesis");

// `truncated`: the recursion limit fired. `no_textual_findings`: the loop ended without narrating,
// which is the SAME defect with a different trigger -- the evidence exists, only the prose is
// missing. Logged distinguishably so each population can be sized independently from traces.
export type SynthesisTrigger = "truncated" | "no_textual_findings";

export interface SynthesisEvidenceEntry {
	toolName: string;
	content: string;
}

export interface SynthesisDigest {
	text: string;
	includedTools: string[];
	droppedTools: string[];
	entriesIncluded: number;
	entriesTotal: number;
	bytes: number;
	originalBytes: number;
}

export interface SynthesisInput {
	dataSourceId: string;
	trigger: SynthesisTrigger;
	query: string;
	// recovered?.text -- a possibly mid-thought fragment. Given to the model as context, never
	// concatenated onto the output.
	partialAnswer: string | null;
	evidence: readonly SynthesisEvidenceEntry[];
	toolErrorCount: number;
}

export interface SynthesisDeps {
	llm: InvokableLlm;
	signal?: AbortSignal;
	evidenceBudgetBytes?: number;
}

export interface SynthesisResult {
	text: string;
	digest: SynthesisDigest;
	durationMs: number;
}

// Kill switch, mirroring isGapsJudgeEnabled. Defaults ON.
export function isTruncationSynthesisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.SUBAGENT_TRUNCATION_SYNTHESIS_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// ~12k input tokens against the subAgent role's 8192-token OUTPUT budget: a comfortable ratio and
// two orders of magnitude below the context window.
//
// DELIBERATE DIVERGENCE from the sibling cap getters (getSubAgentToolCapBytes,
// getSubAgentContextBudgetBytes), where "0" means "disable the cap". An uncapped digest could be
// megabytes, so 0 and negatives fall back to the default here. Use
// SUBAGENT_TRUNCATION_SYNTHESIS_ENABLED to turn the feature off.
const DEFAULT_EVIDENCE_BUDGET_BYTES = 48_000;

export function getSynthesisEvidenceBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.SUBAGENT_SYNTHESIS_EVIDENCE_BYTES;
	if (raw == null || raw === "") return DEFAULT_EVIDENCE_BUDGET_BYTES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EVIDENCE_BUDGET_BYTES;
	return Math.floor(parsed);
}

// Never let a single tool's slice shrink to uselessness: below ~1KB a JSON-aware truncation keeps
// so few array elements that the sample stops being informative.
const MIN_ENTRY_BYTES = 1024;

const SYNTHESIS_TIMEOUT_MS = 45_000;
export const TRUNCATION_SYNTHESIS_TIMEOUT_MS = SYNTHESIS_TIMEOUT_MS;

// Breadth BEFORE depth: pass 1 takes the LAST call of each distinct tool (the freshest state), pass
// 2 spends what is left most-recent-first. A tool the loop reached only once is the highest
// information-per-byte evidence available, while the fat repetitive calls are usually what the loop
// was thrashing on -- so covering every tool once beats reproducing one tool in full.
export function buildTruncationEvidenceDigest(
	evidence: readonly SynthesisEvidenceEntry[],
	budgetBytes: number = getSynthesisEvidenceBudgetBytes(),
): SynthesisDigest {
	const empty: SynthesisDigest = {
		text: "",
		includedTools: [],
		droppedTools: [],
		entriesIncluded: 0,
		entriesTotal: 0,
		bytes: 0,
		originalBytes: 0,
	};
	if (evidence.length === 0) return empty;

	// Group by tool, preserving first-seen order, and remember each entry's call ordinal so the
	// rendered header can say "call 2 of 4" rather than implying the tool ran once.
	const byTool = new Map<string, number[]>();
	evidence.forEach((entry, index) => {
		const list = byTool.get(entry.toolName);
		if (list) list.push(index);
		else byTool.set(entry.toolName, [index]);
	});

	const firstPass: number[] = [];
	for (const indices of byTool.values()) {
		const last = indices.at(-1);
		if (last !== undefined) firstPass.push(last);
	}
	const chosen = new Set(firstPass);
	// Most-recent-first for the fill pass.
	const secondPass = evidence
		.map((_, i) => i)
		.filter((i) => !chosen.has(i))
		.reverse();

	const order = [...firstPass, ...secondPass];
	let remaining = budgetBytes;
	let originalBytes = 0;
	const rendered = new Map<number, string>();

	for (let position = 0; position < order.length; position++) {
		const index = order[position];
		if (index === undefined) continue;
		const entry = evidence[index];
		if (!entry) continue;
		const entriesLeft = order.length - position;
		const perEntryCap = Math.max(MIN_ENTRY_BYTES, Math.floor(remaining / entriesLeft));
		if (remaining <= 0) break;

		// Reuse the structure-preserving truncator: a byte slice would hand the model invalid JSON
		// and silently destroy the array shapes the extractors depend on (the SIO-785/SIO-1159
		// failure mode).
		const cut = truncateToolOutput(entry.content, Math.min(perEntryCap, remaining));
		originalBytes += cut.originalBytes;

		const indices = byTool.get(entry.toolName) ?? [];
		const ordinal = indices.indexOf(index) + 1;
		const header =
			indices.length > 1 ? `### ${entry.toolName} (call ${ordinal} of ${indices.length})` : `### ${entry.toolName}`;
		const block = `${header}\n${cut.content}`;
		const blockBytes = Buffer.byteLength(block, "utf8");
		if (blockBytes > remaining && rendered.size > 0) break;
		rendered.set(index, block);
		remaining -= blockBytes;
	}

	// Emit in the ORIGINAL call order so the model reads the investigation as it happened.
	const includedIndices = [...rendered.keys()].sort((a, b) => a - b);
	const text = includedIndices.map((i) => rendered.get(i)).join("\n\n");
	const includedTools = [...new Set(includedIndices.map((i) => evidence[i]?.toolName ?? "unknown"))];
	const droppedTools = [...byTool.keys()].filter((name) => !includedTools.includes(name));

	return {
		text,
		includedTools,
		droppedTools,
		entriesIncluded: includedIndices.length,
		entriesTotal: evidence.length,
		bytes: Buffer.byteLength(text, "utf8"),
		originalBytes,
	};
}

function buildSystemPrompt(dataSourceId: string): string {
	return `You are finalising a truncated DevOps investigation. A specialist sub-agent for the "${dataSourceId}" data source ran out of reasoning turns before it wrote its report. Below is the raw evidence its tool calls actually returned. Write the report it did not get to write.

Rules:
- Report ONLY what the evidence shows. Never infer, extrapolate, or fill gaps from general knowledge about this technology.
- Quote concrete identifiers, counts, timestamps and error strings verbatim.
- Evidence slices carry truncation markers. Where you see one, say the sample is partial -- do not present a visible slice as a complete set.
- End with a short "Not queried" list naming what this investigation did not reach, so the aggregator can see the coverage gap.
- No preamble, no apology, and no meta-commentary about being cut off -- the caller adds its own note. Findings first, plain markdown.`;
}

function buildHumanPrompt(input: SynthesisInput, digest: SynthesisDigest): string {
	const partial =
		input.partialAnswer && input.partialAnswer.trim() !== ""
			? input.partialAnswer
			: "(none -- the sub-agent produced no narrative text)";
	return `Incident question:
${input.query}

The sub-agent's own last statement before it stopped (may be a mid-thought fragment; incorporate it only where the evidence below supports it):
${partial}

Tool evidence: ${digest.entriesIncluded} of ${digest.entriesTotal} calls across ${digest.includedTools.length} tools (${input.toolErrorCount} calls errored).

${digest.text}`;
}

export async function synthesizeTruncatedFindings(
	input: SynthesisInput,
	deps: SynthesisDeps,
): Promise<SynthesisResult | null> {
	const started = Date.now();
	try {
		const digest = buildTruncationEvidenceDigest(input.evidence, deps.evidenceBudgetBytes);
		if (digest.entriesIncluded === 0) return null;

		const result = await invokeWithDeadline(
			deps.llm,
			"subAgent",
			[new SystemMessage(buildSystemPrompt(input.dataSourceId)), new HumanMessage(buildHumanPrompt(input, digest))],
			deps.signal ? { signal: deps.signal } : undefined,
		);

		// extractTextFromContent, never `typeof content === "string"`: Sonnet returns a block array
		// whose first element can be a reasoning block, and reasoning must never leak into a report
		// (the SIO-1222 chokepoint).
		const text = extractTextFromContent(result.content);
		if (text.trim() === "") return null;

		return { text, digest, durationMs: Date.now() - started };
	} catch (error) {
		// DELIBERATE divergence from gaps-judge, which RE-THROWS on an external abort. There the
		// judge is advisory over an already-complete answer, so propagating a cancellation is free.
		// Here a throw would escape into runSubAgent's catch and downgrade a salvaged partial success
		// to `data: null, status: "error"` -- losing the evidence this function exists to rescue.
		log.warn(
			{
				event: "subagent.truncation_synthesis_error",
				dataSourceId: input.dataSourceId,
				trigger: input.trigger,
				error: error instanceof Error ? error.message : String(error),
				name: error instanceof Error ? error.name : undefined,
				durationMs: Date.now() - started,
			},
			"Truncation synthesis failed; falling back to the salvaged partial answer",
		);
		return null;
	}
}
