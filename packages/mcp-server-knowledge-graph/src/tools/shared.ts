// src/tools/shared.ts
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// SIO-1415: every tool this server exposes is read-only by design (the server
// description says "Never writes"; the cypher tool enforces it with a mutation-
// keyword guard). A future write tool must declare its own annotations instead
// of reusing this const.
export const KG_READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };

export function text(body: string): CallToolResult {
	return { content: [{ type: "text", text: body }] };
}

export function errText(body: string): CallToolResult {
	return { content: [{ type: "text", text: body }], isError: true };
}
