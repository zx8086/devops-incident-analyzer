// packages/agent/src/eval/single-agent-probe-cli.ts
//
// SIO-1441: tier-2 OKF spec audit entrypoint. Probes a single sub-agent standalone (real MCP
// tool calls, real Bedrock, no buildGraph() anywhere in the path), then optionally the
// orchestrator's single-shot aggregation over that result, then optionally grades the sub-agent
// report against reference findings via the existing judgeSubagentReports. This repo has no CI
// and does not mock -- this hits live infra by design, same as the rest of the eval program.
//
// Env vars (following this dir's EVAL_*/PROBE_* convention, not CLI flags):
//   PROBE_DATASOURCE       required, e.g. "gitlab" | "elastic" | "kafka" | "couchbase" |
//                           "konnect" | "atlassian" | "aws"
//   PROBE_SCENARIO         required, the user-turn text the sub-agent investigates
//   PROBE_RUN_ORCHESTRATOR "true" to also run the aggregator's single-shot synthesis over the
//                           sub-agent's result (default: skip, report the sub-agent output only)
//   PROBE_REFERENCE_FINDINGS  JSON object { "<dataSourceId>": "ground truth text" } -- when set,
//                           grades the sub-agent report via judgeSubagentReports (another live
//                           OpenAI call) and prints the verdict; omitted = ungraded probe only.
//
// To A/B a SOUL.md/RULES.md edit: run this script twice, once per git worktree/branch with the
// variant under test, with WORKSPACE_ROOT pinned per invocation (paths.ts respects this env var)
// so each process resolves its own agents/ tree. No in-process cache-busting exists by design --
// see project memory feedback_no_ci_no_mocking and SIO-1441's ticket description.
import { judgeSubagentReports } from "./evaluators.ts";
import { probeOrchestrator, probeSubAgent } from "./single-agent-probe.ts";
import { buildSubagentReports } from "./subagent-reports.ts";

async function main(): Promise<void> {
	const dataSourceId = process.env.PROBE_DATASOURCE;
	const scenario = process.env.PROBE_SCENARIO;
	if (!dataSourceId || !scenario) {
		process.stderr.write("PROBE_DATASOURCE and PROBE_SCENARIO are required.\n");
		process.exit(1);
	}

	process.stdout.write(`Probing ${dataSourceId} with scenario: ${scenario}\n`);
	const results = await probeSubAgent(dataSourceId, scenario);

	if (results.length === 0) {
		process.stdout.write("No DataSourceResult produced -- check MCP connectivity for this datasource.\n");
		process.exit(1);
	}

	for (const r of results) {
		process.stdout.write(`\n--- ${r.dataSourceId}${r.deploymentId ? `/${r.deploymentId}` : ""} [${r.status}] ---\n`);
		process.stdout.write(`${String(r.data)}\n`);
		if (r.toolErrors && r.toolErrors.length > 0) {
			process.stdout.write(`Tool errors: ${r.toolErrors.map((e) => `${e.toolName} (${e.category})`).join(", ")}\n`);
		}
	}

	if (process.env.PROBE_RUN_ORCHESTRATOR === "true") {
		process.stdout.write("\n--- Orchestrator synthesis ---\n");
		const answer = await probeOrchestrator(results, scenario);
		process.stdout.write(`${answer}\n`);
	}

	const referenceFindingsRaw = process.env.PROBE_REFERENCE_FINDINGS;
	if (referenceFindingsRaw) {
		const referenceFindings = JSON.parse(referenceFindingsRaw) as { [dataSourceId: string]: string };
		const reports = buildSubagentReports(results);
		const feedback = await judgeSubagentReports(reports, referenceFindings);
		process.stdout.write("\n--- Grading (judgeSubagentReports) ---\n");
		if (feedback.length === 0) {
			process.stdout.write("No feedback produced (judge call failed or no overlapping datasources).\n");
		}
		for (const f of feedback) {
			process.stdout.write(`  [${f.key}] score=${f.score}: ${f.comment}\n`);
		}
	}
}

main();
