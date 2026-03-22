// gitagent-bridge/src/related-tools.ts
import type { ToolDefinition } from "./types.ts";
import type { LoadedAgent } from "./manifest-loader.ts";

export function getRelatedTools(toolDef: ToolDefinition): string[] {
  return toolDef.related_tools ?? [];
}

export function buildRelatedToolsMap(agent: LoadedAgent): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const tool of agent.tools) {
    const related = getRelatedTools(tool);
    if (related.length > 0) {
      map.set(tool.name, related);
    }
  }
  return map;
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
