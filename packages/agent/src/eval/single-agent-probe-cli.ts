// packages/agent/src/eval/single-agent-probe-cli.ts
//
// SIO-1441: tier-2 OKF spec audit entrypoint. Probes a single sub-agent standalone (real MCP
// tool calls, real Bedrock, no buildGraph() anywhere in the path), then optionally the
// orchestrator's single-shot aggregation over that result, then optionally grades the sub-agent
// report against reference findings via the existing judgeSubagentReports. This repo has no CI
// and does not mock -- this hits live infra by design, same as the rest of the eval program.
//
// Env vars (following this dir's EVAL_*/PROBE_* convention, not CLI flags):
//   PROBE_DATASOURCE       required, one of DATA_SOURCE_IDS (elastic/kafka/couchbase/konnect/
//                           gitlab/atlassian/aws)
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
import { redactPiiContent } from "@devops-agent/shared";
import { judgeSubagentReports } from "./evaluators.ts";
import { parseProbeEnv, probeOrchestrator, probeSubAgent } from "./single-agent-probe.ts";
import { buildSubagentReports } from "./subagent-reports.ts";

async function main(): Promise<void> {
	const parsed = parseProbeEnv(process.env);
	if (!parsed.success) {
		process.stderr.write(
			`Invalid probe environment:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}\n`,
		);
		process.exit(1);
	}
	const { dataSourceId, scenario, runOrchestrator, referenceFindings } = parsed.data;

	process.stdout.write(`Probing ${dataSourceId} with scenario: ${scenario}\n`);
	const results = await probeSubAgent(dataSourceId, scenario);

	if (results.length === 0) {
		process.stdout.write("No DataSourceResult produced -- check MCP connectivity for this datasource.\n");
		process.exit(1);
	}

	// CodeRabbit (PR #632): aggregate() redacts its output via redactPiiContent before it is
	// used anywhere (aggregator.ts:1676); this probe path previously wrote live MCP/model
	// content straight to stdout with no redaction, letting real PII reach terminal/log capture.
	for (const r of results) {
		process.stdout.write(`\n--- ${r.dataSourceId}${r.deploymentId ? `/${r.deploymentId}` : ""} [${r.status}] ---\n`);
		process.stdout.write(`${redactPiiContent(String(r.data))}\n`);
		if (r.toolErrors && r.toolErrors.length > 0) {
			process.stdout.write(`Tool errors: ${r.toolErrors.map((e) => `${e.toolName} (${e.category})`).join(", ")}\n`);
		}
	}

	if (runOrchestrator) {
		process.stdout.write("\n--- Orchestrator synthesis ---\n");
		// probeOrchestrator already redacts its own output (single-agent-probe.ts) -- no
		// double-redaction needed here.
		const answer = await probeOrchestrator(results, scenario);
		process.stdout.write(`${answer}\n`);
	}

	if (referenceFindings) {
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
