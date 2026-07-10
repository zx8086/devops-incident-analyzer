// packages/mcp-server-elastic/src/utils/toolErrorHandling.ts

// SIO-1047: shared helper for clone group d161427f -- 9 tool handlers (cluster/get_cluster_health,
// cluster/get_cluster_stats, cluster/get_nodes_info, cluster/get_nodes_stats, core/get_mappings,
// enrich/delete_policy, enrich/put_policy, enrich/stats, enrich/get_policy_improved,
// enrich/execute_policy) each ended their catch block with a byte-identical Zod validation-error
// branch (fallow dupes fingerprint dup:d161427f). Every site's `type` union differs (e.g.
// "cluster_unhealthy" | "node_unavailable" vs "policy_not_found" | "timeout"), so this helper is
// generic over that union rather than widening it -- each call site still gets full literal-type
// checking on its own `create<X>McpError` callback.

import type { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

// Every per-tool `create<X>McpError` always accepts "validation" alongside its tool-specific
// context types; ErrorType is that tool-specific union (inferred at the call site).
type McpErrorFactory<ErrorType extends string> = (
	error: Error | string,
	context: { type: ErrorType | "validation"; details?: unknown },
) => McpError;

// Throws the tool's McpError for a failed Zod parse, using the exact message/details shape shared
// by all clone-group d161427f sites. `args` is the raw (pre-validation) handler input, echoed back
// as `providedArgs` for debugging -- unchanged from the original per-site inline branches.
export function throwZodValidationMcpError<ErrorType extends string>(
	error: z.ZodError,
	args: unknown,
	createMcpError: McpErrorFactory<ErrorType>,
): never {
	throw createMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
		type: "validation",
		details: { validationErrors: error.issues, providedArgs: args },
	});
}
