// packages/agent/src/sub-agent-truncate-tool-output.ts

const HITS_KEEP = 3;
const NODES_KEEP = 5;
const ARRAY_KEEP = 20;

export type TruncationStrategy = "json-hits" | "json-nodes" | "json-array" | "text" | "none";

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
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			const reduced = reduceJson(parsed);
			if (reduced.changed) {
				const next = JSON.stringify(reduced.value);
				const nextBytes = Buffer.byteLength(next, "utf8");
				if (nextBytes <= capBytes) {
					return { content: next, originalBytes, finalBytes: nextBytes, strategy: reduced.strategy };
				}
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

function reduceJson(value: unknown): ReducedJson {
	if (!value || typeof value !== "object") {
		return { value, changed: false, strategy: "none" };
	}

	if (Array.isArray(value)) {
		if (value.length > ARRAY_KEEP) {
			return {
				value: [...value.slice(0, ARRAY_KEEP), { _truncated: true, _totalCount: value.length }],
				changed: true,
				strategy: "json-array",
			};
		}
		return { value, changed: false, strategy: "none" };
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

	return { value, changed: false, strategy: "none" };
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
