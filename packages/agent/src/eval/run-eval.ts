// packages/agent/src/eval/run-eval.ts
import { spawnSync } from "node:child_process";
import { evaluate } from "langsmith/evaluation";
import { confidenceThreshold, datasourcesCovered, responseQualityJudge } from "./evaluators.ts";
import { runAgent } from "./run-function.ts";

console.log("WARNING: this hits the systems your .env points at (Bedrock, OpenAI, all 6 MCP servers).");
console.log("Estimated cost: $0.50-1.50 per run. Time: ~5-10min. Continue in 5s or Ctrl-C.");
await new Promise((r) => setTimeout(r, 5000));

console.log("Running precheck...");
const precheck = spawnSync("bun", ["run", "src/eval/precheck.ts"], { stdio: "inherit" });
if (precheck.status !== 0) {
	console.error("Precheck failed; fix the missing MCP servers and re-run.");
	process.exit(precheck.status ?? 1);
}

const gitSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).stdout.trim();
const experimentPrefix = `agent-eval-${gitSha}`;
console.log(`Starting evaluation, experiment prefix: ${experimentPrefix}`);

const opts = {
	data: "devops-incident-eval",
	evaluators: [datasourcesCovered, confidenceThreshold, responseQualityJudge],
	experimentPrefix,
	// biome-ignore lint/suspicious/noExplicitAny: SIO-680 - langsmith evaluate overload resolution
} as any;
const results = await evaluate(runAgent, opts);

console.log("Done. View results in LangSmith UI under the experiment prefix above.");
console.log(results);
