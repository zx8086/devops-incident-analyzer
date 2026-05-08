# Spec: LangSmith final_response eval for the full agent

**Date:** 2026-05-09
**Tickets:** new work; will need a Linear issue per CLAUDE.md ("All approved plans MUST have a Linear issue before implementation begins") — flagged in §"Out of scope" since this spec is the planning artifact, not the implementation.

## Context

The throwaway smoke we ran (`packages/agent/src/smoke-action-descriptions.ts`, removed after each use) verified action selection for the description work and gave us 5/5 PASS after the SIO-680/682 cross-reference fix. The user wants this capability as a permanent dev artifact — not a one-off script.

The langsmith-evaluator skill describes a formal pipeline: dataset (final_response, single_step, trajectory, or RAG) + run function + evaluators. Per user direction:
- **Identity:** LangSmith eval dataset (formal), not manual dev tool, not CI gate.
- **Type:** `final_response` — runs the full 13-node graph, not just `extractEntities`.
- **MCP strategy:** local; precheck fails fast if any of the 6 servers (9080-9085) aren't reachable.
- **Queries:** I draft 5 realistic incident queries; user reviewed in this spec.
- **Evaluators (3 in v1):** datasourcesCovered (code), confidenceThreshold (code), responseQualityJudge (LLM-as-Judge gpt-4o-mini).
- **Skipped from v1:** "no `X not queried` gaps" evaluator (implicit in the other two).

This is a meaningful scope expansion vs the throwaway smoke: instead of testing one node deterministically, we exercise the full agent through Bedrock at ~$0.10-0.30 per query, and the response is judged for incident-analysis quality.

## Goal

Build a permanent LangSmith eval pipeline for end-to-end agent regression. On-demand local execution. First-class artifact for description-quality work, agent-graph changes, and future MCP/sub-agent additions.

## Decisions (locked via brainstorming)

1. **Identity:** LangSmith eval dataset.
2. **Dataset type:** `final_response`.
3. **MCP servers:** local; precheck blocks the run if any port 9080-9085 isn't reachable.
4. **Queries:** 5 realistic incident-shaped queries (start at the floor of the 5-8 range; extend in a follow-up).
5. **Evaluators:** 3 in v1 (2 code + 1 LLM-judge).
6. **Local evaluators:** all 3 passed locally to `evaluate(evaluators=[...])`. The judge needs the `openai` package which isn't available in LangSmith's sandboxed upload runtime; the skill recommends local evaluators in this case anyway.
7. **No CI:** explicit out-of-scope per question 1.

## Detailed design

### File layout

```
packages/agent/src/eval/
  README.md                       # how to run, costs, time, LangSmith experiment naming
  dataset.ts                      # 5 incident queries with expected outputs (TS source of truth)
  build-dataset.ts                # serialize dataset.ts -> /tmp/devops-incident-eval.json + upload via langsmith CLI
  precheck.ts                     # probe :9080-:9085, fail fast with start commands
  run-function.ts                 # runAgent({query}) -> {output: {response, targetDataSources, confidenceCap}}
  evaluators.ts                   # 3 functions: datasourcesCovered, confidenceThreshold, responseQualityJudge
  run-eval.ts                     # entry point: precheck -> evaluate(runAgent, {data, evaluators})
```

`packages/agent/src/eval/` is chosen because it sits next to the production code it tests — same module-resolution scope as the smoke script proved out (no `@langchain` resolution issues since the agent package owns those deps).

### `package.json` wiring

Workspace root `package.json` gets one new script:
```json
"eval:agent": "bun run --filter @devops-agent/agent eval:run"
```

`packages/agent/package.json` gets three:
```json
"eval:precheck": "bun run src/eval/precheck.ts",
"eval:upload-dataset": "bun run src/eval/build-dataset.ts",
"eval:run": "bun run src/eval/run-eval.ts"
```

### `dataset.ts` — TS source of truth

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
      query: "Consumer group payments-ingest on c72-shared-services-msk has been stuck at 50k lag for 30 minutes; users are seeing stale order status. Diagnose.",
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
      query: "Kong /v1/users route is returning 5xx for 15% of requests since 14:00 UTC. Which plugin chain or upstream change broke it?",
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
      query: "Couchbase queries on bucket orders-prod are timing out for the last hour. Slow queries or fatal errors?",
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
      query: "We had a P1 yesterday at 03:00 UTC affecting checkout. Show me the runbook we used and any related Jira tickets.",
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

Five queries:
- 3 multi-datasource incident triages (kafka+elastic+couchbase, konnect+elastic+gitlab, couchbase+elastic)
- 1 single-datasource cost reporting (elastic billing)
- 1 multi-datasource post-mortem lookup (atlassian+gitlab)

This shape covers: cross-agent correlation (SIO-681), description disambiguation (SIO-680/682), cost-vs-deployment distinction (the cross-ref fix at `3dd029a`), atlassian smart-composer actions (`runbook_lookup` vs direct `confluence_query`).

### `precheck.ts`

```typescript
// packages/agent/src/eval/precheck.ts
const PORTS = [9080, 9081, 9082, 9083, 9084, 9085] as const;
const NAMES = ["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian"] as const;

const failures: string[] = [];

for (let i = 0; i < PORTS.length; i++) {
  const port = PORTS[i];
  const name = NAMES[i];
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      failures.push(`MCP server '${name}' (:${port}) returned ${res.status}; start it: bun run --filter @devops-agent/mcp-server-${name} dev`);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    failures.push(`MCP server '${name}' (:${port}) unreachable (${reason}); start it: bun run --filter @devops-agent/mcp-server-${name} dev`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}

console.log("All 6 MCP servers reachable");
```

Lives at `packages/agent/src/eval/precheck.ts`. Called by `run-eval.ts` before any LLM calls so a misconfigured env never burns Bedrock cost.

### `run-function.ts`

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
  const responseText = typeof lastMessage?.content === "string"
    ? lastMessage.content
    : JSON.stringify(lastMessage?.content ?? "");
  return {
    output: {
      response: responseText,
      targetDataSources: finalState.targetDataSources ?? [],
      confidenceCap: finalState.confidenceCap,
    },
  };
}
```

The graph is built once and cached across queries (5x speedup vs rebuild-per-query). `memory` checkpointer because each eval thread is isolated.

### `evaluators.ts`

```typescript
// packages/agent/src/eval/evaluators.ts
import OpenAI from "openai";
import type { Run, Example } from "langsmith/schemas";

export function datasourcesCovered(run: Run, example: Example) {
  const expected = new Set<string>(example.outputs?.expectedDatasources ?? []);
  const actual = new Set<string>(run.outputs?.output?.targetDataSources ?? []);
  const missing = [...expected].filter((d) => !actual.has(d));
  return {
    key: "datasources_covered",
    score: missing.length === 0 ? 1 : 0,
    comment: missing.length === 0
      ? `All ${expected.size} expected datasources covered`
      : `Missing: ${missing.join(", ")}`,
  };
}

export function confidenceThreshold(run: Run, example: Example) {
  const cap = run.outputs?.output?.confidenceCap as number | undefined;
  const min = (example.outputs?.minConfidence as number | undefined) ?? 0.6;
  const ok = cap === undefined || cap >= min;
  return {
    key: "confidence_threshold",
    score: ok ? 1 : 0,
    comment: cap === undefined
      ? "No confidence cap set (rules satisfied)"
      : `Confidence capped at ${cap} (min ${min})`,
  };
}

const openai = new OpenAI();

export async function responseQualityJudge(run: Run, example: Example) {
  const rubric = example.outputs?.qualityRubric as string | undefined;
  const response = run.outputs?.output?.response as string | undefined;
  if (!rubric || !response) {
    return {
      key: "response_quality",
      score: 0,
      comment: "missing rubric or response",
    };
  }
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: 'Respond with JSON: {"meets_rubric": boolean, "reasoning": string}',
      },
      {
        role: "user",
        content: `Rubric: ${rubric}\n\nResponse to grade:\n${response}\n\nDoes the response meet the rubric?`,
      },
    ],
  });
  const grade = JSON.parse(r.choices[0]?.message?.content ?? '{"meets_rubric":false,"reasoning":"empty response"}');
  return {
    key: "response_quality",
    score: grade.meets_rubric ? 1 : 0,
    comment: String(grade.reasoning ?? ""),
  };
}
```

All three return TypeScript-style `{key, score, comment}` per the langsmith-evaluator skill's TS conventions for local evaluators (`key` is required for the column name; the skill warns against including it for uploaded evaluators, but these stay local).

### `build-dataset.ts`

```typescript
// packages/agent/src/eval/build-dataset.ts
import { DATASET } from "./dataset.ts";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TARGET = "/tmp/devops-incident-eval.json";
const DATASET_NAME = "devops-incident-eval";

writeFileSync(TARGET, JSON.stringify(DATASET, null, 2));
console.log(`Wrote ${DATASET.length} examples to ${TARGET}`);

const result = spawnSync(
  "langsmith",
  ["dataset", "upload", TARGET, "--name", DATASET_NAME],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  console.error(`langsmith dataset upload failed (exit ${result.status})`);
  console.error(`If the dataset already exists, delete it first: langsmith dataset delete ${DATASET_NAME}`);
  process.exit(result.status ?? 1);
}
```

Idempotent: re-running overwrites `/tmp/devops-incident-eval.json` and re-uploads. The CLI prompts before overwriting an existing dataset (per the langsmith-dataset skill: "NEVER use --yes unless the user explicitly requests it").

### `run-eval.ts`

```typescript
// packages/agent/src/eval/run-eval.ts
import { evaluate } from "langsmith/evaluation";
import { runAgent } from "./run-function.ts";
import { datasourcesCovered, confidenceThreshold, responseQualityJudge } from "./evaluators.ts";
import { spawnSync } from "node:child_process";

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

Fixed 5-second pause before the run gives a Ctrl-C window. `experimentPrefix` is git-sha-tagged so each run is comparable to a specific code state in LangSmith's UI.

### `README.md`

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

### Out of scope

- **Linear issue:** This spec is a planning artifact. Per CLAUDE.md, an actual implementation plan must have a Linear issue created before implementation begins. Either skip if treated as a doc/eval-infra sync (memory rule allows reusing originating tickets — this would chain to SIO-680/682 since it tests them), OR create a new SIO-NNN if treated as net-new functionality. **Decision flagged for the user when the plan is requested.**
- **Trajectory capture** — the langsmith-evaluator skill describes capturing tool-call sequences from LangGraph; the run function in v1 just returns final state. Trajectory eval is a follow-up.
- **CI integration** — explicitly user-rejected.
- **Dataset versioning** — relies on LangSmith's implicit timestamping per upload.
- **More evaluators** — the "no `X not queried` gaps" check, groundedness, citation accuracy. Follow-up.
- **Comparison/diff tools** — LangSmith UI provides this natively.
- **More queries (6-8)** — start at 5 per user direction; extend in a follow-up.
- **Auto-uploading evaluators** — keep them local; the LLM judge needs the openai package which the LangSmith sandbox doesn't allow.

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| Quality judge is non-deterministic | `temperature: 0` + structured output. Score 0/1 only — judge is a tripwire, not a continuous metric. Manual review of failed runs in LangSmith UI. |
| Eval cost ($0.50-1.50/run) discourages frequent runs | README is explicit; user runs on-demand around description / agent-graph changes. |
| MCP servers may return real prod data | `.env` already has prod creds. `run-eval.ts` prints a banner with a 5s pause to abort. |
| Bedrock model nondeterminism causes spurious deterministic-eval failures | The two code evaluators read structured state (`targetDataSources`, `confidenceCap`), not LLM text — should be stable. Only the judge can flake. |
| Dataset drift: adding actions to a YAML invalidates `expectedDatasources` | `dataset.ts` is TS source of truth; type-checked. `build-dataset.ts` is the only path that touches LangSmith. |
| `langsmith` CLI not on PATH | Documented in README prerequisites; `build-dataset.ts` errors clearly if `spawnSync` returns ENOENT. |
| Graph build is slow per-query | `runAgent()` caches the compiled graph in module scope; ~5x speedup over rebuild-per-query for 5 queries. |
| `openai` package not yet in agent's package.json | Implementation plan must add `"openai": "^4.x"` to `packages/agent/package.json` dependencies. |

## Verification

```bash
# Each step in order; abort on first failure

# 1. Precheck (free, ~2s, no LLM)
bun run --filter @devops-agent/agent eval:precheck

# 2. Build + upload dataset (free, ~5s, one network call to LangSmith)
bun run --filter @devops-agent/agent eval:upload-dataset

# 3. Confirm dataset in LangSmith (free)
langsmith dataset get devops-incident-eval
langsmith example list --dataset devops-incident-eval

# 4. Full eval run (~$0.50-1.50, ~5-10min)
bun run eval:agent

# 5. Inspect in LangSmith UI under experiment "agent-eval-<git-sha>"
```

## Commit shape

The implementation plan will likely split into multiple commits because of the 7-file scope:

1. `precheck.ts` + the new `eval:precheck` script (smallest, runnable on its own)
2. `dataset.ts` + `build-dataset.ts` + `eval:upload-dataset` script
3. `run-function.ts` + `evaluators.ts` + add `openai` to package.json
4. `run-eval.ts` + `eval:agent` script + README

Or could be one bulk commit if the user prefers. Plan-writing decision.

Commit prefix: `SIO-NNN:` if a new Linear issue is created, OR `SIO-680,SIO-682:` if treated as continuation of the description work it tests (memory rule for doc/eval-infra syncs).
