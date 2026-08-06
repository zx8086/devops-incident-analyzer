// packages/agent/src/eval/run-mcp-tool-eval.ts
//
// SIO-1398: runs the mcp-tool-eval dataset -- per-datasource probes that audit TOOL
// correctness (right calls, valid arguments, right data back) against LIVE MCP servers.
//
// Deliberately does NOT expose --sub-agent-model. This is not a model A/B (that is
// run-incident-replay-eval.ts); the variable under test here is the MCP tooling, so the model
// should stay whatever the manifest resolves. Use --datasource to audit one server at a time.
//
//   bun run eval:mcp-tool                          # every datasource
//   bun run eval:mcp-tool -- --datasource elastic  # one server
//
// Every example pins ONE datasource, so a run fans out to a single sub-agent and any failure
// is attributable to that server rather than to the 7-way supervisor fan-out.

import { spawnSync } from "node:child_process";
import { evaluate } from "langsmith/evaluation";
import {
	confidenceThreshold,
	datasourcesCovered,
	expectedToolsFired,
	toolArgValidity,
	toolDataUtilization,
	toolEfficiency,
	toolNameValidity,
	toolResponseHealth,
} from "./evaluators.ts";
import { coveredDatasources, examplesForDatasource } from "./mcp-tool-dataset.ts";
import { runAgent } from "./run-function.ts";

const DATASET_NAME = "mcp-tool-eval";

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const value = argv[i + 1];
	// Same guard as run-incident-replay-eval.ts (CodeRabbit PR #590): a bare `--datasource`, or
	// one followed by another flag, would otherwise silently select nothing and "pass".
	if (!value || value.startsWith("--")) {
		console.error(`--${name} requires a value.`);
		process.exit(1);
	}
	return value;
}

const datasource = opt("datasource");
const known = coveredDatasources();
if (datasource && !known.includes(datasource)) {
	console.error(`--datasource "${datasource}" has no examples. Covered: ${known.join(", ")}.`);
	process.exit(1);
}

// LangSmith's evaluate() takes a dataset NAME, so a per-datasource run filters client-side on
// the example ids that belong to that datasource. Splitting into one LangSmith dataset per
// datasource was rejected: 7 datasets would fragment the Compare view and multiply the upload
// scripts for no analytical gain.
const selected = datasource ? examplesForDatasource(datasource) : undefined;
const exampleCount = selected?.length;

console.log("WARNING: this hits the LIVE MCP servers your .env points at (and Bedrock).");
console.log(
	datasource
		? `Datasource: ${datasource} (${exampleCount} example(s))`
		: `Datasources: ${known.join(", ")} (full dataset)`,
);
console.log("Estimated cost: single sub-agent per example, so well under a full incident replay.");
console.log("Continue in 5s or Ctrl-C.");
await new Promise((r) => setTimeout(r, 5000));

// replay-outputs re-grades recorded outputs without touching MCP, so gating on server
// reachability would block the exact offline iteration the mode exists for.
if (process.env.EVAL_FIXTURE_MODE === "replay-outputs") {
	console.log("EVAL_FIXTURE_MODE=replay-outputs: skipping MCP precheck (no live systems touched).");
} else {
	console.log("Running precheck...");
	const precheck = spawnSync("bun", ["run", "src/eval/precheck.ts"], { stdio: "inherit" });
	if (precheck.status !== 0) {
		console.error("Precheck failed; fix the missing MCP servers and re-run.");
		process.exit(precheck.status ?? 1);
	}
}

// Outside a git checkout .stdout is null and .trim() would throw before the eval starts.
const gitRev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" });
const gitSha = gitRev.status === 0 && gitRev.stdout ? gitRev.stdout.trim() : "nogit";
const experimentPrefix = `mcp-tool-eval-${gitSha}${datasource ? `-${datasource}` : ""}`;
console.log(`Starting evaluation, experiment prefix: ${experimentPrefix}`);

const results = await evaluate(
	(inputs: Record<string, unknown>) => runAgent(inputs as Parameters<typeof runAgent>[0]),
	{
		data: DATASET_NAME,
		evaluators: [
			// Tool-correctness keys (SIO-1398), all deterministic.
			toolArgValidity,
			toolNameValidity,
			expectedToolsFired,
			toolResponseHealth,
			toolEfficiency,
			// The one LLM judge -- the only per-example cost beyond the agent run itself.
			toolDataUtilization,
			// Reused from the incident evals: cheap, and a tool probe that fails to target its
			// own pinned datasource is worth catching here too.
			datasourcesCovered,
			confidenceThreshold,
		],
		experimentPrefix,
		// Live MCP servers and Bedrock quotas are not sized for concurrent example fan-out; this
		// pins the existing implicit sequential behavior explicitly.
		maxConcurrency: 1,
		metadata: {
			gitSha,
			datasource: datasource ?? "all",
			fixtureMode: process.env.EVAL_FIXTURE_MODE ?? "live",
		},
	},
);

console.log("Done. View results in LangSmith UI under the experiment prefix above.");
console.log(`Compare at: Datasets -> ${DATASET_NAME} -> Compare (filter by "mcp-tool-eval-${gitSha}")`);
console.log(results);
