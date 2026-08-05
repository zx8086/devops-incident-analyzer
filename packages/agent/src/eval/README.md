# Agent eval (final_response, LangSmith)

End-to-end regression for the full 13-node incident-analysis graph. 5 realistic
incident queries × 3 evaluators.

## Incident-replay eval (SIO-1371/1372/1374/1378)

The second, larger eval in this directory: an A/B harness comparing sub-agent models on 32
real historical incidents from Jira epic DEVOPS-1354, judged against each ticket's own
human-curated report (`referenceReport`) and per-datasource findings (`referenceFindings`).

```bash
bun run eval:precheck                                               # gate: MCP servers reachable
bun run eval:upload-incident-replay-dataset                         # SDK sync, dataset id preserved
bun run eval:incident-replay -- --sub-agent-model claude-haiku-4-5 --repetitions 2
```

- Dataset: `incident-replay-dataset.ts` (TS source of truth) -> LangSmith dataset
  `incident-replay-eval`. Each example carries metadata (`ticketKey`, `queryProvenance`
  verbatim|verbatim-adjacent|reconstructed, `era`) so runs are filterable in the LangSmith UI.
- `--sub-agent-model` changes ONLY the 7 sub-agents (via `EVAL_SUB_AGENT_MODEL_OVERRIDE`); the
  root orchestrator/aggregator always resolves from its own manifest.
- `--repetitions N` maps to the SDK's `numRepetitions`. n=32 single-shot runs sit inside
  judge/model noise (the SIO-1375 A/B conclusion flipped on a config bug); use >= 2 for any
  model decision.
- `EVAL_JUDGE_MODEL` overrides the LLM judge (default `gpt-4o-mini`). Scores are only
  comparable within one judge model -- the resolved judge is stamped on experiment metadata.

### Feedback keys

- `response_quality` -- holistic 1-10 (normalized 0-1), root-cause-capped in code (SIO-1372)
- `root_cause_accuracy` -- 1 / 0.5 / 0; omitted when not determinable
- `evidence_<datasource>` -- per-datasource verdicts from the holistic judge (SIO-1374)
- `subagent_accuracy_<datasource>` -- independent judge over raw serialized sub-agent findings,
  isolating the sub-agent model from the aggregator (SIO-1374)
- `datasources_covered`, `confidence_threshold` -- deterministic code checks

Judge-emitted datasource names are canonicalized (`elasticsearch`->`elastic`,
`capella`->`couchbase`, ...) before feedback emission (SIO-1378): previously a free-formed name
was silently dropped by the ground-truth filter and the example lost that datasource's score.

### Live replay, frozen ground truth -- and why tool-level replay is deliberately absent

Replays run the production graph against LIVE MCP servers while reference reports stay frozen
at their curation era (2026-06). Live drift is expected; the judge's recurrence-window
exemption keeps truthful current observations from being graded as fabrication.

Deterministic tool-level replay (recording MCP results once and serving them in later runs)
was evaluated and REJECTED: the A/B varies sub-agent models, different models issue different
tool calls, and replaying model A's recorded results to model B would grade B on canned
answers to questions it never asked. What IS frozen instead (SIO-1379, the sound-freeze
layer): each run's final outputs (so judge/harness iteration replays frozen agent behavior)
and a per-call MCP audit trail (so score disputes are resolvable from data). Time anchoring
of queries is deferred until a fresh, in-retention incident joins the dataset -- the June 2026
evidence is already past retention for elastic/kafka/couchbase; only gitlab/atlassian remain
durable.

## Cost & time

- ~$0.50-1.50 per full run (5 queries × ~$0.10-0.30 each = Bedrock; ~$0.005 each = gpt-4o-mini judge)
- ~5-10 minutes wall-clock (~30-90s per query)

## Also in this directory: the model-conformance probe

`probe-model.ts` (SIO-1224) verifies a MODEL's capability assumptions rather than the graph's
answer quality. It lives here because it is the other money-spending `bun run` script in the
repo and shares the same cost-banner idiom.

- ~$0.50-2.00 and ~3-5 minutes **per model**; `--agent` also probes the manifest's fallbacks
- Needs only Bedrock creds -- no MCP servers, no LangSmith, no OpenAI key
- Deliberately NOT a `*.test.ts`: CI runs `bun test` per package and would bill Bedrock per PR

```bash
bun run model:probe -- claude-sonnet-5 --agent incident-analyzer --report
```

It is gate 1 of `docs/development/model-upgrade-checklist.md`; committed output lands in
`docs/reference/model-probes/`.

## Prerequisites

- MCP servers reachable: elastic/kafka/couchbase/gitlab/atlassian on :9080-:9085 (konnect
  optional -- intentionally disabled in this dev environment) and the AWS SigV4 proxy on :3001
  (precheck blocks the run otherwise; SIO-1376 made AWS a required probe)
- AWS Bedrock creds in .env (existing setup)
- OPENAI_API_KEY in .env (for the LLM judges; model via EVAL_JUDGE_MODEL, default gpt-4o-mini)
- LANGSMITH_API_KEY + LANGSMITH_PROJECT in .env (existing setup)
- `langsmith` CLI on PATH (used by the synthetic `eval:upload-dataset` only; the
  incident-replay upload uses the SDK):
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
