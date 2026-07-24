# HANDOFF — SIO-1186 kafka MCP audit: 7 fixes shipped + AgentCore v14 deploy

- **Date:** 2026-07-24
- **Parent ticket:** [SIO-1186](https://linear.app/siobytes/issue/SIO-1186) — "Kafka MCP tool audit 2026-07-23: 61/61 tools tested" — **Done**
- **Child tickets (all Done):** [SIO-1187](https://linear.app/siobytes/issue/SIO-1187) [SIO-1188](https://linear.app/siobytes/issue/SIO-1188) [SIO-1189](https://linear.app/siobytes/issue/SIO-1189) [SIO-1190](https://linear.app/siobytes/issue/SIO-1190) [SIO-1191](https://linear.app/siobytes/issue/SIO-1191) [SIO-1192](https://linear.app/siobytes/issue/SIO-1192) [SIO-1193](https://linear.app/siobytes/issue/SIO-1193)
- **Repo state:** all 7 fixes merged to `main` (HEAD `215ae7ac`); PRs #446/448/449/451/452/453/454.
- **Prod state:** kafka AgentCore runtime `kafka_mcp_server-7RjmF16MqA` is **v14 / READY** (digest `sha256:1a150e9c...`), all 7 fixes **live-verified**.
- **Suggested branch for follow-up:** n/a — this work is complete. New follow-ups (see "Out of scope") get their own branch off `main`.

## TL;DR — what's done / what's live / gotchas

Ran the `mcp-tool-audit` skill against the kafka MCP (2nd application of `docs/runbooks/mcp-tool-audit-runbook.md`; 1st was GitLab SIO-1178/1179). Tested 61/61 tools zero-mutation against AgentCore prod, found 7 concerns, fixed+merged all 7, then redeployed the kafka image to AgentCore and live-verified every fix. **Nothing is outstanding on this thread.** This doc exists so the operational knowledge (how to re-verify, roll back, and the two traps that cost the most time) is captured. Two traps bit hard: (1) the first deploy (v13) shipped **pre-fix code** because the build ran from a stale worktree; (2) the shared `:3000` SigV4 proxy pins a warm session to an OLD container, so its probes lie — you MUST use a fresh boto3 session to verify a new version.

## Context — how this came to be

The kafka MCP powers the kafka-agent in the incident-analyzer pipeline. The audit runbook (`docs/runbooks/mcp-tool-audit-runbook.md`) is a repeatable method: prove every tool returns proper responses, separate real bugs from environment states, verify agent-side reachability + error-envelope conformance. This was its second application. Audit method skill: `.agents/skills/mcp-tool-audit/SKILL.md`. Full 69-row results matrix lives in the [SIO-1186 description](https://linear.app/siobytes/issue/SIO-1186).

## The 7 fixes (what shipped, where, merge SHA)

| Ticket | Severity | Fix | Merge SHA | PR |
|---|---|---|---|---|
| SIO-1187 | Urgent (security) | `connect_list_connectors` redacts credential-shaped config values | `ed181527` | #446 |
| SIO-1188 | High | ksql `LIST STREAMS/TABLES` (drop `EXTENDED`; the `sourceDescriptions` shape never matched) | `b8c0b905` | #448 |
| SIO-1189 | High | DLQ typed-findings: `totalMessages>0` bypasses focus filter | `26659520` | #449 |
| SIO-1190 | Medium | shared `{_error}` envelope on kafka throw path | `4635cb28` | #451 |
| SIO-1191 | Medium | `ksql_run_query` default `auto.offset.reset=earliest` + 25s AbortSignal | `176a98ba` | #452 |
| SIO-1192 | Medium | kafka fixture-drift test parsing real `kafka-introspect.yaml` | `8d41bef0` | #453 |
| SIO-1193 | Low | bundle: `describe_cluster.topicCount`, `ksql_cluster_status` 404→not-enabled, toolCount log math, `restproxy_consume` tag | `215ae7ac` | #454 |

### Where the bodies were buried (now fixed on main)

- **SIO-1188** — `packages/mcp-server-kafka/src/services/ksql-service.ts:111,116`: `listStreams()`/`listTables()` now send `LIST STREAMS;`/`LIST TABLES;` (was `... EXTENDED;`). The `EXTENDED` variant returns `@type:"sourceDescriptions"` which `extractSourceList` (`:170`, matches `@type==="streams"`/`"tables"`/array-key) can never match. **Verified against ksqlDB 7.2.1 source**: the `@JsonSubTypes` on `KsqlEntity` maps `StreamsList`→`"streams"`, `TablesList`→`"tables"` (Context7 `/confluentinc/ksql`).
- **SIO-1187** — `packages/mcp-server-kafka/src/services/connect-service.ts:45` `REDACTED_VALUE` + `redactConnectorConfig()`; applied in `listConnectors()`. Key regex covers `password|secret|token|credential|sasl.jaas.config|basic.auth.user.info|api[._-]?key|private[._-]?key`, NOT a bare `key` (so `key.converter` survives).
- **SIO-1189** — `packages/agent/src/correlation/extractors/kafka.ts:176` `isRelevantDlq(row, focus)`: passes any row with `totalMessages>0`. Root cause: `recentDelta:null` is the common case (SIO-1150 auto-skip-delta ≥15 topics), and `DLQ_T_*` names never fuzzy-match service focus.
- **SIO-1190** — `packages/mcp-server-kafka/src/tools/wrap.ts` `classifyThrownError()` + `ResponseBuilder.errorWithKind()` (`src/lib/response-builder.ts`). Prose FIRST, `{_error}` envelope next, SIO-728 `---STRUCTURED---` sentinel LAST (so `split()[1]` stays pure JSON). Unclassifiable errors stay byte-identical on the legacy path.
- **SIO-1191** — `ksql-service.ts` `RUN_QUERY_DEFAULT_PROPERTIES` + `RUN_QUERY_TIMEOUT_MS=25_000` (under the proxy's 30s). Description gains the copy-paste recipe.
- **SIO-1193** — `describeCluster()` counts via `admin.listTopics()` (was `metadata.topics.size`, always 0); `ksql/operations.ts clusterStatus()` maps 404→`"not-enabled"`; `tools/index.ts computeRegisteredToolCount()` is now the single count source (pinned by a 4-combo canary in `tests/tools/full-stack-tools.test.ts`); `restproxy/prompts.ts` tags `restproxy_consume` `[WRITE]`.

## THE DEPLOY — and the two traps (read before ever redeploying)

Runbook: `docs/runbooks/mcp-agentcore-image-deployment.md`. Runtime `kafka_mcp_server-7RjmF16MqA`, account `399987695868`, profile `eu-shared-services-prd`, region `eu-central-1`, **VPC mode**, ECR repo `kafka-mcp-agentcore`, SigV4 proxy local port 3000.

### Current live state
- **v14**, digest `sha256:1a150e9cfb594bf8ed2534a37aac78081c5b31d67d632cb7052b639f937bb020`, tag `sio-1186-audit-fixes-v2`, built from `main`@215ae7a.
- **Rollback digests in ECR:** v13 `0bf572d4...` (BAD — pre-fix), v12 `c55f179c...` (pre-audit, known-good). Roll back by editing `containerUri` to a digest and re-applying (step below).

### TRAP 1 — build context = cwd. The v13 deploy shipped PRE-FIX code.
`scripts/agentcore/push-to-production-ecr.sh` runs `docker build -f Dockerfile.agentcore ... .` — context is **cwd**. `Dockerfile.agentcore:60` `COPY packages/${MCP_SERVER_PACKAGE}/` and `:80` runs `bun run src/index.ts` **directly (no compiled dist)**. So the image = whatever `src/` is in the tree you build from. The first deploy was run from a worktree whose branch was cut **before** SIO-1188 landed on main → v13 shipped `LIST STREAMS EXTENDED;`.
- **ALWAYS build from a tree whose `git log` shows the merged fixes** (i.e. `main` at/after `215ae7a`).
- **VERIFY the image carries the change BEFORE deploying** — do not trust the runtime digest alone:
  ```bash
  docker create --name v14check <repo>:<tag> >/dev/null
  docker cp v14check:/app/packages/mcp-server-kafka/src/services/ksql-service.ts - | tar -xO | grep -nE "LIST STREAMS|EXTENDED"
  docker rm v14check >/dev/null   # expect "LIST STREAMS;", NOT EXTENDED
  ```

### TRAP 2 — VPC update asymmetry (use boto3, not CLI).
`get-agent-runtime` returns only `{"networkMode":"VPC"}` — it OMITS `networkModeConfig`, yet `update-agent-runtime` REQUIRES it, and an outdated AWS CLI rejects the param. Recover subnets/SG from the MSK cluster and apply via boto3.
- MSK subnets/SG (recover live via `aws kafka describe-cluster-v2 --cluster-arn <MSK_CLUSTER_ARN>`): subnets `subnet-0a688c698988fa7e5 / 0d647783affd0830a / 002e50db03a09077e`, SG `sg-036bdf14e8a9c05b1`.
- Build the payload by projecting the captured `get-agent-runtime` JSON, changing ONLY `containerUri` and re-adding `networkModeConfig`. Never retype the 18 env vars.
- Apply (boto3 in a venv): `client("bedrock-agentcore-control").update_agent_runtime(**payload)`. Poll UPDATING→READY, then diff the applied config — only `containerUri`+metadata should differ.

## VERIFICATION — the ONLY reliable post-deploy method (cold boto3 session)

The shared `:3000` SigV4 proxy PINS its session to a warm OLD-version microVM — its probes report the old behavior. A **fresh `runtimeSessionId` (33–48 chars)** forces AgentCore to route to a new-version container.

Discriminator when versions look identical: `ksql_list_streams` duration — **v14 (fixed) = ~2s non-empty**, v13 (`EXTENDED`) = ~22s empty. (Boot logs say `toolCount=61` for BOTH, so count does not discriminate.)

```python
# boto3 cold probe (rebuild if needed — the original was in the recycled scratchpad)
import json, uuid, boto3
rt = boto3.Session(profile_name="eu-shared-services-prd", region_name="eu-central-1").client("bedrock-agentcore")
ARN = "arn:aws:bedrock-agentcore:eu-central-1:399987695868:runtime/kafka_mcp_server-7RjmF16MqA"
sid = ("cold-" + uuid.uuid4().hex + uuid.uuid4().hex)[:48]   # fresh id => cold microVM
def call(method, params=None, i=1):
    body = {"jsonrpc":"2.0","id":i,"method":method}
    if params is not None: body["params"]=params
    r = rt.invoke_agent_runtime(agentRuntimeArn=ARN, runtimeSessionId=sid,
        payload=json.dumps(body).encode(), contentType="application/json",
        accept="application/json, text/event-stream")
    raw = r["response"].read().decode()
    for line in raw.splitlines():
        if line.startswith("data:"): return json.loads(line[5:].strip())
    return json.loads(raw)
call("initialize", {"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}})
call("notifications/initialized", {}, 2)
print(call("tools/call", {"name":"ksql_list_streams","arguments":{}}, 3))
```

Expected on v14 (all PASS as of 2026-07-23/24):
- `ksql_list_streams` → real streams (e.g. `S_CUSTOMER_ASSIGNMENTS`) in ~2s [SIO-1188]
- `kafka_describe_topic {"topic":"zz-nonexistent"}` → text carries `{"_error":{"kind":"not-found","category":"not-found"}}` [SIO-1190]
- `ksql_run_query {"ksql":"SELECT * FROM S_CUSTOMER_ASSIGNMENTS EMIT CHANGES LIMIT 1;"}` (NO properties) → row + `Limit Reached` in ~8s, no 502 [SIO-1191]
- `connect_list_connectors {}` → 12 `***REDACTED***`, zero plaintext (grab the FULL payload; config appears after `status`) [SIO-1187]
- `kafka_describe_cluster {}` → `"topicCount": 142` [SIO-1193a]
- `ksql_cluster_status {}` → `"status":"not-enabled"` [SIO-1193b]

### Code-side verification (from `main`)
```bash
bun run typecheck && bun run lint && bun run test
# kafka package alone: bun run --filter @devops-agent/mcp-server-kafka test   # 355 pass as of merge
```

## Workflow used (for reference / audit trail)
- Each fix: branch off `main` → fix + tests → typecheck/lint/test → ready-for-review PR → CodeRabbit clean → squash-merge. (CodeRabbit rate-limited 5 PRs; waited out the window, all returned "No actionable comments".)
- Merges hit the auto-mode approval prompt (agent-authored PR, no branch protection) — user approved each.
- Linear: all children auto-transitioned to Done on merge (GitHub↔Linear); parent SIO-1186 moved to Done manually with explicit user approval.

## Risks / edge cases
| Risk | Likelihood | Mitigation |
|---|---|---|
| Future redeploy from wrong tree ships stale code again | Medium | ALWAYS extract+grep the image before deploy (Trap 1 recipe). |
| Warm-proxy probe gives false "still broken" reading | High if forgotten | Always verify with a fresh boto3 session id, never the `:3000` proxy. |
| VPC update fails `NetworkModeConfig required` | High if CLI used | Use boto3; recover subnets/SG via `describe-cluster-v2`. |
| Prod writes UNLOCKED (`KAFKA_ALLOW_WRITES=true` + `KAFKA_ALLOW_DESTRUCTIVE=true`) | Standing fact | Any agent-driven kafka write path hits real MSK — treat with care. |

## Out of scope (NOT part of this thread — file new tickets if pursued)
- Whether the 5 OTHER AgentCore servers (elastic/couchbase/konnect/gitlab/atlassian) have the same `describe`/list shape or transport-env gaps (open follow-up from the SIO-1122 deploy-script era).
- Rotating the connector credentials that were briefly exposed via `connect_list_connectors` pre-fix (a secrets-hygiene task, not a code fix).
- Broader ksqlDB tool coverage (only list/describe/queries/run_query were exercised).

## Related code references (correct patterns to mirror)
- Envelope adoption pattern: `packages/mcp-server-gitlab/src/tools/error-envelope.ts` (SIO-1179, the template SIO-1190 copied).
- Fixture-drift test pattern: `packages/agent/src/sub-agent-gitlab-resolution.test.ts:161` (SIO-1178; SIO-1192 mirrored it for kafka).
- Deploy runbook: `docs/runbooks/mcp-agentcore-image-deployment.md`; audit runbook: `docs/runbooks/mcp-tool-audit-runbook.md`.

## Memory references
- `kafka-audit-sio1186-findings` — the canonical findings + deploy + cold-probe recipe (updated with the v13-bad-build lesson).
- `reference_agentcore_update_vpc_networkconfig_gotcha` — VPC update trap + boto3 recipe.
- `reference_agentcore_deploy_silent_network_and_transport_gaps` — deploy.sh silent-failure history.
- `reference_session_kafka_mcp_cannot_reach_msk` — why the local stdio kafka MCP can't be used to verify.
- `reference_kafka_mcp_tool_count_canaries`, `reference_kafka_list_filter_invalid_regex_32603`, `reference_pr_merge_no_branch_protection_and_worktree_gh_quirk`.
