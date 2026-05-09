// packages/agent/src/sub-agent-tool-result-shape.ts

export type ToolResultContentType = "string" | "array" | "object" | "empty";

export interface ToolResultShape {
	contentType: ToolResultContentType;
	hitsLen?: number;
	nodesCount?: number;
	topLevelArrayLen?: number;
	topLevelKeys?: string[];
}

export interface ToolResultDescriptor {
	bytes: number;
	shape: ToolResultShape;
}

export function describeToolResult(content: unknown): ToolResultDescriptor {
	const text = typeof content === "string" ? content : safeStringify(content);
	const bytes = Buffer.byteLength(text, "utf8");

	if (bytes === 0) {
		return { bytes, shape: { contentType: "empty" } };
	}

	const trimmed = text.trimStart();
	const first = trimmed.charAt(0);
	if (first !== "{" && first !== "[") {
		return { bytes, shape: { contentType: "string" } };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { bytes, shape: { contentType: "string" } };
	}

	if (Array.isArray(parsed)) {
		return { bytes, shape: { contentType: "array", topLevelArrayLen: parsed.length } };
	}

	if (parsed && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		const shape: ToolResultShape = {
			contentType: "object",
			topLevelKeys: Object.keys(obj).slice(0, 10),
		};
		const hits = obj.hits as Record<string, unknown> | undefined;
		if (hits && Array.isArray(hits.hits)) {
			shape.hitsLen = hits.hits.length;
		}
		const nodes = obj.nodes;
		if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
			shape.nodesCount = Object.keys(nodes as Record<string, unknown>).length;
		}
		return { bytes, shape };
	}

	return { bytes, shape: { contentType: "string" } };
}

function safeStringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}
