// packages/agent/src/sub-agent-truncate-tool-output.ts

import { DEFAULT_TOOL_RESULT_CAP_BYTES } from "@devops-agent/shared";

const HITS_KEEP = 3;
const NODES_KEEP = 5;
const ARRAY_KEEP_DEFAULT = 20;
const ROWS_KEEP = 20;
const BYTE_BUDGET_DIVISOR = 4;
const MARKER_BYTE_RESERVE = 256;
// SIO-833: sourced from @devops-agent/shared so the agent and AWS MCP caps move in lockstep.
const DEFAULT_CAP_BYTES = DEFAULT_TOOL_RESULT_CAP_BYTES;
// SIO-1043: default for the persisted-state cap (toolOutputs[].rawJson), independent
// of the LLM-facing SUBAGENT_TOOL_RESULT_CAP_BYTES cap above.
const DEFAULT_STATE_CAP_BYTES = 65_536;

export type TruncationStrategy =
	| "json-hits"
	| "json-nodes"
	| "json-array"
	| "json-rows"
	| "markdown-json"
	| "json-largest-array"
	| "text"
	| "none";

export interface TruncationResult {
	content: string;
	originalBytes: number;
	finalBytes: number;
	strategy: TruncationStrategy;
}

// SIO-688: cap defaults to the shared DEFAULT_TOOL_RESULT_CAP_BYTES when env unset/invalid; explicit "0" disables.
export function getSubAgentToolCapBytes(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env.SUBAGENT_TOOL_RESULT_CAP_BYTES;
	if (raw == null || raw === "") return DEFAULT_CAP_BYTES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_CAP_BYTES;
	if (parsed === 0) return null;
	if (parsed < 0) return DEFAULT_CAP_BYTES;
	return Math.floor(parsed);
}

// SIO-1043: mirrors getSubAgentToolCapBytes' contract exactly (default/invalid/negative ->
// DEFAULT_STATE_CAP_BYTES, "0" disables). Caps the persisted toolOutputs[].rawJson at
// creation time, separate from the LLM-facing SUBAGENT_TOOL_RESULT_CAP_BYTES cap.
export function getSubAgentStateOutputCapBytes(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env.SUBAGENT_STATE_TOOL_OUTPUT_CAP_BYTES;
	if (raw == null || raw === "") return DEFAULT_STATE_CAP_BYTES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_STATE_CAP_BYTES;
	if (parsed === 0) return null;
	if (parsed < 0) return DEFAULT_STATE_CAP_BYTES;
	return Math.floor(parsed);
}

export function truncateToolOutput(content: string, capBytes: number): TruncationResult {
	const originalBytes = Buffer.byteLength(content, "utf8");
	if (originalBytes <= capBytes) {
		return { content, originalBytes, finalBytes: originalBytes, strategy: "none" };
	}

	const trimmed = content.trimStart();

	// Markdown-wrapped JSON (e.g. couchbase queryAnalysis tools): reduce inside the fence,
	// keep the surrounding markdown frame so the model sees the title + execution metadata.
	// SIO-688: detect ```json fences anywhere; some couchbase tools omit the leading heading.
	if (/```json/.test(trimmed)) {
		const md = reduceMarkdownJson(content, capBytes);
		if (md && Buffer.byteLength(md, "utf8") <= capBytes) {
			return { content: md, originalBytes, finalBytes: Buffer.byteLength(md, "utf8"), strategy: "markdown-json" };
		}
	}

	// Direct JSON (object or array at top level).
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			const reduced = reduceJson(parsed, capBytes);
			if (reduced.changed) {
				const next = JSON.stringify(reduced.value);
				const nextBytes = Buffer.byteLength(next, "utf8");
				if (nextBytes <= capBytes) {
					return { content: next, originalBytes, finalBytes: nextBytes, strategy: reduced.strategy };
				}
				// Reducer engaged but still too big; final guard rail.
				return textTruncate(next, capBytes, originalBytes);
			}
		} catch {
			// not JSON, fall through to text truncation
		}
	}

	return textTruncate(content, capBytes, originalBytes);
}

interface ReducedJson {
	value: unknown;
	changed: boolean;
	strategy: TruncationStrategy;
}

function reduceJson(value: unknown, capBytes: number): ReducedJson {
	if (!value || typeof value !== "object") {
		return { value, changed: false, strategy: "none" };
	}

	if (Array.isArray(value)) {
		return reduceArray(value, capBytes);
	}

	const obj = value as Record<string, unknown>;

	const hits = obj.hits as Record<string, unknown> | undefined;
	if (hits && Array.isArray(hits.hits) && hits.hits.length > HITS_KEEP) {
		// SIO-1249: HITS_KEEP is only the trigger threshold now -- the budget decides the
		// count. Budget against the ENVELOPE, not the raw cap: sibling fields (aggregations,
		// took, timed_out) also cost bytes, and ignoring them let the reassembled object
		// exceed the cap and fall through to the non-structure-preserving text path.
		const keep = fitCount(hits.hits, capBytes - envelopeBytes({ ...obj, hits: { ...hits, hits: [] } }));
		if (keep < hits.hits.length) {
			const reducedHits = {
				...hits,
				hits: hits.hits.slice(0, keep),
				_truncated: true,
				_totalHits: hits.hits.length,
			};
			return { value: { ...obj, hits: reducedHits }, changed: true, strategy: "json-hits" };
		}
	}

	const nodes = obj.nodes;
	if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
		const entries = Object.entries(nodes as Record<string, unknown>);
		if (entries.length > NODES_KEEP) {
			// SIO-1249: NODES_KEEP is only the trigger threshold. Fitting on the entry PAIRS
			// keeps the measurement honest -- an entry serialises as key + value, not value
			// alone -- and the envelope reserve accounts for the sibling fields.
			const keep = fitCount(entries, capBytes - envelopeBytes({ ...obj, nodes: {} }));
			if (keep < entries.length) {
				const kept = Object.fromEntries(entries.slice(0, keep));
				return {
					value: { ...obj, nodes: kept, _nodeCount: entries.length, _truncated: true },
					changed: true,
					strategy: "json-nodes",
				};
			}
		}
	}

	// {columns, rows} shape (elasticsearch_execute_sql_query).
	if (Array.isArray(obj.rows) && obj.rows.length > ROWS_KEEP) {
		// SIO-1249: ROWS_KEEP is only the trigger threshold; the budget decides the real
		// count, measured against the envelope so `columns` and friends are paid for.
		const keep = fitCount(obj.rows, capBytes - envelopeBytes({ ...obj, rows: [] }));
		if (keep < obj.rows.length) {
			return {
				value: {
					...obj,
					rows: obj.rows.slice(0, keep),
					_truncated: true,
					_totalRows: obj.rows.length,
				},
				changed: true,
				strategy: "json-rows",
			};
		}
	}

	// Fallback: find the largest array field and trim it. Catches unknown shapes that
	// happen to have one bloat-causing array (e.g. `results`, `items`, `data`, etc.)
	// SIO-688: also reduce when bytes exceed budget even if length <= threshold
	// (Atlassian {issues, isLast} returns ~12 issues but each is several KB).
	const largest = findLargestArrayField(obj);
	const budget = capBytes / BYTE_BUDGET_DIVISOR;
	if (largest && (largest.array.length > ARRAY_KEEP_DEFAULT || largest.size > budget)) {
		const reducedArray = reduceArrayInline(largest.array, capBytes);
		return {
			value: { ...obj, [largest.key]: reducedArray, _truncated: true, _truncatedField: largest.key },
			changed: true,
			strategy: "json-largest-array",
		};
	}

	return { value, changed: false, strategy: "none" };
}

// SIO-688: short arrays of huge items (e.g. elasticsearch_search 6 hits at 95KB)
// previously skipped reduction; now also reduce when total bytes exceed budget.
function reduceArray(value: unknown[], capBytes: number): ReducedJson {
	if (value.length <= ARRAY_KEEP_DEFAULT && serializedBytes(value) <= capBytes / BYTE_BUDGET_DIVISOR) {
		return { value, changed: false, strategy: "none" };
	}
	const reduced = reduceArrayInline(value, capBytes);
	return { value: reduced, changed: true, strategy: "json-array" };
}

// Keeps as many leading items as the budget allows, then appends a
// {_truncated, _totalCount, _keptCount} marker entry.
//
// SIO-1249: this used to derive a keep-count from a 5-item sample and clamp it with
// Math.min(baseKeep, byteBoundedKeep, length) -- so a generous cap still yielded at most
// 20 items (3 when the sample looked large) and the remaining budget was discarded, and a
// shrink loop then corrected the sample's underestimates one item at a time. fitCount's
// binary search over the REAL serialized slice replaces all of it: no sampling heuristic,
// no correction loop, and the size it reports is the size that ships.
function reduceArrayInline(value: unknown[], capBytes: number): unknown[] {
	if (value.length === 0) return value;
	const finalKeep = fitCount(value, capBytes - MARKER_BYTE_RESERVE);
	return [...value.slice(0, finalKeep), { _truncated: true, _totalCount: value.length, _keptCount: finalKeep }];
}

// SIO-688: returns size so callers can apply a byte-budget check in addition to length.
function findLargestArrayField(obj: Record<string, unknown>): { key: string; array: unknown[]; size: number } | null {
	let best: { key: string; array: unknown[]; size: number } | null = null;
	for (const [key, val] of Object.entries(obj)) {
		if (Array.isArray(val) && val.length > 0) {
			const size = serializedBytes(val);
			if (!best || size > best.size) {
				best = { key, array: val, size };
			}
		}
	}
	return best;
}

// SIO-1249: bytes the container costs with its bulky array emptied, plus the marker
// reserve. Subtracting this from the cap gives the array its TRUE remaining budget, so a
// reduced object with heavy siblings still fits and keeps its structure-preserving strategy.
function envelopeBytes(shell: unknown): number {
	return serializedBytes(shell) + MARKER_BYTE_RESERVE;
}

function serializedBytes(value: unknown): number {
	const json = JSON.stringify(value);
	return json == null ? 0 : Buffer.byteLength(json, "utf8");
}

// SIO-1249: how many leading items actually FIT the byte budget.
//
// The reducers used to slice at fixed constants (HITS_KEEP 3, NODES_KEEP 5, ROWS_KEEP 20)
// regardless of capBytes, so cap=131072 and cap=16384 produced byte-identical output and
// ~99% of the granted budget was thrown away.
//
// The BUDGET always wins -- those constants are no longer a ceiling and are deliberately
// not a floor either. Returning more than fits would push the serialized result back over
// the cap, and truncateToolOutput would then fall through to textTruncate, whose output is
// NOT structure-preserving (the exact failure SIO-785/SIO-1159 fixed). The only floor is 1,
// so the shape stays parseable; if even one item busts the cap, the caller's textTruncate
// guard is the correct last resort.
//
// Binary search on real serialized bytes (~log2(n) stringifies) rather than an item-size
// estimate, so nested/inhomogeneous items can't overshoot the cap.
function fitCount(items: unknown[], budgetBytes: number): number {
	if (items.length === 0) return 0;
	if (budgetBytes <= 0) return 1;

	let lo = 0;
	let hi = items.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (serializedBytes(items.slice(0, mid)) <= budgetBytes) lo = mid;
		else hi = mid - 1;
	}
	return Math.max(lo, 1);
}

// Find ```json...``` fences in markdown content. Reduce the first one whose JSON
// parses; keep all surrounding markdown verbatim. The frame (title, exec details,
// limit-applied section) is what carries the semantic context the model uses.
function reduceMarkdownJson(content: string, capBytes: number): string | null {
	const fenceRegex = /```json\s*\n([\s\S]*?)\n```/g;
	const matches = [...content.matchAll(fenceRegex)];
	if (matches.length === 0) return null;

	let result = content;
	let anyReduced = false;
	for (const match of matches) {
		const fenceBlock = match[0];
		const inner = match[1];
		if (inner === undefined) continue;
		try {
			const parsed = JSON.parse(inner) as unknown;
			const reduced = reduceJson(parsed, capBytes);
			if (!reduced.changed && Array.isArray(parsed) && parsed.length > ARRAY_KEEP_DEFAULT) {
				// reduceJson early-returns "none" for arrays already <= ARRAY_KEEP_DEFAULT;
				// for non-array unknown shapes we don't have a reducer. Use generic array path
				// or fall through.
			}
			const replacementInner = reduced.changed ? JSON.stringify(reduced.value, null, 2) : inner;
			if (reduced.changed) {
				const replacement = `\`\`\`json\n${replacementInner}\n\`\`\``;
				result = result.replace(fenceBlock, replacement);
				anyReduced = true;
			}
		} catch {
			// inner isn't JSON; skip
		}
	}

	if (!anyReduced) return null;
	if (Buffer.byteLength(result, "utf8") <= capBytes) return result;
	// If still too big after reducing fences, hard-truncate text-style.
	return null;
}

function textTruncate(content: string, capBytes: number, originalBytes: number): TruncationResult {
	const head = Math.max(1, Math.floor(capBytes / 2));
	const sliced = content.slice(0, head);
	const marker = `\n... [truncated, ${originalBytes} bytes total]`;
	const next = sliced + marker;
	return {
		content: next,
		originalBytes,
		finalBytes: Buffer.byteLength(next, "utf8"),
		strategy: "text",
	};
}
