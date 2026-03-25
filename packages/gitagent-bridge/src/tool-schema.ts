// gitagent-bridge/src/tool-schema.ts
import { buildFacadeMap, type FacadeMap, resolveMapping } from "./tool-mapping.ts";
import type { ToolDefinition } from "./types.ts";

export interface ToolValidationResult {
	valid: boolean;
	missing: string[];
	extra: string[];
	unmappedFacades: string[];
	facadeMap: FacadeMap;
}

export function validateToolSchemas(gitagentTools: ToolDefinition[], mcpToolNames: string[]): ToolValidationResult {
	const hasMappings = gitagentTools.some((t) => t.tool_mapping);

	// SIO-613: When tool_mapping is present, use facade mapping resolution
	if (hasMappings) {
		const facadeMap = buildFacadeMap(gitagentTools, mcpToolNames);
		const missing: string[] = [];
		const unmappedFacades: string[] = [];

		for (const tool of gitagentTools) {
			if (tool.tool_mapping) {
				const { matched } = resolveMapping(tool.tool_mapping.mcp_patterns, mcpToolNames);
				if (matched.length === 0) {
					missing.push(tool.name);
				}
			} else {
				unmappedFacades.push(tool.name);
			}
		}

		const coveredNames = new Set(facadeMap.mcpToFacade.keys());
		const extra = mcpToolNames.filter((n) => !coveredNames.has(n));

		return {
			valid: missing.length === 0,
			missing,
			extra,
			unmappedFacades,
			facadeMap,
		};
	}

	// Backward compatibility: direct name comparison when no tool_mapping fields
	const expectedNames = new Set(gitagentTools.map((t) => t.name));
	const actualNames = new Set(mcpToolNames);

	const missing = [...expectedNames].filter((n) => !actualNames.has(n));
	const extra = [...actualNames].filter((n) => !expectedNames.has(n));

	return {
		valid: missing.length === 0,
		missing,
		extra,
		unmappedFacades: [],
		facadeMap: { facadeToMcp: new Map(), mcpToFacade: new Map() },
	};
}
