// src/tools/annotations.ts
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// SIO-1420: every tool this server exposes is read-only by design -- estates are
// reached through cross-account AssumeRole into DevOpsAgentReadOnly (read-only
// IAM policy), so no per-tool classification Set is needed. A future write tool
// must declare its own annotations instead of reusing this const.
export const AWS_READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
