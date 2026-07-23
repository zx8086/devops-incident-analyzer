// src/lib/response-builder.ts

import { buildToolErrorEnvelope, type StructuredToolError } from "@devops-agent/shared";

interface ToolResponse {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

function bigintReplacer(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

// SIO-728: sentinel appended to the human error text when structured upstream
// metadata (hostname / contentType / statusCode) accompanies an error. The agent
// side (packages/agent/src/sub-agent.ts:extractToolErrors) splits on this and
// parses the trailing JSON into the ToolError. Kept as a constant so server +
// agent stay in sync; do not inline.
const STRUCTURED_SENTINEL = "\n---STRUCTURED---\n";

// biome-ignore lint/complexity/noStaticOnlyClass: namespace for tool response helpers used across all tools
export class ResponseBuilder {
	static success(data: unknown): ToolResponse {
		const text = typeof data === "string" ? data : JSON.stringify(data, bigintReplacer, 2);
		return { content: [{ type: "text", text }] };
	}

	// SIO-728: when `structured` is provided, append the sentinel + JSON payload
	// so the agent's extractToolErrors can lift it into a ToolError. Omitting the
	// arg preserves byte-identical behaviour with pre-SIO-728 callers.
	static error(message: string, structured?: Record<string, unknown>): ToolResponse {
		const text = structured === undefined ? message : `${message}${STRUCTURED_SENTINEL}${JSON.stringify(structured)}`;
		return { content: [{ type: "text", text }], isError: true };
	}

	// SIO-1190: shared { _error } envelope adoption (SIO-1087). Layout is load-bearing:
	// steering prose FIRST (the sub-agent LLM reads it), the envelope JSON next (the
	// agent's SIO-1159 brace-recovery finds the object enclosing the "_error" anchor
	// anywhere in the text), and the SIO-728 sentinel LAST so its split()[1] remains
	// pure JSON for the legacy parser. Prose is duplicated into _error.advice unless
	// the caller supplies more specific advice.
	static errorWithKind(message: string, err: StructuredToolError, structured?: Record<string, unknown>): ToolResponse {
		const envelope = JSON.stringify(buildToolErrorEnvelope({ advice: message, ...err }));
		const sentinelPart = structured === undefined ? "" : `${STRUCTURED_SENTINEL}${JSON.stringify(structured)}`;
		return { content: [{ type: "text", text: `${message}\n\n${envelope}${sentinelPart}` }], isError: true };
	}
}
