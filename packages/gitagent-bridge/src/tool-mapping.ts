// gitagent-bridge/src/tool-mapping.ts
import type { ToolDefinition } from "./types.ts";

export interface ResolvedMapping {
	matched: string[];
	unmatchedPatterns: string[];
}

export interface FacadeMap {
	facadeToMcp: Map<string, string[]>;
	mcpToFacade: Map<string, string>;
}

export function matchesPattern(pattern: string, toolName: string): boolean {
	const starIdx = pattern.indexOf("*");
	if (starIdx === -1) {
		return pattern === toolName;
	}
	const prefix = pattern.slice(0, starIdx);
	const suffix = pattern.slice(starIdx + 1);
	return toolName.length >= prefix.length + suffix.length && toolName.startsWith(prefix) && toolName.endsWith(suffix);
}

export function resolveMapping(patterns: string[], mcpToolNames: string[]): ResolvedMapping {
	const matched = new Set<string>();
	const unmatchedPatterns: string[] = [];

	for (const pattern of patterns) {
		let patternMatched = false;
		for (const name of mcpToolNames) {
			if (matchesPattern(pattern, name)) {
				matched.add(name);
				patternMatched = true;
			}
		}
		if (!patternMatched) {
			unmatchedPatterns.push(pattern);
		}
	}

	return { matched: [...matched], unmatchedPatterns };
}

export function buildFacadeMap(tools: ToolDefinition[], mcpToolNames: string[]): FacadeMap {
	const facadeToMcp = new Map<string, string[]>();
	const mcpToFacade = new Map<string, string>();

	for (const tool of tools) {
		if (tool.tool_mapping) {
			const { matched } = resolveMapping(tool.tool_mapping.mcp_patterns, mcpToolNames);
			facadeToMcp.set(tool.name, matched);
			for (const mcpName of matched) {
				mcpToFacade.set(mcpName, tool.name);
			}
		} else {
			facadeToMcp.set(tool.name, []);
		}
	}

	return { facadeToMcp, mcpToFacade };
}

export function getUncoveredTools(facadeMap: FacadeMap, mcpToolNames: string[]): string[] {
	return mcpToolNames.filter((name) => !facadeMap.mcpToFacade.has(name));
}

export function resolveActionTools(
	toolDef: ToolDefinition,
	actions: string[],
): { toolNames: string[]; unmatchedActions: string[] } {
	const actionMap = toolDef.tool_mapping?.action_tool_map;
	if (!actionMap) {
		return { toolNames: [], unmatchedActions: [...actions] };
	}
	const toolNames = new Set<string>();
	const unmatchedActions: string[] = [];
	for (const action of actions) {
		const tools = actionMap[action];
		if (tools && tools.length > 0) {
			for (const name of tools) toolNames.add(name);
		} else {
			unmatchedActions.push(action);
		}
	}
	return { toolNames: [...toolNames], unmatchedActions };
}

export function getAllActionToolNames(toolDef: ToolDefinition): string[] {
	const actionMap = toolDef.tool_mapping?.action_tool_map;
	if (!actionMap) return [];
	const all = new Set<string>();
	for (const tools of Object.values(actionMap)) {
		for (const name of tools) all.add(name);
	}
	return [...all];
}

export function getAvailableActions(toolDef: ToolDefinition): string[] {
	const actionMap = toolDef.tool_mapping?.action_tool_map;
	if (!actionMap) return [];
	return Object.keys(actionMap);
}

export function getActionKeywords(toolDef: ToolDefinition): Record<string, string[]> {
	return toolDef.tool_mapping?.action_keywords ?? {};
}
