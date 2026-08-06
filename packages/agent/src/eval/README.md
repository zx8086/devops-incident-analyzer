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

Replays run the production graph against LIVE MCP servers while each entry's reference
report/findings stay frozen at that entry's own `metadata.era` (2026-06 for 12 entries,
2026-07 for 20). Live drift is expected -- and era-dependent: June evidence is already past
retention for elastic (~30d hot), kafka (broker retention/transient state), and
couchbase/konnect (current-state-only tools); July evidence is partially inside elastic's
window and CloudWatch's ~60d but expiring. Only gitlab/atlassian (MRs, deploys, tickets)
remain durable for both eras. The judge's recurrence-window exemption keeps truthful current
observations from being graded as fabrication.

Deterministic tool-level replay (recording MCP results once and serving them in later runs)
was evaluated and REJECTED: the A/B varies sub-agent models, different models issue different
tool calls, and replaying model A's recorded results to model B would grade B on canned
answers to questions it never asked. What IS frozen instead (SIO-1379, the sound-freeze
layer): each run's final outputs (so judge/harness iteration replays frozen agent behavior)
and a per-call MCP audit trail (so score disputes are resolvable from data). Time anchoring
of queries is deferred until a fresh, in-retention incident joins the dataset (see the
retention picture above).

### Cost & time (incident replay)

- 32 examples per repetition per leg; ~$0.50-1.50 and ~5-10min PER repetition (Bedrock +
  gpt-4o-mini judge) -- scale by `--repetitions` and by the number of A/B legs
- `EVAL_FIXTURE_MODE=replay-outputs` re-grades a recorded leg for judge cost only (pennies,
  minutes; no Bedrock/MCP)

## Cost & time (synthetic eval)

- ~$0.50-1.50 per full run (5 queries × ~$0.10-0.30 each = Bedrock; ~$0.005 each = gpt-4o-mini judge)
- ~5-10 minutes wall-clock (~30-90s per query)
- Incident-replay cost is documented in its own section above

## MCP tool eval (SIO-1398)

The third eval in this directory, and the only one that grades the TOOL CALL rather than the
report. Both evals above read `run.outputs.output.response`; nothing looked at what the agent
actually called, so "the LLM called the tool wrong" was structurally ungradeable.

```bash
bun run --filter @devops-agent/agent eval:upload-mcp-tool-dataset   # SDK sync, dataset id preserved
bun run eval:mcp-tool -- --datasource elastic                       # one server
bun run eval:mcp-tool                                               # all 7
```

> Running from a **git worktree**: every script here uses `--env-file=../../.env`, which resolves
> inside the worktree, where no `.env` exists (it lives in the main checkout). Symptom is a
> LangSmith `401` or missing MCP URLs, not an obvious "file not found". Point at the real file:
> `bun --env-file=/path/to/main/checkout/.env run src/eval/run-mcp-tool-eval.ts --datasource elastic`.

- Dataset: `mcp-tool-dataset.ts` -> LangSmith dataset `mcp-tool-eval`. 25 examples across all
  7 datasources.
- **Separate from `incident-replay-eval` on purpose.** That one is a model A/B harness
  (`--sub-agent-model`); its variable under test is the model. This one tests the tooling and
  should run on every MCP server change, independent of any model comparison. It also covers
  each server systematically rather than "whatever tools those 32 incidents happened to touch".
- Every example **pins one datasource**, so a run fans out to a single sub-agent and any
  failure is attributable to that server. Queries force a specific action group from that
  datasource's `action_tool_map`, anchored on an entity that returns rows today
  (`LIVE_ANCHORS`, verified against the live `.env`, not `.env.example`).
- **An example returning zero tool calls is never a healthy pass** -- it can mean a wrong anchor or query, but equally a binder regression, a skipped sub-agent, or an execution failure, not that the
  tools are healthy. The evaluators emit no feedback at `totalCalls === 0` rather than scoring
  a perfect 1.0 -- otherwise a run where the sub-agent was skipped would look like a clean pass.
- konnect is included but intentionally disabled in this environment (`precheck.ts` marks it
  `required: false`), so its example reports zero calls until konnect is enabled.

### Feedback keys

Convention: **1.0 = good on every key**, so rate metrics emit `1 - rate` and Compare reads
uniformly beside `response_quality`.

- `tool_arg_validity` -- deterministic: share of calls whose arguments the server accepted.
  Reads `bad-input` at the KIND layer deliberately, because it collapses to category `unknown`
  (SIO-1399), so reading only the category would miss every `-32602` the model caused.
- `tool_name_validity` -- deterministic: share of calls naming a bound tool. Splits a
  model-invented name out of category `not-found`, which otherwise conflates it with a
  genuinely absent resource.
- `expected_tools_fired` -- deterministic: partial credit over `anyOf` groups. A forbidden call
  (e.g. a write tool on a read-only question) zeroes the key.
- `tool_response_health` -- deterministic: prose-only errors (no `{ _error }` envelope),
  suspicious emptiness against a declared anchor, and known-bug regressions (`latency_us`
  nanoseconds-as-microseconds, AWS year-shift windows).
- `tool_efficiency` -- deterministic, **soft comparative signal only, gate nothing on it**.
  Args are not observable, so a paginated sweep reads as a repeat.
- `tool_data_utilization` -- LLM judge (1 / 0.5 / 0): tools returned data, did the report use
  it? Catches the silent drop that `evidence_<ds>` and `subagent_accuracy_<ds>` miss, since
  both grade what was FOUND rather than whether it reached the answer.

### First full sweep (2026-08-06, all 7 datasources)

11 examples, 118 tool calls. Per-datasource averages:

| datasource | arg_validity | name_validity | expected_fired | response_health | utilization | efficiency |
|---|---|---|---|---|---|---|
| elastic | **0.75** / 1 / 1 | 1 | 1 | 1 | 1 | 0.125 / 0.5 / 0.5 |
| kafka | 1, 1 | 1, 1 | 1, 1 | 1, 1 | 1, 1 | 0.5 / 0.19 |
| couchbase | 1 | 1 | 1 | 1 | 1 | 0.5 |
| gitlab | 1 | 1 | 1 | 1 | 1 | 0.3 |
| atlassian | 1 | 1 | 1 | 1 | 1 | 0.17 |
| aws | 1, 1 | 1, 1 | 1, 1 | 1, 1 | 1, 1 | 0.087 / 0.5 |
| konnect | *(no feedback)* | *(no feedback)* | **0** | *(no feedback)* | *(no feedback)* | *(no feedback)* |

Three things this sweep established:

1. **`tool_arg_validity` 0.75 on elastic** -- `2/8 call(s) rejected for bad arguments:
   elasticsearch_search`. The reported "LLM calls tools incorrectly" behaviour reproducing as a
   score with the offending tool named, on the argument-heavy `search` group exactly where the
   dataset comment predicted it. Every other datasource was clean, so the signal is specific,
   not noise.
2. **gitlab surfaced a real environment defect** (SIO-1401): 4/10 calls returned HTTP 404
   `Project Not Found` against `GITLAB_DEFAULT_PROJECT_ID`, reproduced independently with a raw
   `curl` against `:9084`. `tool_arg_validity` correctly stayed 1.0 -- a 404 is not a malformed
   argument -- which is the evaluator separation working as designed.
3. **konnect (disabled) emitted NO feedback on the five call-based keys** rather than a false
   1.0, and `expected_tools_fired` correctly reported `0/1 required tool group(s) fired`. The
   "zero calls is a visible signal, not silent absence" contract holds.

### Latest full run (`mcp-tool-eval-ddb9b17b`, 25 examples, all 7 datasources)

Every correctness key clean, and **zero tool errors across the whole run**.

| key | avg | previous |
|---|---|---|
| `tool_arg_validity` | **1.000** | 0.988 |
| `tool_name_validity` | **1.000** | 1.000 |
| `tool_response_health` | **1.000** | 0.917 |
| `tool_data_utilization` | **1.000** | 1.000 |
| `datasources_covered` | **1.000** | 1.000 |
| `expected_tools_fired` | 0.972 | 0.933 |
| `confidence_threshold` | 0.960 | 0.960 |
| `tool_efficiency` | 0.419 (soft) | 0.396 |

Two fixes closed the gaps the previous run exposed:

- `tool_arg_validity` 0.988 -> 1.000. The previous run recorded **10 rejected
  `gitlab_orbit_query_graph` calls out of 10 attempts**, because `query` was a bare `z.record`
  (`additionalProperties: {}` -- any object passes JSON-Schema, so the model got no structural
  signal and only learned it was wrong from Orbit's validator, after the billed call). SIO-1408
  typed the DSL skeleton and put a worked payload in the description.
- `tool_response_health` 0.917 -> 1.000. The two findings were false positives from anchors on
  FILTERABLE list tools -- see the anchor rule below.

### The anchor rule (learned twice, now enforced by a test)

A `knownGoodAnchor` asserts "this tool MUST return rows". That only holds for tools whose
result **cannot be narrowed by a model-chosen filter**. `gitlab_list_merge_requests` produced a
false `empty-anchor` twice -- the model reasonably added `updated_after`, and the project's MRs
fell outside that window, so `{project_id}` returns rows while `{project_id, updated_after}`
returns `[]`.

Anchors removed for the same reason: `kafka_list_consumer_groups` (`filter`/`states`),
`kafka_list_topics` (`filter`/`prefix`), `elasticsearch_list_indices` (`indexPattern`).

Anchors kept are keyed on an **exact identifier** (`gitlab_get_commit_diff` by sha,
`gitlab_get_merge_request` by iid, `gitlab_get_pipeline_jobs` by pipeline id) or take no
narrowing argument at all (couchbase current-state tools, `connect_list_connectors`).
`mcp-tool-dataset.test.ts` now fails if a filterable-list anchor is reintroduced.

### Previous full run (`mcp-tool-eval-7a72cb0c`, 20 examples, all 7 datasources)

Run against servers built from the SIO-1398 `_id` prune and the SIO-1403 project_id
normalisation.

| key | avg |
|---|---|
| `tool_arg_validity` | **1.000** |
| `tool_name_validity` | **1.000** |
| `tool_response_health` | **1.000** |
| `tool_data_utilization` | **1.000** |
| `datasources_covered` | **1.000** |
| `expected_tools_fired` | 0.917 |
| `confidence_threshold` | 0.950 |
| `tool_efficiency` | 0.405 (soft) |

`tool_response_health` is back to 1.000 from 0.895: both false positives are gone (the
`ValidTill` certificate-expiry misread and the gitlab anchor that could not survive the model
adding `updated_after`). The kafka `describe_topic` miss is also gone -- that was the SIO-785
narrowing dropping an explicitly-selected action, not steering.

Coverage 46/88. Session progression: 19 -> 31 -> 45 -> 46.

### Coverage is NOT a tool-health measure -- use `eval:tool-probe` for that

gitlab sits at 9/22 here while the direct probe reports **17/22 tools returning data with zero
defects**. That gap is the whole reason `eval:tool-probe` exists: this eval can only observe a
tool the MODEL chose to call, so a healthy tool the agent never needed is indistinguishable
from a broken one. The remaining 13 gitlab targets are detail tools (`get_merge_request_diffs`,
`get_blame`, `get_job_log`) that only fire after a discovery step the example did not require.

Read the two together:

| probe | eval | meaning |
|---|---|---|
| ok | exercised | healthy and reachable |
| ok | not exercised | **steering gap** -- the tool works, the model did not pick it |
| fail | either | **tool defect** -- fix the server |

### Closing the loop: the elastic finding was fixed and re-verified

The `tool_arg_validity` 0.75 above was traced to `value_count` on the `_id` field, which
Elasticsearch rejects outright (`Fielddata access on the _id field is disallowed`) -- failing
the WHOLE search, so one bad clause took the legitimate sibling `terms` aggregations down with
it. Fixed in `034a5e5e` (schema description names the restriction and the already-available
alternative; the server also prunes the clause pre-flight).

Re-running the same leg against a server built from the fix:

| | before (`dda7575d`) | after (`034a5e5e`) |
|---|---|---|
| `tool_arg_validity` | 0.75, 1, 1 | **1, 1, 1** |
| search example | `calls=8 errors=2` | `calls=8 errors=0` |

Same dataset, same queries, zero rejected calls. This is the eval's intended loop: a live score
named the defect, the defect was root-caused and fixed, and the same score confirmed the fix.

### Full-dataset run (2026-08-06, `mcp-tool-eval-35ee7eca`)

16 examples, all 7 datasources, 198 tool calls. Elastic pointed at a server built from the
`_id` fix (`034a5e5e`).

| key | avg | note |
|---|---|---|
| `tool_arg_validity` | **1.000** | zero malformed calls anywhere -- the `_id` fix holding across the whole dataset |
| `tool_name_validity` | **1.000** | no invented tool names |
| `tool_response_health` | **1.000** | no prose-only errors, no empty anchors, no known-bug regressions |
| `tool_data_utilization` | **1.000** | judge: `used` on every example |
| `datasources_covered` | 1.000 | every example hit its pinned datasource |
| `expected_tools_fired` | 0.906 | 2 misses, both explained below |
| `confidence_threshold` | 0.938 | one example self-reported 0.59 vs the 0.6 gate |
| `tool_efficiency` | 0.327 | soft signal -- see below |

Coverage against the derived targets: **31/88** (from 19/88 before the expansion).

| datasource | covered |
|---|---|
| atlassian | 2/2 |
| couchbase | 8/19 |
| aws | 7/17 |
| kafka | 6/15 |
| gitlab | 5/22 |
| elastic | 3/7 |
| konnect | 0/6 (server disabled) |

The two `expected_tools_fired` misses are both legitimate:

- **konnect 0/1** -- the server is disabled here, so no tool could fire. Correct reporting, not a
  defect.
- **kafka 1/2** -- the model answered the DLQ half via `kafka_list_dlq_topics` +
  `kafka_consume_messages` and never reached for `kafka_describe_topic`. A genuine steering
  observation: the example asked two things and the model answered one.

10 tool errors, all pre-existing and correctly classified -- 6 × HTTP 404 `not-found` (the
SIO-1401 GitLab project-access issue) and 4 × `no-index` -> `no-data` from the Orbit tools on an
unindexed project. `tool_arg_validity` stayed 1.000 throughout, which is the evaluator
separation working: neither class is a malformed argument.

### Reading `tool_efficiency`

It is below 1.0 nearly everywhere, and that is expected -- it counts same-tool-same-target
calls without seeing arguments. Two verified examples of legitimate work it scores as
"repeats": kafka's `kafka_get_consumer_group_lag` called once per consumer group (iterations
3-8), and aws's `aws_ecs_list_services` called once per cluster. **Use it only to compare two
runs of the same example, never as a threshold.**

### Ground truth is deliberately argument-free

`expectedToolUse` names required tool GROUPS (`anyOf`), never arguments. Tool names change on
MCP upgrades and the 25-tool binder makes the bound set dynamic per run, so the disjunction is
what keeps this from rotting. Argument correctness is graded drift-free by `tool_arg_validity`
-- the server's own validation verdict beats a curator's guess, and args are not in graph state
anyway. `mcp-tool-dataset.test.ts` parses the real agent YAML so a renamed tool fails offline
instead of surfacing as a false model regression on a live run.

### What reaches LangSmith

`toolTrajectory` carries tool names, closed-enum classifications, and counts -- **never `args`
or `rawJson`**. Response-health checks read payloads in-process and emit only rule + tool name
+ detail. `redactPiiContent` could not have made payloads safe regardless: it deliberately does
not redact IPs, hostnames, or account ids (SIO-861, they are core diagnostic data). Projecting
no payload is the safety property.

Note that LangSmith run *inputs* already carry real incident text (hostnames, cluster names) and
have since `incident-replay-eval` shipped. The boundary being protected here is the **public git
repo** and the gitignored fixtures, not LangSmith, which is treated as internal-confidential.

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
