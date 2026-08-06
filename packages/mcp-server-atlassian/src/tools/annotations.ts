// src/tools/annotations.ts
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// SIO-1416: every locally-registered custom tool is a read-only Jira/Confluence
// lookup or aggregation. The proxied atlassian_* surface is discovered at boot
// and stays annotation-opaque -- write ENFORCEMENT for it remains the
// WRITE_TOOL_PATTERNS filter in proxy/write-tools.ts, which does not read
// annotations. A future write tool must declare its own annotations instead of
// reusing this const.
export const CUSTOM_READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
