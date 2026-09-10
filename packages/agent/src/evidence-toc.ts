// agent/src/evidence-toc.ts
//
// SIO-1687: a table of contents for the evidence a completed turn fetched.
//
// pruneThreadState resets dataSourceResults to [] after every turn (the reducer's
// reset branch; a shorter array would merge, not truncate). That is correct for
// state size, but it leaves a follow-up turn with no evidence AND no trace that
// any was ever fetched -- indistinguishable, from the aggregator's side, from a
// turn where every datasource came back empty. The follow-up then reports absence
// it never established.
//
// This module builds the provenance, never the evidence: which datasource ran
// which tools, how much came back, and what failed. A few hundred bytes stashed
// per thread and prepended to the next turn's recall block. The evidence itself
// stays gone; recovering it is SIO-1688's evidence index.

import type { DataSourceResult } from "@devops-agent/shared";

// Kill switch, default ON (same idiom as isHilLearningEnabled).
export function isEvidenceTocEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.EVIDENCE_TOC_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// Hard ceiling on the rendered block. The TOC competes with real evidence for
// the aggregator's window, so it stays small: this bounds a pathological
// fan-out (many estates, many tools each) rather than a normal turn, which
// lands well under it.
const TOC_MAX_CHARS = 2_000;
// Tools named per datasource before the rest become a count. A datasource that
// ran 30 tools is described by its first few plus "and 26 more".
const TOOLS_NAMED = 6;

function byteLength(value: unknown): number {
	if (value == null) return 0;
	if (typeof value === "string") return Buffer.byteLength(value, "utf8");
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		// Circular or non-serializable payloads are counted as unknown, not fatal.
		return 0;
	}
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${bytes}B`;
}

function describeOne(result: DataSourceResult): string {
	const id = result.deploymentId ? `${result.dataSourceId}/${result.deploymentId}` : result.dataSourceId;
	if (result.status === "error") {
		const reason = result.error ? result.error.slice(0, 120) : "no detail";
		return `- ${id}: FAILED (${reason})`;
	}

	const outputs = result.toolOutputs ?? [];
	if (outputs.length === 0) {
		// A success with no tool outputs is a real and reportable state: the
		// sub-agent answered without calling a tool, or every call failed.
		const errs = result.toolErrors?.length ?? 0;
		return errs > 0
			? `- ${id}: no tool output; ${errs} tool error(s)`
			: `- ${id}: no tool output (sub-agent answered without calling a tool)`;
	}

	const names = [...new Set(outputs.map((o) => o.toolName))];
	const shown = names.slice(0, TOOLS_NAMED).join(", ");
	const more = names.length > TOOLS_NAMED ? ` and ${names.length - TOOLS_NAMED} more` : "";
	const total = outputs.reduce((sum, o) => sum + byteLength(o.rawJson), 0);

	const parts = [`- ${id}: ${outputs.length} tool call(s) returning ${formatBytes(total)} via ${shown}${more}`];
	// Error categories, not messages: the categories are a closed enum the
	// aggregator already reasons about, while messages are unbounded upstream text.
	const errors = result.toolErrors ?? [];
	if (errors.length > 0) {
		const cats = [...new Set(errors.map((e) => e.category))].join(", ");
		parts.push(`  ${errors.length} tool error(s): ${cats}`);
	}
	return parts.join("\n");
}

// Returns undefined when there is nothing worth saying, so the caller can leave
// the stash empty rather than storing an empty header.
export function buildEvidenceToc(results: DataSourceResult[] | undefined): string | undefined {
	if (!results || results.length === 0) return undefined;
	const lines = results.map(describeOne);
	if (lines.length === 0) return undefined;

	const header = [
		"## Evidence fetched on the previous turn",
		"",
		"This lists what the last turn's investigation retrieved, not the findings.",
		"The raw evidence is no longer in context. Treat this as proof the",
		"datasources below WERE queried: do not report them as unqueried or as",
		"having returned nothing. Re-query a datasource if you need its detail again.",
		"",
	].join("\n");

	let body = lines.join("\n");
	if (header.length + body.length > TOC_MAX_CHARS) {
		const budget = Math.max(0, TOC_MAX_CHARS - header.length - 40);
		const kept: string[] = [];
		let used = 0;
		for (const line of lines) {
			if (used + line.length + 1 > budget) break;
			kept.push(line);
			used += line.length + 1;
		}
		const dropped = lines.length - kept.length;
		body = dropped > 0 ? `${kept.join("\n")}\n- (${dropped} more datasource(s) omitted)` : kept.join("\n");
	}
	return `${header}${body}`;
}
