// packages/agent/src/eval/run-eval.ts
import { spawnSync } from "node:child_process";
import { evaluate } from "langsmith/evaluation";
import type { Example, Run } from "langsmith/schemas";
import { confidenceThreshold, datasourcesCovered, datasourcesPrecision, responseQualityJudge } from "./evaluators.ts";
import { LANDING_ZONE_DATASET } from "./landing-zone-dataset.ts";
import {
	evaluateLandingZoneThresholds,
	LANDING_ZONE_EVALUATORS,
	type LandingZoneFeedback,
} from "./landing-zone-evaluators.ts";
import { runLandingZoneAgent } from "./landing-zone-run-function.ts";
import { runAgent } from "./run-function.ts";

function requestedAgent(args: string[]): "incident-analyzer" | "landing-zone-terraform" {
	const index = args.indexOf("--agent");
	if (index === -1) return "incident-analyzer";
	const value = args[index + 1];
	if (value === "incident-analyzer" || value === "landing-zone-terraform") return value;
	throw new Error(`Unsupported --agent value: ${value ?? "missing"}`);
}

const agent = requestedAgent(process.argv.slice(2));
console.log(
	agent === "landing-zone-terraform"
		? "WARNING: this runs the Landing Zone graph against the evidence services configured in .env."
		: "WARNING: this hits the systems your .env points at (Bedrock, OpenAI, all 6 MCP servers).",
);
console.log("Estimated cost: $0.50-1.50 per run. Time: ~5-10min. Continue in 5s or Ctrl-C.");
await new Promise((resolve) => setTimeout(resolve, 5000));

if (agent === "incident-analyzer") {
	console.log("Running precheck...");
	const precheck = spawnSync("bun", ["run", "src/eval/precheck.ts"], { stdio: "inherit" });
	if (precheck.status !== 0) {
		console.error("Precheck failed; fix the missing MCP servers and re-run.");
		process.exit(precheck.status ?? 1);
	}
} else if (!process.env.LANDING_ZONE_IAC_MCP_URL) {
	console.error("LANDING_ZONE_IAC_MCP_URL is required for the Landing Zone evaluation.");
	process.exit(1);
}

const gitSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).stdout.trim();
const experimentPrefix = `${agent}-eval-${gitSha}`;
console.log(`Starting evaluation, experiment prefix: ${experimentPrefix}`);

if (agent === "landing-zone-terraform") {
	// Landing Zone evidence can contain private repository data. Keep this deterministic
	// release gate local; the evaluator signatures remain compatible with LangSmith for an
	// explicitly authorized live experiment.
	process.env.LANGSMITH_TRACING = "false";
	process.env.LANGCHAIN_TRACING_V2 = "false";
	const evaluations: Array<{ id: string; feedback: LandingZoneFeedback[] }> = [];
	for (const example of LANDING_ZONE_DATASET) {
		const outputs = await runLandingZoneAgent(example.inputs);
		const run = { outputs } as unknown as Run;
		const langSmithExample = { outputs: example.outputs } as unknown as Example;
		const feedback = LANDING_ZONE_EVALUATORS.map((evaluator) => evaluator(run, langSmithExample));
		evaluations.push({ id: example.metadata.id, feedback });
		for (const result of feedback.filter((entry) => entry.score !== 1)) {
			console.error(`${example.metadata.id}: ${result.key}: ${result.comment}`);
		}
	}
	const score = (feedback: (typeof evaluations)[number]["feedback"], key: string): number =>
		feedback.find((entry) => entry.key === key)?.score ?? 0;
	const thresholds = evaluateLandingZoneThresholds({
		routingScores: evaluations.map((row) => score(row.feedback, "landing_zone_repository_routing")),
		usefulnessScores: evaluations.map((row) => score(row.feedback, "landing_zone_answer_usefulness")),
		safetyScores: evaluations.flatMap((row) =>
			["landing_zone_no_apply", "landing_zone_no_default_branch_write", "landing_zone_change_gate"].map((key) =>
				score(row.feedback, key),
			),
		),
	});
	console.log(
		`Landing Zone gates: routing=${thresholds.routingAccuracy.toFixed(3)}, safety=${thresholds.safetyCompliance.toFixed(3)}, usefulness=${thresholds.answerUsefulness.toFixed(3)}`,
	);
	if (!thresholds.passed) {
		console.error(
			"Landing Zone evaluation failed the 90% routing, 100% safety, or 90% answer-usefulness release gate.",
		);
		process.exit(1);
	}
	console.log("Done. Landing Zone release gates passed locally; no evaluation evidence was sent to LangSmith.");
	process.exit(0);
}

const results = await evaluate(runAgent, {
	data: "devops-incident-eval",
	// SIO-1694: datasourcesPrecision rides alongside datasourcesCovered -- recall and
	// precision as separate keys, since over-fan-out is invisible to the recall metric.
	evaluators: [datasourcesCovered, datasourcesPrecision, confidenceThreshold, responseQualityJudge],
	experimentPrefix,
});

console.log("Done. View results in LangSmith UI under the experiment prefix above.");
console.log(results);
