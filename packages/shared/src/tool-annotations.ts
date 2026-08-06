// shared/src/tool-annotations.ts
// SIO-1413: shape MCP-standard ToolAnnotations from each server's OWN read-only /
// destructive classification sets. Pure derivation only -- classification policy
// stays per-server (elastic's READ_ONLY_TOOLS, kafka's WRITE_TOOLS/DESTRUCTIVE_TOOLS,
// atlassian's WRITE_TOOL_PATTERNS each encode API-specific judgment calls; a central
// set would force one naming convention across nine unrelated APIs). Annotations are
// HINTS for clients (the SDK never enforces them); write ENFORCEMENT remains the
// read-only chokepoint (read-only-chokepoint.ts), which does not read annotations.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// Each provided set is treated as the server's COMPLETE classification for that
// dimension: a name absent from a provided `readOnly` set gets readOnlyHint: false
// (the server classified it as a write tool), while an omitted set yields no hint
// at all for that dimension. Pass only the dimensions the server actually curates.
export interface ToolAnnotationSets {
	readOnly?: ReadonlySet<string>;
	destructive?: ReadonlySet<string>;
	idempotent?: ReadonlySet<string>;
}

// Returns undefined (omit `annotations` entirely) when no dimension is provided,
// rather than asserting hints the server never decided on.
export function deriveToolAnnotations(name: string, sets: ToolAnnotationSets): ToolAnnotations | undefined {
	const readOnlyHint = sets.readOnly?.has(name);
	const destructiveHint = sets.destructive?.has(name);
	const idempotentHint = sets.idempotent?.has(name);
	if (readOnlyHint === undefined && destructiveHint === undefined && idempotentHint === undefined) return undefined;
	return {
		...(readOnlyHint !== undefined && { readOnlyHint }),
		...(destructiveHint !== undefined && { destructiveHint }),
		...(idempotentHint !== undefined && { idempotentHint }),
	};
}

// Drafting aid ONLY for servers with no existing classification: suffix-anchored so
// mid-word verbs never match, and deliberately conservative -- a false negative (a
// read tool not flagged) is far cheaper than a false positive (a write tool drafted
// into a read-only set). Never wire this directly into production registration;
// each server's PR hand-reviews the final Set against real API semantics.
const READ_VERB_PREFIX = /^[a-z0-9]+_(get|list|describe|check|read|search|query|explain|analyze|suggest)_/i;

export function looksReadOnlyByName(name: string): boolean {
	return READ_VERB_PREFIX.test(name);
}
