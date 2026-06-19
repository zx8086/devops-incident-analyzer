// src/tools/shared.ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function text(body: string): CallToolResult {
	return { content: [{ type: "text", text: body }] };
}

export function errText(body: string): CallToolResult {
	return { content: [{ type: "text", text: body }], isError: true };
}
