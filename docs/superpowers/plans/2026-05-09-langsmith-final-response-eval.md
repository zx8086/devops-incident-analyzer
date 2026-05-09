# LangSmith final_response Agent Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a permanent LangSmith eval pipeline (`packages/agent/src/eval/`) that exercises the full 13-node agent graph against 5 incident-shaped queries and scores each run with 3 evaluators (datasources covered, confidence threshold, response-quality LLM judge).

**Architecture:** Five new files in a new subdirectory under the agent package, plus dependency additions for `langsmith` SDK and `openai`. Three workspace-aware `bun run` scripts surface the precheck, dataset upload, and full eval-run flows. On-demand local execution; not in CI.

**Tech Stack:** TypeScript, Bun, `langsmith` SDK (`evaluate()`), `openai` (gpt-4o-mini judge), the existing `langsmith` CLI for dataset uploads, the existing LangGraph agent factory `buildGraph()`.

**Spec:** `docs/superpowers/specs/2026-05-09-langsmith-final-response-eval-design.md` (commit `f9ab445`).

**Decisions locked at plan-writing time:**
- Commit prefix: `SIO-680,SIO-682:` (continuation of the description work this eval tests; reuses originating tickets per memory rule).
- 4-commit TDD split: precheck → dataset → engine → entry+README.

---

## Task 1: Precheck script + workspace wiring

The precheck is the smallest runnable piece — port reachability check for all 6 MCP servers. Lands first so the rest of the plan can rely on `bun run --filter @devops-agent/agent eval:precheck` returning a meaningful exit code.

**Files:**
- Create: `packages/agent/src/eval/precheck.ts`
- Modify: `packages/agent/package.json` (add `eval:precheck` script)

- [ ] **Step 1: Create the precheck script**

Create `packages/agent/src/eval/precheck.ts`:

```typescript
// packages/agent/src/eval/precheck.ts
const PORTS = [9080, 9081, 9082, 9083, 9084, 9085] as const;
const NAMES = ["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian"] as const;

const failures: string[] = [];

for (let i = 0; i < PORTS.length; i++) {
	const port = PORTS[i] as number;
	const name = NAMES[i] as string;
	try {
		const res = await fetch(`http://localhost:${port}/health`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) {
			failures.push(
				`MCP server '${name}' (:${port}) returned ${res.status}; start it: bun run --filter @devops-agent/mcp-server-${name} dev`,
			);
		}
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		failures.push(
			`MCP server '${name}' (:${port}) unreachable (${reason}); start it: bun run --filter @devops-agent/mcp-server-${name} dev`,
		);
	}
}

if (failures.length > 0) {
	for (const f of failures) console.error(f);
	process.exit(1);
}

console.log("All 6 MCP servers reachable");
```

- [ ] **Step 2: Add the `eval:precheck` workspace script**

Open `packages/agent/package.json`. Find the `"scripts"` object (currently `{"test": "bun test", "typecheck": "bunx tsc --noEmit"}`) and replace with:

```json
	"scripts": {
		"test": "bun test",
		"typecheck": "bunx tsc --noEmit",
		"eval:precheck": "bun run src/eval/precheck.ts"
	},
```

- [ ] **Step 3: Run the precheck against the current local environment**

```bash
bun run --filter @devops-agent/agent eval:precheck
```

Expected outcome depends on what's running locally:
- If all 6 ports respond on `/health` with 2xx: prints `All 6 MCP servers reachable`, exit 0.
- If any port is missing/unreachable: prints one error line per failure with the start command, exit 1.

Either outcome is success for this task — what matters is that the script runs cleanly and reports accurately. Don't proceed if the script crashes for unrelated reasons.

- [ ] **Step 4: Run the full repo lint + typecheck**

```bash
bun run typecheck && bun run lint
```

Expected: PASS. The new file is plain TS with no exotic types; should be uneventful.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/eval/precheck.ts packages/agent/package.json
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: precheck script for the agent eval pipeline

Probes the 6 MCP server health endpoints (:9080-:9085) with a 2s
per-port timeout. On failure, prints one line per offending server
with the exact `bun run --filter` command to start it, then exits
non-zero so downstream eval steps fail fast without burning Bedrock
or OpenAI cost on a misconfigured environment.

Wired into packages/agent/package.json as `eval:precheck`. The
dataset upload, run-function, and entry-point land in subsequent
commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Dataset (TS source of truth) + uploader

5 incident-shaped queries with expected outputs, plus the script that uploads them to LangSmith.

**Files:**
- Create: `packages/agent/src/eval/dataset.ts`
- Create: `packages/agent/src/eval/build-dataset.ts`
- Modify: `packages/agent/package.json` (add `eval:upload-dataset` script)

- [ ] **Step 1: Create the dataset source-of-truth**

Create `packages/agent/src/eval/dataset.ts`:

```typescript
// packages/agent/src/eval/dataset.ts
export interface EvalExample {
	inputs: { query: string };
	outputs: {
		expectedDatasources: string[];
		minConfidence: number;
		qualityRubric: string;
	};
}

export const DATASET: EvalExample[] = [
	{
		inputs: {
			query:
				"Consumer group payments-ingest on c72-shared-services-msk has been stuck at 50k lag for 30 minutes; users are seeing stale order status. Diagnose.",
		},
		outputs: {
			expectedDatasources: ["kafka", "elastic", "couchbase"],
			minConfidence: 0.6,
			qualityRubric:
				"Should identify the lag root cause (consumer crash / slow processing / DLQ growth), correlate with Elasticsearch error logs from notifications-service in eu-b2b deployment, and check if downstream Couchbase writes are failing. Mitigation must include scaling consumers OR resetting offsets WITH explicit human-approval flag.",
		},
	},
	{
		inputs: {
			query:
				"Kong /v1/users route is returning 5xx for 15% of requests since 14:00 UTC. Which plugin chain or upstream change broke it?",
		},
		outputs: {
			expectedDatasources: ["konnect", "elastic", "gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Should query Konnect for the route's plugin chain and recent service config changes, search Elasticsearch for upstream service errors aligned with 14:00 UTC, and check GitLab for recent deploys to the upstream service. Should distinguish plugin-misconfiguration from upstream-failure.",
		},
	},
	{
		inputs: {
			query:
				"Couchbase queries on bucket orders-prod are timing out for the last hour. Slow queries or fatal errors?",
		},
		outputs: {
			expectedDatasources: ["couchbase", "elastic"],
			minConfidence: 0.6,
			qualityRubric:
				"Should distinguish slow_queries (latency outliers above threshold) from fatal_requests (true timeouts/OOM). Should check Elasticsearch for the application's database client errors. Mitigation should reference index_analysis if scan-heavy queries are implicated.",
		},
	},
	{
		inputs: {
			query: "AWS bill for our Elastic Cloud spiked 40% this month. Which deployments and which usage class?",
		},
		outputs: {
			expectedDatasources: ["elastic"],
			minConfidence: 0.6,
			qualityRubric:
				"Should pick the billing action (NOT cloud_deployment alone) and break down cost by deployment via the v2 billing API. Should NOT propose mitigation -- this is a cost-reporting query, not an incident.",
		},
	},
	{
		inputs: {
			query:
				"We had a P1 yesterday at 03:00 UTC affecting checkout. Show me the runbook we used and any related Jira tickets.",
		},
		outputs: {
			expectedDatasources: ["atlassian", "gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Should call atlassian.runbook_lookup AND incident_correlation. GitLab for related deploys around the 03:00 UTC window. Response is informational (post-mortem), no remediation steps.",
		},
	},
];
```

- [ ] **Step 2: Create the build/upload script**

Create `packages/agent/src/eval/build-dataset.ts`:

```typescript
// packages/agent/src/eval/build-dataset.ts
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DATASET } from "./dataset.ts";

const TARGET = "/tmp/devops-incident-eval.json";
const DATASET_NAME = "devops-incident-eval";

writeFileSync(TARGET, JSON.stringify(DATASET, null, 2));
console.log(`Wrote ${DATASET.length} examples to ${TARGET}`);

const result = spawnSync("langsmith", ["dataset", "upload", TARGET, "--name", DATASET_NAME], {
	stdio: "inherit",
});

if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
	console.error("`langsmith` CLI not found on PATH. Install it:");
	console.error("  curl -sSL https://raw.githubusercontent.com/langchain-ai/langsmith-cli/main/scripts/install.sh | sh");
	process.exit(1);
}

if (result.status !== 0) {
	console.error(`langsmith dataset upload failed (exit ${result.status})`);
	console.error(`If the dataset already exists, delete it first: langsmith dataset delete ${DATASET_NAME}`);
	process.exit(result.status ?? 1);
}
```

The CLI's interactive prompt will fire if the dataset already exists; the user answers it manually. Per the langsmith-dataset skill, never use `--yes` unless the user explicitly requests it.

- [ ] **Step 3: Add the `eval:upload-dataset` script**

Open `packages/agent/package.json`. Update the `"scripts"` object to:

```json
	"scripts": {
		"test": "bun test",
		"typecheck": "bunx tsc --noEmit",
		"eval:precheck": "bun run src/eval/precheck.ts",
		"eval:upload-dataset": "bun run src/eval/build-dataset.ts"
	},
```

- [ ] **Step 4: Verify the dataset compiles + serializes correctly**

```bash
bun -e "import { DATASET } from './packages/agent/src/eval/dataset.ts'; console.log('count:', DATASET.length); console.log('first query:', DATASET[0].inputs.query.slice(0, 60));"
```

Expected: `count: 5`, then the first ~60 chars of query 1.

- [ ] **Step 5: Run the upload script (writes file + uploads)**

```bash
bun run --filter @devops-agent/agent eval:upload-dataset
```

Expected:
1. Console: `Wrote 5 examples to /tmp/devops-incident-eval.json`
2. langsmith CLI uploads. If the dataset name `devops-incident-eval` doesn't yet exist: prints upload progress, exits 0.
3. If the dataset name already exists: CLI interactively prompts to overwrite — answer `y` if you intend to update it, `n` to abort.

Confirm the dataset is now in LangSmith:

```bash
langsmith dataset get devops-incident-eval
langsmith example list --dataset devops-incident-eval --limit 5
```

Expected: dataset exists with 5 examples; each example has `inputs.query` and `outputs.{expectedDatasources, minConfidence, qualityRubric}`.

- [ ] **Step 6: Run typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/eval/dataset.ts packages/agent/src/eval/build-dataset.ts packages/agent/package.json
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: dataset (5 incident queries) + uploader for the agent eval

dataset.ts is the TS source of truth -- 5 realistic incident queries
spanning the cross-agent correlation (SIO-681), description
disambiguation (SIO-680/682), cost-vs-deployment cross-ref
(commit 3dd029a), and atlassian smart-composer paths.

build-dataset.ts serializes DATASET to /tmp/devops-incident-eval.json
and shells out to the `langsmith` CLI for upload. ENOENT-aware: prints
install instructions if the CLI isn't on PATH. The CLI's interactive
overwrite prompt fires for re-uploads (no `--yes` per the
langsmith-dataset skill convention).

Workspace script: `bun run --filter @devops-agent/agent
eval:upload-dataset`. Run-function and evaluators land in the next
commit; entry-point and README in the one after.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Run-function + evaluators + dependencies

The eval engine: the function that runs the agent against an input query, plus the 3 evaluators that score the result. Adds `langsmith` and `openai` to the agent package's dependencies.

**Files:**
- Create: `packages/agent/src/eval/run-function.ts`
- Create: `packages/agent/src/eval/evaluators.ts`
- Modify: `packages/agent/package.json` (add `openai` and `langsmith` to dependencies)

- [ ] **Step 1: Add `openai` and `langsmith` to the agent package**

```bash
cd packages/agent
bun add langsmith openai
cd ../..
```

This will add lines to `packages/agent/package.json` `dependencies` and update `bun.lock`. Verify:

```bash
grep -E '"(langsmith|openai)"' packages/agent/package.json
```

Expected: both listed in the `dependencies` block. If the catalog versioning kicks in (pulls `langsmith` from the workspace catalog at `^0.5.8`), accept whatever bun picks.

- [ ] **Step 2: Create the run function**

Create `packages/agent/src/eval/run-function.ts`:

```typescript
// packages/agent/src/eval/run-function.ts
import { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "../graph.ts";

let cachedGraph: Awaited<ReturnType<typeof buildGraph>> | undefined;

export async function runAgent(inputs: { query: string }): Promise<{
	output: { response: string; targetDataSources: string[]; confidenceCap?: number };
}> {
	if (!cachedGraph) {
		cachedGraph = await buildGraph({ checkpointerType: "memory" });
	}
	const finalState = await cachedGraph.invoke(
		{ messages: [new HumanMessage(inputs.query)] },
		{ configurable: { thread_id: `eval-${crypto.randomUUID()}` } },
	);
	const lastMessage = finalState.messages.at(-1);
	const responseText =
		typeof lastMessage?.content === "string" ? lastMessage.content : JSON.stringify(lastMessage?.content ?? "");
	return {
		output: {
			response: responseText,
			targetDataSources: finalState.targetDataSources ?? [],
			confidenceCap: finalState.confidenceCap,
		},
	};
}
```

The graph is built once and cached in module scope — saves ~5x compile-time across the 5 queries. Memory checkpointer because each eval thread is isolated.

- [ ] **Step 3: Create the 3 evaluators**

Create `packages/agent/src/eval/evaluators.ts`:

```typescript
// packages/agent/src/eval/evaluators.ts
import OpenAI from "openai";
import type { Example, Run } from "langsmith/schemas";

export function datasourcesCovered(run: Run, example: Example) {
	const expectedRaw = (example.outputs?.expectedDatasources ?? []) as unknown;
	const actualRaw = (run.outputs as { output?: { targetDataSources?: unknown } } | undefined)?.output
		?.targetDataSources ?? [];
	const expected = new Set<string>(Array.isArray(expectedRaw) ? (expectedRaw as string[]) : []);
	const actual = new Set<string>(Array.isArray(actualRaw) ? (actualRaw as string[]) : []);
	const missing = [...expected].filter((d) => !actual.has(d));
	return {
		key: "datasources_covered",
		score: missing.length === 0 ? 1 : 0,
		comment:
			missing.length === 0
				? `All ${expected.size} expected datasources covered`
				: `Missing: ${missing.join(", ")}`,
	};
}

export function confidenceThreshold(run: Run, example: Example) {
	const cap = (run.outputs as { output?: { confidenceCap?: number } } | undefined)?.output?.confidenceCap;
	const min = ((example.outputs?.minConfidence as number | undefined) ?? 0.6) as number;
	const ok = cap === undefined || cap >= min;
	return {
		key: "confidence_threshold",
		score: ok ? 1 : 0,
		comment:
			cap === undefined ? "No confidence cap set (rules satisfied)" : `Confidence capped at ${cap} (min ${min})`,
	};
}

const openai = new OpenAI();

export async function responseQualityJudge(run: Run, example: Example) {
	const rubric = example.outputs?.qualityRubric as string | undefined;
	const response = (run.outputs as { output?: { response?: string } } | undefined)?.output?.response;
	if (!rubric || !response) {
		return { key: "response_quality", score: 0, comment: "missing rubric or response" };
	}
	const r = await openai.chat.completions.create({
		model: "gpt-4o-mini",
		temperature: 0,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: 'Respond with JSON: {"meets_rubric": boolean, "reasoning": string}' },
			{
				role: "user",
				content: `Rubric: ${rubric}\n\nResponse to grade:\n${response}\n\nDoes the response meet the rubric?`,
			},
		],
	});
	const grade = JSON.parse(
		r.choices[0]?.message?.content ?? '{"meets_rubric":false,"reasoning":"empty response"}',
	);
	return { key: "response_quality", score: grade.meets_rubric ? 1 : 0, comment: String(grade.reasoning ?? "") };
}
```

The `key` field is required for local TS evaluators per the langsmith-evaluator skill — without it, the column shows up untitled. The `as unknown` casts inside `datasourcesCovered` / `confidenceThreshold` are because LangSmith's `Run.outputs` and `Example.outputs` are `Record<string, unknown> | null` and the eslint/biome `noExplicitAny` rule blocks the obvious cast.

- [ ] **Step 4: Smoke-test the run function in isolation**

```bash
bun run --filter @devops-agent/agent eval:precheck && \
bun -e "import { runAgent } from './packages/agent/src/eval/run-function.ts'; const r = await runAgent({query: 'What is the cluster status?'}); console.log('targetDataSources:', r.output.targetDataSources); console.log('response (first 200):', r.output.response.slice(0, 200));"
```

Expected (after ~30-60s of agent execution against Bedrock):
- `targetDataSources` is an array of strings
- `response` is a non-empty string

If the precheck fails, fix the missing MCP servers first.

If `runAgent` crashes, the most likely causes are:
1. AWS Bedrock creds not loaded — confirm `.env` has `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`.
2. `buildGraph` failed because `agents/incident-analyzer/` couldn't load — run `bun test packages/gitagent-bridge/src/index.test.ts` to confirm the agent loads.
3. An MCP server returned an error — the agent should still produce a degraded response, but check the logs.

- [ ] **Step 5: Smoke-test the deterministic evaluators against synthetic outputs**

```bash
bun -e "
import { datasourcesCovered, confidenceThreshold } from './packages/agent/src/eval/evaluators.ts';
const example = { outputs: { expectedDatasources: ['kafka', 'elastic'], minConfidence: 0.6 } };
const goodRun = { outputs: { output: { targetDataSources: ['kafka', 'elastic', 'gitlab'], confidenceCap: undefined } } };
const badRun = { outputs: { output: { targetDataSources: ['kafka'], confidenceCap: 0.4 } } };
console.log('good datasources:', JSON.stringify(datasourcesCovered(goodRun, example)));
console.log('bad datasources:', JSON.stringify(datasourcesCovered(badRun, example)));
console.log('good confidence:', JSON.stringify(confidenceThreshold(goodRun, example)));
console.log('bad confidence:', JSON.stringify(confidenceThreshold(badRun, example)));
"
```

Expected:
- `good datasources`: `score: 1`, comment mentions "All 2 expected datasources covered"
- `bad datasources`: `score: 0`, comment "Missing: elastic"
- `good confidence`: `score: 1`, comment "No confidence cap set (rules satisfied)"
- `bad confidence`: `score: 0`, comment "Confidence capped at 0.4 (min 0.6)"

If any of the four lines doesn't match, fix the evaluator before proceeding. The judge isn't tested here because it requires an OpenAI call ($).

- [ ] **Step 6: Run typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS. The cast acrobatics in evaluators.ts may produce a Biome warning about complex generics — confirm there's no `noExplicitAny` violation. If lint flags one, replace the `unknown` cast chain with a `// biome-ignore lint/suspicious/noExplicitAny: SIO-680/682 - LangSmith Run/Example.outputs are loosely typed` per the CLAUDE.md convention.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/eval/run-function.ts packages/agent/src/eval/evaluators.ts \
        packages/agent/package.json bun.lock
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: run-function + 3 evaluators for the agent eval pipeline

run-function.ts: runAgent({query}) builds the LangGraph once
(cached in module scope), invokes it with a memory checkpointer,
and returns {response, targetDataSources, confidenceCap} for the
evaluators to read.

evaluators.ts: 3 separate functions per the langsmith-evaluator
skill's "one metric per evaluator" rule:
  - datasourcesCovered (code, deterministic)
  - confidenceThreshold (code, deterministic; reads SIO-681's
    confidenceCap state field; default min 0.6)
  - responseQualityJudge (gpt-4o-mini, temperature: 0, structured
    output JSON with {meets_rubric, reasoning})

Each returns {key, score, comment} per the skill's TS local-evaluator
convention -- the `key` field gives the result column a meaningful
name in the LangSmith UI.

Adds `openai` and `langsmith` to packages/agent/package.json (langsmith
was in the workspace catalog but not pulled into the agent package's
node_modules until now).

Entry-point and README land in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Entry-point + README + workspace script

The user-facing wiring: the `run-eval.ts` entry point that ties precheck + dataset + run-function + evaluators together, the root `bun run eval:agent` script, and the README documenting cost / time / interpretation.

**Files:**
- Create: `packages/agent/src/eval/run-eval.ts`
- Create: `packages/agent/src/eval/README.md`
- Modify: `package.json` (workspace root — add `eval:agent` script)
- Modify: `packages/agent/package.json` (add `eval:run` script)

- [ ] **Step 1: Create the entry point**

Create `packages/agent/src/eval/run-eval.ts`:

```typescript
// packages/agent/src/eval/run-eval.ts
import { spawnSync } from "node:child_process";
import { evaluate } from "langsmith/evaluation";
import { runAgent } from "./run-function.ts";
import { confidenceThreshold, datasourcesCovered, responseQualityJudge } from "./evaluators.ts";

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

const results = await evaluate(runAgent, {
	data: "devops-incident-eval",
	evaluators: [datasourcesCovered, confidenceThreshold, responseQualityJudge],
	experimentPrefix,
});

console.log("Done. View results in LangSmith UI under the experiment prefix above.");
console.log(results);
```

The 5-second pause before precheck gives a human Ctrl-C window if the eval is started by mistake. The `experimentPrefix` is git-sha-tagged so each run is comparable to a specific code state in LangSmith's UI.

- [ ] **Step 2: Add the `eval:run` script in the agent package**

Open `packages/agent/package.json`. Update the `"scripts"` object to:

```json
	"scripts": {
		"test": "bun test",
		"typecheck": "bunx tsc --noEmit",
		"eval:precheck": "bun run src/eval/precheck.ts",
		"eval:upload-dataset": "bun run src/eval/build-dataset.ts",
		"eval:run": "bun run src/eval/run-eval.ts"
	},
```

- [ ] **Step 3: Add the `eval:agent` script at the workspace root**

Open `package.json` (the workspace root). Find the `"scripts"` block and add `"eval:agent"` between `"yaml:check"` and `"fallow:check"`:

```json
		"yaml:check": "yamllint -c .yamllint.yml agents/",
		"eval:agent": "bun run --filter @devops-agent/agent eval:run",
		"fallow:check": "npx -y fallow",
```

The 2-hop delegation (`eval:agent` → `eval:run` via `--filter`) matches the existing repo pattern for `dev` and `test`.

- [ ] **Step 4: Create the README**

Create `packages/agent/src/eval/README.md`:

```markdown
# Agent eval (final_response, LangSmith)

End-to-end regression for the full 13-node incident-analysis graph. 5 realistic
incident queries × 3 evaluators.

## Cost & time

- ~$0.50-1.50 per full run (5 queries × ~$0.10-0.30 each = Bedrock; ~$0.005 each = gpt-4o-mini judge)
- ~5-10 minutes wall-clock (~30-90s per query)

## Prerequisites

- All 6 MCP servers reachable on :9080-:9085 (precheck blocks the run otherwise)
- AWS Bedrock creds in .env (existing setup)
- OPENAI_API_KEY in .env (for the response-quality judge)
- LANGSMITH_API_KEY + LANGSMITH_PROJECT in .env (existing setup)
- `langsmith` CLI on PATH (used by `eval:upload-dataset` only):
  `curl -sSL https://raw.githubusercontent.com/langchain-ai/langsmith-cli/main/scripts/install.sh | sh`

## Run

```bash
# 1. Sanity-check infra (free, fast)
bun run --filter @devops-agent/agent eval:precheck

# 2. Upload (or update) the dataset to LangSmith (free, fast, one-shot per dataset change)
bun run --filter @devops-agent/agent eval:upload-dataset

# 3. Run the eval (~$0.50-1.50, ~5-10min)
bun run eval:agent
```

## What each evaluator measures

- `datasources_covered` — code: response targeted every datasource the rubric expects (1/0)
- `confidence_threshold` — code: final confidence ≥ 0.6 (1/0; the SIO-681 cap)
- `response_quality` — gpt-4o-mini judge: response meets the per-query rubric (1/0)

## Adding a new query

1. Add an entry to `dataset.ts` (TS source of truth)
2. `bun run --filter @devops-agent/agent eval:upload-dataset`
3. `bun run eval:agent`

The LangSmith experiment is named `agent-eval-<git-sha>`, so each run is
comparable in the UI under "Experiments" for the `devops-incident-eval` dataset.

## Interpreting results

- Score = 1 means PASS for that evaluator; 0 = FAIL with reason in `comment`
- Per-example breakdowns visible in the LangSmith UI
- Trend across commits: filter the experiment list by experiment-prefix pattern
```

- [ ] **Step 5: Verify the entry script wires up correctly (without invoking the LLM)**

Test that the script loads without error:

```bash
bun -e "import './packages/agent/src/eval/run-eval.ts'" 2>&1 | head -5
```

This will start the 5-second pause and then invoke the precheck. Ctrl-C immediately after seeing the WARNING line. The point is to verify imports resolve and the file is syntactically valid; we don't want to run the full eval here.

Expected: prints WARNING and "Estimated cost..." lines, then waits. Ctrl-C exits cleanly.

If imports fail (`Cannot find module 'langsmith/evaluation'` etc.), confirm Task 3 Step 1 added both deps and `bun.lock` was committed.

- [ ] **Step 6: Run typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/eval/run-eval.ts packages/agent/src/eval/README.md \
        packages/agent/package.json package.json
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: agent eval entry point + README + workspace script

run-eval.ts ties precheck + dataset + run-function + evaluators
together. 5-second WARNING pause before precheck so a misclick
doesn't burn $0.50-1.50. Experiment prefix is git-sha-tagged for
LangSmith UI comparability across commits.

Workspace root gets `bun run eval:agent` (delegates to the agent
package's `eval:run`). Matches the existing 2-hop pattern used by
`dev` and `test`.

README documents cost ($0.50-1.50/run), time (5-10min), env-var
prerequisites including OPENAI_API_KEY and the `langsmith` CLI,
the meaning of each evaluator score, and how to add a new query.

This commit completes the eval pipeline (4 of 4 in this work
stream). Run end-to-end: `bun run --filter @devops-agent/agent
eval:upload-dataset && bun run eval:agent`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Final cross-check before push

- [ ] **Step 1: Re-run the full validation sweep**

```bash
bun run typecheck && bun run lint && bun run yaml:check && bun test packages/gitagent-bridge/
```

Expected: PASS on all four. Pre-existing 142+5=147 passing in gitagent-bridge from the prior work; nothing in this work touches that suite.

- [ ] **Step 2: Inspect the four implementation commits**

```bash
git log origin/main..HEAD --stat
```

Expected: 5 commits — the spec/plan from earlier (`f9ab445`, this plan) plus the 4 implementation commits from Tasks 1-4. Total ~370 lines added across 7 new files + 2 package.json updates + bun.lock.

- [ ] **Step 3: Live precheck against the current local env**

```bash
bun run --filter @devops-agent/agent eval:precheck
```

If all 6 MCP servers happen to be running locally: prints `All 6 MCP servers reachable`. If not: lists missing servers with the start commands. Either is acceptable for verifying the script works.

- [ ] **Step 4: Push (await user authorization)**

The user must explicitly authorize `git push`. When authorized:

```bash
git push origin main
```

---

## Verification (manual smoke after merge)

Documented for the human reviewer to run at their convenience — these are not part of the implementation:

1. **End-to-end first run**: ensure all 6 MCP servers are running (the precheck script will tell you which to start). Then:
   ```bash
   bun run --filter @devops-agent/agent eval:upload-dataset
   bun run eval:agent
   ```
   Expect 5 queries × 3 evaluators = 15 grade points to land in LangSmith. Browse the experiment in the LangSmith UI under `devops-incident-eval`.

2. **Re-run after a description tweak**: change a description in any tool YAML, re-run `eval:agent` (no need to re-upload dataset). Compare experiment-prefix-tagged runs in LangSmith to see whether the change moved any score.

3. **Add a 6th query**: add an entry to `dataset.ts`, run `eval:upload-dataset` (CLI prompts to overwrite), then `eval:agent`. Confirm the new query appears in LangSmith's example list.

## Out of scope

- Trajectory eval (separate dataset type, follow-up).
- More evaluators (groundedness, citation accuracy, "no `X not queried` gaps").
- More queries (start at 5, extend in a follow-up).
- CI integration.
- Auto-uploading evaluators (kept local; the LLM judge needs `openai` which the LangSmith sandbox doesn't allow).
- Pushing to remote — last step requires explicit user authorization per repo guardrails.
