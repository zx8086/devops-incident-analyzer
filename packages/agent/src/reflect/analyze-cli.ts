// packages/agent/src/reflect/analyze-cli.ts
//
// SIO-1834 (A4): read a window of runs, scan them, write the report, gate it.
//
//   bun run --filter @devops-agent/agent reflect:analyze -- --hours 168
//
// Output goes to a GITIGNORED directory: findings quote real tool errors, and
// redactPiiContent deliberately preserves hostnames, IPs and account ids (SIO-861), so a
// report is not committable in a public repo.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkspaceRoot } from "../paths.ts";
import { listSessions } from "./adapter-langsmith.ts";
import { aggregate } from "./aggregate.ts";
import { findRetries } from "./anchors.ts";
import { lintAnalysis } from "./check-analysis.ts";
import { normalizeSession } from "./normalize.ts";
import { renderMarkdown } from "./report.ts";
import { scanSession } from "./scan.ts";

const DEFAULT_HOURS = 168;
const DEFAULT_LIMIT = 200;
// Resolved against the WORKSPACE ROOT, not the cwd: the script runs from packages/agent,
// and a relative path would write packages/agent/experiments/reflect/ -- outside the
// .gitignore rule, which would stage a report full of real tool errors in a public repo.
export const REPORT_SUBDIR = "experiments/reflect";

function intArg(argv: string[], name: string, fallback: number): number {
	const index = argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const raw = argv[index + 1];
	// A bare flag must fail loudly: silently falling back would analyze a different window
	// than the one asked for, and the report would not say so.
	if (!raw || raw.startsWith("--")) {
		process.stderr.write(`--${name} requires a value\n`);
		process.exit(2);
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		process.stderr.write(`--${name} must be a positive integer, got "${raw}"\n`);
		process.exit(2);
	}
	return value;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const hours = intArg(argv, "hours", DEFAULT_HOURS);
	const limit = intArg(argv, "limit", DEFAULT_LIMIT);

	const { sessions, warnings } = await listSessions({ hours, limit });
	const scans = sessions.map((session) => scanSession(normalizeSession(session)));

	const analysis = aggregate(scans, { hours });
	analysis.retries = findRetries(scans);
	for (const warning of warnings) analysis.notes.push(`adapter warning: ${warning}`);

	const stamp = new Date().toISOString().slice(0, 10);
	const reportDir = join(getWorkspaceRoot(), REPORT_SUBDIR);
	mkdirSync(reportDir, { recursive: true });
	const jsonPath = join(reportDir, `${stamp}-analysis.json`);
	const mdPath = join(reportDir, `${stamp}-analysis.md`);
	writeFileSync(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`);
	writeFileSync(mdPath, renderMarkdown(analysis));

	const violations = lintAnalysis(analysis);
	process.stdout.write(
		`${JSON.stringify({
			json: jsonPath,
			md: mdPath,
			sessions: analysis.stats.sessions,
			findings: analysis.stats.findings,
			portfolio: analysis.stats.portfolio,
			retries: analysis.retries.length,
			violations: violations.length,
		})}\n`,
	);
	for (const violation of violations) process.stdout.write(`  [${violation.rule}] ${violation.detail}\n`);
	if (violations.length) process.exit(1);
}

main().catch((error) => {
	process.stderr.write(`reflect:analyze failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
