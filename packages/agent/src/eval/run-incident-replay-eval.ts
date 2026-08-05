// packages/agent/src/eval/run-incident-replay-eval.ts
//
// A/B harness for comparing sub-agent models on real-incident replays (7 sub-agents; root
// incident-analyzer orchestrator is unaffected by --sub-agent-model and always resolves from
// its own manifest). This harness exposes ONLY --sub-agent-model, applied via
// EVAL_SUB_AGENT_MODEL_OVERRIDE (see llm.ts's applyEvalModelOverride) -- read at call time inside
// resolveRoleModelConfig, no agent.yaml edit and no restart needed between runs.
//
// Experiments land in LangSmith against the "incident-replay-eval" dataset, directly comparable
// in LangSmith's UI (Datasets -> incident-replay-eval -> Compare). The experiment name is always
// the actual resolved sub-agent model -- SIO-1372: an earlier version labeled every run
// "current" or "reverted-to-<model>", which reads as meaningless noise once more than one A/B
// has happened (reverted relative to WHICH prior state?). Naming by the real model the run used
// stays correct across every future comparison, not just the one it was written for.
//
//   bun run eval:incident-replay                                    # sub-agent model from agent.yaml as-is
//   bun run eval:incident-replay -- --sub-agent-model claude-opus-5  # explicit override

import { spawnSync } from "node:child_process";
import { loadAgent } from "@devops-agent/gitagent-bridge";
import { evaluate } from "langsmith/evaluation";
import { resolveRoleModelConfig } from "../llm.ts";
import { getAgentsDir } from "../paths.ts";
import {
	confidenceThreshold,
	datasourcesCovered,
	judgeModelConfig,
	responseQualityJudge,
	subagentEvidenceJudge,
} from "./evaluators.ts";
import { runAgent } from "./run-function.ts";

const DATASET_NAME = "incident-replay-eval";

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const value = argv[i + 1];
	// CodeRabbit PR #590: a bare `--sub-agent-model` (or one followed by another flag) would
	// silently set the override to undefined/"--flag" and run the WRONG leg of an A/B.
	if (!value || value.startsWith("--")) {
		console.error(`--${name} requires a value.`);
		process.exit(1);
	}
	return value;
}

// SIO-1378: n=32 single-shot runs sit inside judge/model noise -- the SIO-1375 A/B conclusion
// flipped once a config bug was fixed. numRepetitions is the SDK's own lever for tightening
// that; any model DECISION should use --repetitions >= 2.
function intOpt(name: string): number | undefined {
	const raw = opt(name);
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== raw.trim()) {
		console.error(`--${name} must be a positive integer, got "${raw}".`);
		process.exit(1);
	}
	return parsed;
}

// Applying the override via this script's OWN process.env, not the shell env the user set --
// so `bun run eval:incident-replay -- --sub-agent-model X` is the only thing that needs saying;
// nothing about the current shell session or a later unrelated `bun run` is affected.
const subAgentOverride = opt("sub-agent-model");
if (subAgentOverride) {
	process.env.EVAL_SUB_AGENT_MODEL_OVERRIDE = subAgentOverride;
}

// SIO-1372: resolve the ACTUAL model this run will use (override or agent.yaml default) so the
// experiment name always reflects reality, never a stale "current"/"reverted" label from
// whichever swap this script was last edited for. Any of the 7 sub-agents resolves the same
// model when subAgentName is passed and the manifest model override is honored identically, so
// elastic-agent is an arbitrary but representative choice.
const orchestrator = loadAgent(getAgentsDir("incident-analyzer"));
const resolvedSubAgentModel =
	subAgentOverride ??
	resolveRoleModelConfig("subAgent", orchestrator, "elastic-agent").modelConfig?.preferred ??
	"unknown";

const repetitions = intOpt("repetitions") ?? 1;

console.log("WARNING: this hits the systems your .env points at (Bedrock, OpenAI, all 7 MCP servers).");
console.log(
	`Sub-agent model: ${resolvedSubAgentModel} | judge: ${judgeModelConfig().model} | repetitions: ${repetitions}`,
);
console.log("Estimated cost: $0.50-1.50 and ~5-10min PER repetition. Continue in 5s or Ctrl-C.");
await new Promise((r) => setTimeout(r, 5000));

console.log("Running precheck...");
const precheck = spawnSync("bun", ["run", "src/eval/precheck.ts"], { stdio: "inherit" });
if (precheck.status !== 0) {
	console.error("Precheck failed; fix the missing MCP servers and re-run.");
	process.exit(precheck.status ?? 1);
}

// CodeRabbit PR #590: outside a git checkout, .stdout is null and .trim() throws before the
// eval even starts -- a placeholder keeps the experiment name well-formed instead.
const gitRev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" });
const gitSha = gitRev.status === 0 && gitRev.stdout ? gitRev.stdout.trim() : "nogit";
const experimentPrefix = `agent-eval-${gitSha}-subagent-${resolvedSubAgentModel}`;
console.log(`Starting evaluation, experiment prefix: ${experimentPrefix}`);

// SIO-1378: the SIO-680 `as any` cast is gone -- langsmith@0.6.3's EvaluatorT accepts the
// (run, example) function shape directly. The target is widened to Record<string, unknown>
// because evaluate() types targets as KVMap-consuming and parameter contravariance rejects
// runAgent's narrower declared inputs; runAgent Zod-parses at its boundary, so the cast is
// safe. maxConcurrency: 1 pins today's implicit sequential behavior explicitly (live MCP
// servers + Bedrock quotas are not sized for concurrent example fan-out). Experiment metadata
// records everything a future reader needs to know before comparing two runs: scores are only
// comparable within one judge model and one fixture mode.
const results = await evaluate(
	(inputs: Record<string, unknown>) => runAgent(inputs as Parameters<typeof runAgent>[0]),
	{
		data: DATASET_NAME,
		evaluators: [datasourcesCovered, confidenceThreshold, responseQualityJudge, subagentEvidenceJudge],
		experimentPrefix,
		maxConcurrency: 1,
		numRepetitions: repetitions,
		metadata: {
			gitSha,
			subAgentModel: resolvedSubAgentModel,
			judgeModel: judgeModelConfig().model,
			repetitions,
			fixtureMode: process.env.EVAL_FIXTURE_MODE ?? "live",
		},
	},
);

console.log("Done. View results in LangSmith UI under the experiment prefix above.");
console.log(`Compare both sides at: Datasets -> ${DATASET_NAME} -> Compare (filter by "agent-eval-${gitSha}")`);
console.log(results);
