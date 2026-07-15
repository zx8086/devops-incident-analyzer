// src/lib/queryPlan.ts

// SIO-1107: pure query-plan evaluation, ported from the official Couchbase MCP
// server's evaluate_query_plan. Walks an EXPLAIN plan JSON and derives findings
// the agent can cite as evidence (primary scan, non-covering index, join shape).
// No SDK dependency -- fully unit-testable.

export interface PlanFinding {
	severity: "info" | "warning";
	message: string;
}

export type PlanOperator = Record<string, unknown> & { "#operator": string };

// Recursively collect every node carrying an `#operator` key. A generic walk
// over all object values covers the plan tree's varied child slots (~child,
// ~children, scan, scans, first, second, input arrays) without enumerating them.
export function collectOperators(plan: unknown): PlanOperator[] {
	const found: PlanOperator[] = [];
	const seen = new Set<object>();
	const walk = (node: unknown): void => {
		if (node === null || typeof node !== "object") return;
		if (seen.has(node)) return;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		const record = node as Record<string, unknown>;
		if (typeof record["#operator"] === "string") {
			found.push(record as PlanOperator);
		}
		for (const value of Object.values(record)) walk(value);
	};
	walk(plan);
	return found;
}

function operatorText(op: PlanOperator, field: string): string | undefined {
	const value = op[field];
	return typeof value === "string" ? value : undefined;
}

export function evaluateQueryPlan(plan: unknown): PlanFinding[] {
	const operators = collectOperators(plan);
	if (operators.length === 0) {
		return [
			{
				severity: "info",
				message: "No plan operators found; the statement may not touch a keyspace (system or constant query).",
			},
		];
	}

	const findings: PlanFinding[] = [];
	const names = operators.map((op) => op["#operator"]);
	const hasFetch = names.some((n) => /^Fetch$/i.test(n));

	const primaryScans = operators.filter((op) => /^PrimaryScan/i.test(op["#operator"]));
	for (const scan of primaryScans) {
		const keyspace = operatorText(scan, "keyspace") ?? "unknown keyspace";
		findings.push({
			severity: "warning",
			message: `Full primary scan on \`${keyspace}\` -- every document is read. Create a secondary index on the filtered fields (see capella_get_index_advisor_recommendations).`,
		});
	}

	const indexScans = operators.filter((op) => /^IndexScan/i.test(op["#operator"]));
	let anyCovering = false;
	for (const scan of indexScans) {
		const index = operatorText(scan, "index") ?? "unknown index";
		const keyspace = operatorText(scan, "keyspace") ?? "unknown keyspace";
		const covers = Array.isArray(scan.covers) && scan.covers.length > 0;
		if (covers) anyCovering = true;
		findings.push({
			severity: "info",
			message: `Index scan uses \`${index}\` on \`${keyspace}\`${covers ? " (covering: the index serves the projection without a fetch)" : ""}.`,
		});
	}
	if (indexScans.length > 0 && hasFetch && !anyCovering) {
		findings.push({
			severity: "warning",
			message:
				"Index scan is followed by a Fetch phase -- the index does NOT cover the projection, so every matching document is fetched. Consider a covering index that appends the projected fields as trailing index keys.",
		});
	}

	if (names.some((n) => /^(IntersectScan|UnionScan|DistinctScan)$/i.test(n))) {
		findings.push({
			severity: "info",
			message:
				"The plan combines multiple index scans (Intersect/Union/DistinctScan). Check whether one composite index would serve the predicate in a single scan.",
		});
	}

	const joins = operators.filter((op) => /^(NestedLoopJoin|HashJoin|NestedLoopNest|HashNest)$/i.test(op["#operator"]));
	for (const join of joins) {
		findings.push({
			severity: "info",
			message: `Join strategy: ${join["#operator"]}. Ensure the smaller keyspace drives the join and the join key is indexed.`,
		});
	}

	if (findings.length === 0) {
		findings.push({
			severity: "info",
			message: `Plan contains ${operators.length} operators with no scan-related concerns detected.`,
		});
	}
	return findings;
}

export function formatPlanFindings(findings: PlanFinding[]): string {
	return findings.map((f) => `- [${f.severity.toUpperCase()}] ${f.message}`).join("\n");
}
