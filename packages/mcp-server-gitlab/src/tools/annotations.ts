// src/tools/annotations.ts
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// SIO-1418: every locally-registered tool (code-analysis repo reads + Orbit
// knowledge-graph queries) is read-only. The proxied gitlab_* surface from the
// upstream /api/v4/mcp endpoint is discovered at boot and stays annotation-
// opaque -- we cannot assert per-tool hints for tools we do not own. A future
// write tool must declare its own annotations instead of reusing this const.
export const LOCAL_READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
