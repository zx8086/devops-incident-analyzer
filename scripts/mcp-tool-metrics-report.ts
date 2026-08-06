// scripts/mcp-tool-metrics-report.ts
// SIO-1400: print the MCP tool-call usage counters recorded when
// MCP_TOOL_METRICS_DB_PATH is set (see packages/shared/src/tool-call-metrics.ts).
// SIO-1402: failure-class columns (bad_input / unstructured / unknown_tool).
// Usage: bun scripts/mcp-tool-metrics-report.ts [db-path]
import { Database } from "bun:sqlite";

interface CountRow {
	server: string;
	tool: string;
	calls: number;
	failures: number;
	bad_input_failures: number;
	unstructured_failures: number;
	unknown_tool_failures: number;
	first_called_at: string;
	last_called_at: string;
}

const dbPath = process.argv[2] ?? process.env.MCP_TOOL_METRICS_DB_PATH;
if (!dbPath) {
	console.error("Usage: bun scripts/mcp-tool-metrics-report.ts [db-path] (or set MCP_TOOL_METRICS_DB_PATH)");
	process.exit(1);
}

const FULL_SQL =
	"SELECT server, tool, calls, failures, bad_input_failures, unstructured_failures, unknown_tool_failures, first_called_at, last_called_at FROM mcp_tool_call_counts ORDER BY server ASC, calls DESC, tool ASC";
// SIO-1402: a pre-migration DB (no server restarted since the upgrade) lacks the
// class columns; the recorder migrates on open but this report is read-only, so
// fall back to zeroed class counts instead of erroring.
const LEGACY_SQL =
	"SELECT server, tool, calls, failures, 0 AS bad_input_failures, 0 AS unstructured_failures, 0 AS unknown_tool_failures, first_called_at, last_called_at FROM mcp_tool_call_counts ORDER BY server ASC, calls DESC, tool ASC";

let rows: CountRow[];
try {
	const db = new Database(dbPath, { readonly: true });
	try {
		rows = db.query<CountRow, []>(FULL_SQL).all();
	} catch {
		rows = db.query<CountRow, []>(LEGACY_SQL).all();
	}
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

const header = [
	"server",
	"tool",
	"calls",
	"failures",
	"bad_input",
	"unstructured",
	"unknown_tool",
	"success%",
	"first_called_at",
	"last_called_at",
];
const table = rows.map((r) => [
	r.server,
	r.tool,
	String(r.calls),
	String(r.failures),
	String(r.bad_input_failures),
	String(r.unstructured_failures),
	String(r.unknown_tool_failures),
	successPct(r),
	r.first_called_at,
	r.last_called_at,
]);
const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => (row[i] as string).length)));
const formatLine = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");

console.log(formatLine(header));
console.log(formatLine(widths.map((w) => "-".repeat(w))));
for (const row of table) console.log(formatLine(row));

const totals = rows.reduce(
	(acc, r) => ({
		calls: acc.calls + r.calls,
		failures: acc.failures + r.failures,
		badInput: acc.badInput + r.bad_input_failures,
		unstructured: acc.unstructured + r.unstructured_failures,
		unknownTool: acc.unknownTool + r.unknown_tool_failures,
	}),
	{ calls: 0, failures: 0, badInput: 0, unstructured: 0, unknownTool: 0 },
);
const servers = new Set(rows.map((r) => r.server)).size;
console.log(
	`\n${rows.length} tools across ${servers} servers; ${totals.calls} calls, ${totals.failures} failures (${(((totals.calls - totals.failures) / totals.calls) * 100).toFixed(1)}% success); failure classes: ${totals.badInput} bad-input, ${totals.unstructured} unstructured, ${totals.unknownTool} unknown-tool`,
);
