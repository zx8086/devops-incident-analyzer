// src/lib/readOnlyGuard.ts

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import { config } from "../config";

// SIO-1109: READ_ONLY_QUERY_MODE (default true) was enforced ONLY on the SQL++ path
// (runSqlPlusPlusQuery.ts:46,58), so the KV document tools mutated a server configured
// read-only. One guard for all four call sites (v1 upsert/delete, v2 upsert/delete) rather
// than four inline checks: a write path that forgets the check is exactly the bug being fixed,
// so there should be one place to forget.
//
// kind is "bad-input", NOT the "auth-denied" the ticket drafted. auth-denied maps to category
// "auth" (shared/src/agent-state.ts:66), which is in the DEGRADING set (:107-111) and counts
// toward the >15% degraded-subagent confidence cap. A read-only refusal is correct policy, not
// a malfunction -- degrading confidence for it is backwards, and agent-state.ts:100-106 makes
// exactly that argument for the adjacent bad-input remap. "bad-input" -> "bad-query" (:76) is
// non-degrading and reads to the agent as "the caller can fix this", which is true: set the env
// var, or use a read tool.
export function readOnlyRefusal(operation: string) {
	if (!config.server.readOnlyQueryMode) return undefined;
	const envelope = buildToolErrorEnvelope({
		kind: "bad-input",
		message: `${operation} is not allowed in read-only mode (set READ_ONLY_QUERY_MODE=false to enable)`,
	});
	return {
		content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
		isError: true,
	};
}
