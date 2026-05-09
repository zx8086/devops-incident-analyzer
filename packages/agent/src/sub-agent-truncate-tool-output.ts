// packages/agent/src/sub-agent-truncate-tool-output.ts

const HITS_KEEP = 3;
const NODES_KEEP = 5;
const ARRAY_KEEP_DEFAULT = 20;
const ARRAY_KEEP_LARGE_ITEM = 3;
const LARGE_ITEM_BYTES = 8_192;
const ROWS_KEEP = 20;

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

export function getSubAgentToolCapBytes(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env.SUBAGENT_TOOL_RESULT_CAP_BYTES;
	if (raw == null || raw === "") return null;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
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
	if (/^#\s|```json/m.test(trimmed)) {
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
		const reducedHits = {
			...hits,
			hits: hits.hits.slice(0, HITS_KEEP),
			_truncated: true,
			_totalHits: hits.hits.length,
		};
		return { value: { ...obj, hits: reducedHits }, changed: true, strategy: "json-hits" };
	}

	const nodes = obj.nodes;
	if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
		const entries = Object.entries(nodes as Record<string, unknown>);
		if (entries.length > NODES_KEEP) {
			const kept = Object.fromEntries(entries.slice(0, NODES_KEEP));
			return {
				value: { ...obj, nodes: kept, _nodeCount: entries.length, _truncated: true },
				changed: true,
				strategy: "json-nodes",
			};
		}
	}

	// {columns, rows} shape (elasticsearch_execute_sql_query).
	if (Array.isArray(obj.rows) && obj.rows.length > ROWS_KEEP) {
		return {
			value: {
				...obj,
				rows: obj.rows.slice(0, ROWS_KEEP),
				_truncated: true,
				_totalRows: obj.rows.length,
			},
			changed: true,
			strategy: "json-rows",
		};
	}

	// Fallback: find the largest array field and trim it. Catches unknown shapes that
	// happen to have one bloat-causing array (e.g. `results`, `items`, `data`, etc.)
	const largest = findLargestArrayField(obj);
	if (largest && largest.array.length > ARRAY_KEEP_DEFAULT) {
		const reducedArray = reduceArrayInline(largest.array, capBytes);
		return {
			value: { ...obj, [largest.key]: reducedArray, _truncated: true, _truncatedField: largest.key },
			changed: true,
			strategy: "json-largest-array",
		};
	}

	return { value, changed: false, strategy: "none" };
}

function reduceArray(value: unknown[], capBytes: number): ReducedJson {
	if (value.length <= ARRAY_KEEP_DEFAULT) {
		return { value, changed: false, strategy: "none" };
	}
	const reduced = reduceArrayInline(value, capBytes);
	return { value: reduced, changed: true, strategy: "json-array" };
}

// Decides keep-count from item size: small items can keep 20, large items only 3.
// Appends a {_truncated, _totalCount} marker entry.
function reduceArrayInline(value: unknown[], capBytes: number): unknown[] {
	const sample = value[0];
	const sampleBytes = sample == null ? 0 : Buffer.byteLength(JSON.stringify(sample), "utf8");
	const keep = sampleBytes > LARGE_ITEM_BYTES ? ARRAY_KEEP_LARGE_ITEM : ARRAY_KEEP_DEFAULT;
	// If even the keep-count would exceed cap, drop further; minimum 1.
	const projected = sampleBytes * keep;
	const finalKeep = projected > capBytes ? Math.max(1, Math.floor(capBytes / Math.max(1, sampleBytes))) : keep;
	return [...value.slice(0, finalKeep), { _truncated: true, _totalCount: value.length, _keptCount: finalKeep }];
}

function findLargestArrayField(obj: Record<string, unknown>): { key: string; array: unknown[] } | null {
	let best: { key: string; array: unknown[]; size: number } | null = null;
	for (const [key, val] of Object.entries(obj)) {
		if (Array.isArray(val) && val.length > 0) {
			const size = Buffer.byteLength(JSON.stringify(val), "utf8");
			if (!best || size > best.size) {
				best = { key, array: val, size };
			}
		}
	}
	return best ? { key: best.key, array: best.array } : null;
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
