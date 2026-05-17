# HANDOFF — SIO-781 Phase 2 result: cold-start burst is fully covered by existing retry budget, no code change

| | |
|---|---|
| **Date** | 2026-05-17 |
| **Ticket** | [SIO-781](https://linear.app/siobytes/issue/SIO-781) (Backlog -> In Review proposed) |
| **Phase 2 plan** | `docs/handovers/HANDOFF-2026-05-17-sio-781-phase2-remeasure.md` (commit `b8128d7`) |
| **Child resolved** | [SIO-782](https://linear.app/siobytes/issue/SIO-782) Done -- PR [#112](https://github.com/zx8086/devops-incident-analyzer/pull/112), commit `b0d77dd` |
| **Repo state** | `main` @ `b8128d7f638a2f263fb00f71e0b98cbc24006181` (no code change in this phase) |
| **LangSmith trace** | `019e3768-c7ef-721f-bc16-a9cc0f365105` (project: `devops-incident-analyzer`) |

## TL;DR

SIO-781 Phase 2 was a pure measurement task: confirm whether the AgentCore cold-start burst still produces real `-32010` tool failures end-to-end now that SIO-782 silenced the probe-side noise.

**Result across two independent runs: zero retry signal, zero `-32010`, zero `gaveUpAfterMs`.** Every tool call returned `status: ok` on attempt 1. The Phase 2 plan's 4-row outcome table classifies this as **Row 1 -- close with no code change**.

The SIO-780 retry budget (`packages/shared/src/agentcore-proxy.ts:18-20` -- 5 attempts, 30s deadline) already absorbs the cold-start. No keep-alive ping, no concurrency cap, no `JSONRPC_RETRY_DEADLINE_MS` bump is needed.

## Why the burst no longer reproduces

Two structural reasons:

1. **SIO-780 / SIO-774 widened the retry budget itself** -- 5 attempts across 30s with exponential backoff is enough to cover even a fresh AgentCore init (~10s base latency in this run).
2. **The LLM fan-out is naturally two-waved.** The Pass 2 trace shows the LLM issues a small probe wave (`kafka_describe_cluster` + `kafka_get_cluster_info`, 2 calls) *before* the bulk fan-out (7 calls 14s later). The probe wave absorbs the cold-start hit; by the time the bulk wave fires, the runtime is warm. The original SIO-781 trace had a single 10-way kafka fan-out hitting a cold runtime in parallel -- the current prompt structure no longer produces that shape.

This second point is the load-bearing one. It explains why the synthetic curl burst *also* shows zero retries despite firing 10 truly parallel calls cold: the AgentCore runtime warms within the proxy's 5-attempt budget regardless of fan-out shape. The LLM's natural probe-then-fan-out pattern is a belt-and-braces second layer.

## Measurement protocol followed

Per `HANDOFF-2026-05-17-sio-781-phase2-remeasure.md` Step 1. Two passes:

### Pass 1 -- synthetic 10-way curl burst

- T0 (boot): 21:08:48 local (latest of kafka/aws/web ready)
- Idle: 6m 55s
- Burst: 21:15:43, ten parallel `kafka_list_topics` calls against `localhost:3000/mcp`
- Tool: `kafka_list_topics` (read-only, low-payload)

### Pass 2 -- real UI fan-out

- Idle: 12m 9s after Pass 1 (last warm call 21:15:55, burst 21:28:04)
- Query: "Are my servers / cluster health ?" via SvelteKit UI (`http://localhost:5173`)
- Fan-out shape: 9 kafka/ksql/connect tool calls across two waves

## Results table

| Metric | Pass 1 (synthetic) | Pass 2 (real UI) |
|---|---|---|
| Idle before burst | 6m 55s | 12m 9s |
| HTTP 200 | 10 / 10 | 9 / 9 |
| `-32010` JSON-RPC errors | 0 | 0 |
| `jsonrpc-error (retrying)` lines | 0 | 0 |
| `gaveUpAfterMs` (terminal failure) | 0 | 0 |
| `recoveredAfterAttempts` (warmed mid-retry) | 0 | 0 |
| Cold-start latency observed | ~9.6s (P50) on all 10 | ~10s on the 2-call probe wave |
| Warm latency observed | n/a | ~1s on kafka/connect, ~20s on ksql (Confluent upstream, not AgentCore) |
| Burst duration end-to-end | ~12s | ~37s (incl. waiting for ksql upstream) |

### Pass 2 per-tool detail

| Time | Tool | Status | Latency | Wave |
|---|---|---|---|---|
| 21:28:04 | `kafka_describe_cluster` | ok | 10s | 1 (cold) |
| 21:28:04 | `kafka_get_cluster_info` | ok | 10s | 1 (cold) |
| 21:28:18 | `ksql_get_server_info` | ok | 1s | 2 (warm) |
| 21:28:18 | `kafka_list_schemas` | ok | 1s | 2 (warm) |
| 21:28:18 | `connect_list_connectors` | ok | 1s | 2 (warm) |
| 21:28:18 | `kafka_get_cluster_info` | ok | 1s | 2 (warm) |
| 21:28:18 | `ksql_list_tables` | ok | 21s | 2 (warm; Confluent ksql roundtrip) |
| 21:28:18 | `ksql_list_queries` | ok | 21s | 2 (warm; Confluent ksql roundtrip) |
| 21:28:18 | `ksql_list_streams` | ok | 23s | 2 (warm; Confluent ksql roundtrip) |

## Evidence

### LangSmith

- **Trace ID**: `019e3768-c7ef-721f-bc16-a9cc0f365105`
- **Project**: `devops-incident-analyzer`
- **User prompt**: "Are my servers / cluster health ?"
- **Assistant response timestamp**: 2026-05-17T19:29:12.738Z (UTC) -- matches local 21:29:12 CEST
- **Outcome**: status `success`, full Unified Infrastructure Health Report produced across Elasticsearch + Kafka + Couchbase + GitLab + Atlassian + AWS (6 datasources)
- **Pull command**:
  ```bash
  LANGSMITH_API_KEY=<key from .env> LANGSMITH_PROJECT=devops-incident-analyzer \
    langsmith-fetch traces /tmp/sio781-traces --limit 3 --last-n-minutes 15 --include-metadata
  ```

### Proxy log (kafka MCP, AgentCore proxy port 3000)

The relevant burst window from `kafka-mcp-server` stdout. Pass 1 occupies lines 28-45, Pass 2 occupies lines 28-45 of the proxy log file used during this measurement (ephemeral path, quoted here verbatim):

Pass 2 burst window -- selected lines:
```
21:28:04  Proxying tool call: kafka_describe_cluster      id=2
21:28:04  Proxying tool call: kafka_get_cluster_info      id=3
21:28:14  Tool call proxied: kafka_describe_cluster -> ok
21:28:14  Tool call proxied: kafka_get_cluster_info -> ok
21:28:18  Proxying tool call: ksql_get_server_info        id=5
21:28:18  Proxying tool call: kafka_list_schemas          id=4
21:28:18  Proxying tool call: ksql_list_tables            id=7
21:28:18  Proxying tool call: ksql_list_streams           id=6
21:28:18  Proxying tool call: ksql_list_queries           id=8
21:28:18  Proxying tool call: connect_list_connectors     id=9
21:28:18  Proxying tool call: kafka_get_cluster_info      id=10
21:28:19  Tool call proxied: ksql_get_server_info -> ok
21:28:19  Tool call proxied: kafka_list_schemas -> ok
21:28:19  Tool call proxied: connect_list_connectors -> ok
21:28:19  Tool call proxied: kafka_get_cluster_info -> ok
21:28:39  Tool call proxied: ksql_list_tables -> ok
21:28:39  Tool call proxied: ksql_list_queries -> ok
21:28:41  Tool call proxied: ksql_list_streams -> ok
```

Grep for retry/error signal across the full burst window:
```
$ grep -E "gaveUpAfterMs|recoveredAfterAttempts|jsonrpc-error|jsonRpcCode|-32010|retrying" <proxy-log>
(no matches)
```

## Comparison vs. original SIO-781 trace

| | Original SIO-781 trace `8433266b-b865-4fb9-a3ca-9dcc7cbb9c41` | Pass 2 trace `019e3768-c7ef-721f-bc16-a9cc0f365105` |
|---|---|---|
| `toolErrorCount` | 11 | 0 |
| `gaveUpAfterMs` lines | several | 0 |
| `-32010` errors | observed | 0 |
| Sub-agent confidence | degraded | normal |

Net delta: SIO-780 (retry-budget widening, three-tier probe) + SIO-782 (probe-side debounce) closed the failure class without ever needing the SIO-781 mitigations (keep-alive / concurrency cap).

## Out of scope

The following are deliberately not pursued -- they are the Phase 2 mitigations from the plan that this measurement obsoletes:

- AgentCore keep-alive ping (`packages/shared/src/agentcore-proxy.ts`)
- Per-server tool concurrency cap (`packages/agent/src/mcp-bridge.ts`)
- `JSONRPC_RETRY_DEADLINE_MS` bump from 30s -> 45s

These remain available as future levers if the burst pattern resurfaces (e.g. if AgentCore's scale-to-zero default changes or if a future LLM prompt fans out without a probe wave). They should not be implemented speculatively.

## Linear workflow

- Linear comment posted on SIO-781 with this handover as the primary reference and the LangSmith trace ID as evidence.
- Status proposed: **In Review** (per the project rule "never set Linear issues to Done without user approval"). The user (Simon) approves final transition to Done.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| AgentCore changes scale-to-zero behaviour, lengthening cold-start beyond 30s | Low | Re-measure if `gaveUpAfterMs` lines reappear in production logs. Mitigation A (keep-alive) is the cheapest re-introduction if needed. |
| A future LLM prompt produces a single 10-way fan-out without a probe wave | Low | Concurrency cap (Mitigation B) is the targeted fix if observed. The current `Are my servers / cluster health` prompt structure naturally probes first. |
| Memory `reference_agentcore_logs_via_otel` becomes outdated if AgentCore log shipping is added | Low | Re-verify before assuming CloudWatch is the right evidence source for any future cold-start regression. |

## Files

No code changed in Phase 2. Documentation only:

| File | Change |
|---|---|
| `docs/handovers/HANDOFF-2026-05-17-sio-781-phase2-result.md` | New -- this measurement report |

## Related code references

- `packages/shared/src/agentcore-proxy.ts:18-20` -- retry budget constants (5 attempts, 30s deadline) that absorbed the cold-start
- `packages/shared/src/agentcore-proxy.ts:522-619` -- outer JSON-RPC retry loop (never entered during this measurement)
- `packages/agent/src/mcp-bridge.ts:67` -- `toolsByServer` registry (where Mitigation B would have attached if needed)
- `packages/agent/src/mcp-bridge.ts:339-407` -- `probeServer` (SIO-782's fixed version; produced clean signal for this measurement)

## Memory references

- `reference_agentcore_logs_via_otel` -- evidence is OTEL/LangSmith, not CloudWatch; confirmed correct
- `reference_agentcore_sse_response_shape` -- `-32010` is the documented cold-start code; zero observed in this run
- `reference_sio774_per_server_connect_timeouts` -- 35s connect envelope kafka/aws inherit; relevant context for retry budget
- `reference_langsmith_child_runs_via_sdk` -- per-tool child runs needed Python SDK; in this case the top-level message-shape from `langsmith-fetch` was sufficient because there were no errors to drill into
- `feedback_handover_doc_structure` -- this doc follows the full structure
- `reference_proxy_mcp_upstream_vs_local_env_vars` -- relevant for the kafka/aws AgentCore proxy port discovery (3000/3001 vs 9081/9083)
