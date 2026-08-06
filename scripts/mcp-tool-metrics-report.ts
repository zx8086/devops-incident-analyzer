// scripts/mcp-tool-metrics-report.ts
// SIO-1400: print the MCP tool-call usage counters recorded when
// MCP_TOOL_METRICS_DB_PATH is set (see packages/shared/src/tool-call-metrics.ts).
// Usage: bun scripts/mcp-tool-metrics-report.ts [db-path]
import { Database } from "bun:sqlite";

interface CountRow {
	server: string;
	tool: string;
	calls: number;
	failures: number;
	first_called_at: string;
	last_called_at: string;
}

const dbPath = process.argv[2] ?? process.env.MCP_TOOL_METRICS_DB_PATH;
if (!dbPath) {
	console.error("Usage: bun scripts/mcp-tool-metrics-report.ts [db-path] (or set MCP_TOOL_METRICS_DB_PATH)");
	process.exit(1);
}

let rows: CountRow[];
try {
	const db = new Database(dbPath, { readonly: true });
	rows = db
		.query<CountRow, []>(
			"SELECT server, tool, calls, failures, first_called_at, last_called_at FROM mcp_tool_call_counts ORDER BY server ASC, calls DESC, tool ASC",
		)
		.all();
	db.close(false);
} catch (error) {
	console.error(`Cannot read metrics DB at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

if (rows.length === 0) {
	console.log(`No tool calls recorded yet in ${dbPath}`);
	process.exit(0);
}

const successPct = (r: CountRow): string => (((r.calls - r.failures) / r.calls) * 100).toFixed(1);

const header = ["server", "tool", "calls", "failures", "success%", "first_called_at", "last_called_at"];
const table = rows.map((r) => [
	r.server,
	r.tool,
	String(r.calls),
	String(r.failures),
	successPct(r),
	r.first_called_at,
	r.last_called_at,
]);
const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => (row[i] as string).length)));
const formatLine = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");

console.log(formatLine(header));
console.log(formatLine(widths.map((w) => "-".repeat(w))));
for (const row of table) console.log(formatLine(row));

const totals = rows.reduce((acc, r) => ({ calls: acc.calls + r.calls, failures: acc.failures + r.failures }), {
	calls: 0,
	failures: 0,
});
const servers = new Set(rows.map((r) => r.server)).size;
console.log(
	`\n${rows.length} tools across ${servers} servers; ${totals.calls} calls, ${totals.failures} failures (${(((totals.calls - totals.failures) / totals.calls) * 100).toFixed(1)}% success)`,
);
