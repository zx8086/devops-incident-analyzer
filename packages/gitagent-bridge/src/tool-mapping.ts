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
