// scripts/decision-metrics-report.ts
// SIO-1858: print the per-decision rows recorded when DECISION_METRICS_DB_PATH is
// set (see packages/shared/src/decision-metrics.ts). Sibling of
// mcp-tool-metrics-report.ts, which reports the lifetime per-tool counters; this
// one reports per-decision quality for the Jev seams and can be windowed, which
// the counter table cannot.
// Usage: bun scripts/decision-metrics-report.ts [db-path] [--since <ISO>] [--seam <name>]
import { Database } from "bun:sqlite";

interface DecisionRow {
	at: string;
	seam: string;
	outcome: string;
	model: string | null;
	latency_ms: number | null;
	input_tokens: number | null;
	items_in: number | null;
	items_dropped: number | null;
	rank_correlation: number | null;
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
}

const positional = process.argv.slice(2).filter((a, i, all) => {
	if (a.startsWith("--")) return false;
	const prev = all[i - 1];
	return !(prev === "--since" || prev === "--seam");
});
const dbPath = positional[0] ?? process.env.DECISION_METRICS_DB_PATH;
if (!dbPath) {
	console.error(
		"Usage: bun scripts/decision-metrics-report.ts [db-path] [--since <ISO>] [--seam <name>] (or set DECISION_METRICS_DB_PATH)",
	);
	process.exit(1);
}

const since = argValue("--since");
const seam = argValue("--seam");
// `at` is ISO-8601, so a string comparison IS a chronological one.
const where: string[] = [];
const params: Record<string, string> = {};
if (since) {
	where.push("at >= $since");
	params.$since = since;
}
if (seam) {
	where.push("seam = $seam");
	params.$seam = seam;
}
const SQL = `SELECT at, seam, outcome, model, latency_ms, input_tokens, items_in, items_dropped, rank_correlation
FROM decision_metrics${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
ORDER BY at ASC`;

let rows: DecisionRow[];
try {
	const db = new Database(dbPath, { readonly: true });
	rows = db.query<DecisionRow, typeof params>(SQL).all(params);
	db.close(false);
} catch (error) {
	console.error(
		`Cannot read decision metrics DB at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}

if (rows.length === 0) {
	console.log(
		`No decisions recorded yet in ${dbPath}${seam ? ` for seam ${seam}` : ""}${since ? ` since ${since}` : ""}`,
	);
	process.exit(0);
}

// Percentile over a sorted array, nearest-rank. Small n is the norm here (a
// handful of turns), where an interpolated percentile would over-promise.
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.ceil((p / 100) * sorted.length);
	const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
	return sorted[idx] as number;
}

const bySeam = new Map<string, DecisionRow[]>();
for (const r of rows) {
	const list = bySeam.get(r.seam) ?? [];
	list.push(r);
	bySeam.set(r.seam, list);
}

// $0.042 per million INPUT tokens for jev-1.13.0; output tokens are free.
// Stated on https://docs.typesafe.ai/models as of 2026-09-20 and liable to move,
// so the rate is named here rather than buried in a magic number.
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

for (const [name, list] of [...bySeam.entries()].sort(([a], [b]) => a.localeCompare(b))) {
	const applied = list.filter((r) => r.outcome === "applied");
	const skipped = list.filter((r) => r.outcome === "skipped").length;
	const failed = list.filter((r) => r.outcome === "failed").length;
	const latencies = applied
		.map((r) => r.latency_ms)
		.filter((v): v is number => v !== null)
		.sort((a, b) => a - b);
	const tokens = applied.reduce((s, r) => s + (r.input_tokens ?? 0), 0);
	const correlations = applied.map((r) => r.rank_correlation).filter((v): v is number => v !== null);
	const itemsIn = applied.reduce((s, r) => s + (r.items_in ?? 0), 0);
	const itemsDropped = applied.reduce((s, r) => s + (r.items_dropped ?? 0), 0);

	console.log(`\n${name}`);
	console.log("-".repeat(name.length));
	console.log(`  decisions        ${list.length}  (applied ${applied.length}, skipped ${skipped}, failed ${failed})`);
	console.log(`  window           ${list[0]?.at} .. ${list[list.length - 1]?.at}`);
	if (latencies.length > 0) {
		console.log(
			`  latency ms       p50 ${percentile(latencies, 50)}  p95 ${percentile(latencies, 95)}  max ${latencies[latencies.length - 1]}`,
		);
	}
	if (tokens > 0) {
		const usd = tokens * USD_PER_INPUT_TOKEN;
		console.log(`  input tokens     ${tokens}  (about $${usd.toFixed(5)} at $0.042/Mtok)`);
	}
	if (itemsIn > 0) {
		console.log(
			`  items            ${itemsIn} in, ${itemsDropped} dropped (${((itemsDropped / itemsIn) * 100).toFixed(1)}%)`,
		);
	}
	if (correlations.length > 0) {
		const mean = correlations.reduce((s, v) => s + v, 0) / correlations.length;
		// The point of the whole exercise: 1.0 means the model agreed with the
		// arithmetic it replaced on every decision, which would mean it bought
		// nothing. Lower means it reordered, and whether that was an improvement is
		// a separate question the fixtures answer.
		console.log(
			`  rank correlation mean ${mean.toFixed(3)} over ${correlations.length} decisions (1.0 = same order as the deterministic path)`,
		);
	}
	const models = [...new Set(applied.map((r) => r.model).filter((m): m is string => m !== null))];
	if (models.length > 0) console.log(`  model            ${models.join(", ")}`);
}
