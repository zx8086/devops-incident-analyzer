// agent/src/prompt-overlay.ts
// SIO-613: Layer gitagent dynamic prompts onto existing MCP server tools
import { buildAllToolPrompts, buildRelatedToolsMap, loadAgent, matchesPattern } from "@devops-agent/gitagent-bridge";
import { getAgentsDir } from "./paths.ts";

let cachedToolPrompts: Map<string, string> | null = null;
let cachedRelatedToolsMap: Map<string, string[]> | null = null;

interface FacadePatternEntry {
	facadeName: string;
	patterns: string[];
}

let cachedFacadePatterns: FacadePatternEntry[] | null = null;

function getFacadePatterns(): FacadePatternEntry[] {
	if (!cachedFacadePatterns) {
		const agent = loadAgent(getAgentsDir());
		cachedFacadePatterns = agent.tools.reduce<FacadePatternEntry[]>((acc, t) => {
			if (t.tool_mapping) {
				acc.push({ facadeName: t.name, patterns: t.tool_mapping.mcp_patterns });
			}
			return acc;
		}, []);
	}
	return cachedFacadePatterns;
}

export function getToolPrompts(): Map<string, string> {
	if (!cachedToolPrompts) {
		const agent = loadAgent(getAgentsDir());
		cachedToolPrompts = buildAllToolPrompts(agent, {
			datasources: ["elastic", "kafka", "couchbase", "konnect"],
		});
	}
	return cachedToolPrompts;
}

export function getRelatedToolsMap(): Map<string, string[]> {
	if (!cachedRelatedToolsMap) {
		const agent = loadAgent(getAgentsDir());
		cachedRelatedToolsMap = buildRelatedToolsMap(agent);
	}
	return cachedRelatedToolsMap;
}

export function getEnhancedDescription(mcpToolName: string): string | undefined {
	const prompts = getToolPrompts();
	const entries = getFacadePatterns();

	for (const { facadeName, patterns } of entries) {
		for (const pattern of patterns) {
			if (matchesPattern(pattern, mcpToolName)) {
				return prompts.get(facadeName);
			}
		}
	}

	return undefined;
}
