// packages/mcp-server-elastic/src/tools/core/search-index-shape.ts
// SIO-1144: pure helpers for the not-found retry-advice gate, kept free of MCP-SDK imports so they
// are unit-testable in isolation (and in a git worktree without workspace symlinks).

// A 404 index_not_found only ever fires on a CONCRETE named index -- a data stream or a wildcard
// that matches nothing returns 0 hits, not a 404 (SIO-1121). So a not-found almost always means the
// LLM hand-formed a concrete/dated backing-index name (e.g.
// `logs-apm.app.<svc>-default-2026.07.16-000057`, or a leading `.ds-`) instead of querying the data
// stream/wildcard. Detect that shape so we attach retry-with-wildcard advice ONLY when it applies --
// a genuinely-absent plain wildcard must still read as a clean absence, not a "you mistyped" nudge.
const DATED_SUFFIX_RE = /-\d{4}\.\d{2}\.\d{2}(-\d{6})?$/; // -YYYY.MM.DD or -YYYY.MM.DD-NNNNNN
const ROLLOVER_SUFFIX_RE = /-\d{6}$/; // trailing 6-digit rollover sequence

export function isConcreteBackingIndexName(index: string | undefined): boolean {
	if (!index) return false;
	// A comma-list is concrete only if EVERY member looks concrete; a mix that includes a wildcard
	// is already a broad query and should not get the "you queried a concrete name" advice.
	const members = index
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (members.length === 0) return false;
	return members.every(
		(m) => !m.includes("*") && (m.startsWith(".ds-") || DATED_SUFFIX_RE.test(m) || ROLLOVER_SUFFIX_RE.test(m)),
	);
}

// Copy-paste retry guidance mirroring the AWS mapAwsError re-anchor advice (wrap.ts). The
// StructuredToolError.advice slot was previously left undefined on elastic not-found, so the LLM saw
// a bare 404 and gave up ("APM error index absent"). Steer it to the data stream / wildcard instead.
export const NOT_FOUND_WILDCARD_ADVICE =
	"A concrete/dated index name (`...-YYYY.MM.DD-NNNNNN`) or a single `.ds-` backing index was queried -- a 404 means the NAME is wrong, NOT that the data is absent. Re-issue against the data stream or a wildcard: `logs-apm.app.<service>-default`, the error stream `logs-apm.error-*`, or the broad `logs-*,logs-apm.*`. A wildcard that matches nothing returns 0 hits (not a 404), so you can distinguish a naming mistake from real absence. Never hand-form a dated/`.ds-` backing-index name; and to claim 'no APM errors', query the ERROR stream `logs-apm.error-*` (field `error.exception.message`) AND the app stream (field `message`), not one app backing index.";

// Returns the advice to attach to a tool-error envelope, or undefined when none applies. Advice is
// attached only on a not-found kind against a concrete-index shape.
export function notFoundWildcardAdvice(kind: string, index: string | undefined): string | undefined {
	return kind === "not-found" && isConcreteBackingIndexName(index) ? NOT_FOUND_WILDCARD_ADVICE : undefined;
}
