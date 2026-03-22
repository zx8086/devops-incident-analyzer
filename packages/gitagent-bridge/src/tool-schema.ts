// gitagent-bridge/src/tool-schema.ts
import type { ToolDefinition } from "./types.ts";

export function validateToolSchemas(
  gitagentTools: ToolDefinition[],
  mcpToolNames: string[],
): { valid: boolean; missing: string[]; extra: string[] } {
  const expectedNames = new Set(gitagentTools.map((t) => t.name));
  const actualNames = new Set(mcpToolNames);

  const missing = [...expectedNames].filter((n) => !actualNames.has(n));
  const extra = [...actualNames].filter((n) => !expectedNames.has(n));

  return {
    valid: missing.length === 0,
    missing,
    extra,
  };
}
