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
