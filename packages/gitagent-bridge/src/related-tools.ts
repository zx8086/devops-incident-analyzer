// gitagent-bridge/src/related-tools.ts

import type { ToolDefinition } from "./types.ts";

export function getRelatedTools(toolDef: ToolDefinition): string[] {
	return toolDef.related_tools ?? [];
}

export function withRelatedTools<T extends Record<string, unknown>>(
	response: T,
	toolName: string,
	relatedToolsMap: Map<string, string[]>,
): T & { relatedTools?: string[] } {
	const related = relatedToolsMap.get(toolName);
	if (!related || related.length === 0) return response;
	return { ...response, relatedTools: related };
}
