# HANDOFF — SIO-781 Phase 2: re-measure cold-start burst after SIO-782 landed

| | |
|---|---|
| **Date** | 2026-05-17 |
| **Ticket** | [SIO-781](https://linear.app/siobytes/issue/SIO-781) (Backlog, High) — Phase 2 |
| **Parent** | none (SIO-781 is the parent of SIO-782) |
| **Child resolved** | [SIO-782](https://linear.app/siobytes/issue/SIO-782) Done — PR [#112](https://github.com/zx8086/devops-incident-analyzer/pull/112), commit `b0d77dd` |
| **Repo state** | `main` @ `b0d77dd` |
| **Suggested branch** | depends on outcome — none yet; this is a measurement task first |

## TL;DR

SIO-782 fixed the probe-side regression that was generating the dominant noise (`MCP server upstream degraded ... components: {}` every ~60s for kafka-mcp + aws-mcp). With the false positives gone, we can now see whether the **underlying cold-start burst still produces real `-32010` tool failures** end-to-end during an idle-then-burst kafka query.

The original SIO-781 mitigation plan was (1) AgentCore keep-alive ping + (2) per-server tool concurrency cap. **Do not implement either until Phase 2 measurement is done.** The SIO-780 retry budgets (`packages/shared/src/agentcore-proxy.ts:18-20` — 5 attempts, 30s deadline) may already cover most of the burst, in which case (1) and/or (2) can be downscoped or closed.

**Phase 2 deliverable**: a short measurement report (commit to `docs/handovers/` as a follow-up note, or comment on SIO-781) stating either:

- "Burst-driven `-32010` is gone — close Phase 2 with no code change." OR
- "Burst-driven `-32010` still fires N times per run — implement keep-alive only / cap only / both." With LangSmith run IDs as evidence.

## Context — what SIO-782 changed

PR #112 landed three changes in `packages/agent/src/mcp-bridge.ts`:

1. `probeServer` Tier 3 `/ready` fetch now uses `AbortSignal.timeout(connectTimeoutFor(name))` — kafka-mcp and aws-mcp inherit the 35s SIO-774 envelope instead of the old fixed 5s.
2. Synthetic-unready snapshot (the catch branch when `/ready` throws) is tagged with `errors._probeTimeout = "true"`.
3. New `unreadyStreak` map + `UNREADY_WARN_THRESHOLD = 3`. The `unready` case in `pollServerHealth` only emits the log on threshold crossing, and severity downgrades to `info` ("MCP server probe timing out") when `_probeTimeout` is set.

Net effect: idle kafka-mcp + aws-mcp proxies stop firing the per-minute warn loop. Whatever logs/traces you see from a fresh `bun run dev` session are real signal now, not probe-timeout noise.

## Where the bodies are buried (still)

Unchanged since the original SIO-781 handover; included here so this doc is self-contained.

### Proxy retry budget

`packages/shared/src/agentcore-proxy.ts:18-20`:

```ts
const JSONRPC_RETRY_BACKOFFS_MS = [300, 800, 1500, 3000] as const;
const JSONRPC_RETRY_MAX_ATTEMPTS = JSONRPC_RETRY_BACKOFFS_MS.length + 1; // 5
const JSONRPC_RETRY_DEADLINE_MS = 30_000;
```

Retry loop body: `packages/shared/src/agentcore-proxy.ts:522-619`. Recovery paths:

- Terminal-log branch at `:540-558` — `gaveUpAfterMs` field surfaces here.
- Retry branch at `:583-619` — `recoveredAfterAttempts` field surfaces in the eventual "ok" log when the runtime warms mid-retry.

### Sub-agent fan-out (still uncapped)

`packages/agent/src/sub-agent.ts:464-493` — `Promise.all` across deployments for elastic. The kafka sub-agent goes through a single `runSubAgent` call but the LLM inside it can fire 10+ parallel `tool_use` blocks in one turn; langchain dispatches all of them in parallel.

### Per-server tool registry (where a concurrency cap would attach)

`packages/agent/src/mcp-bridge.ts:67` — `toolsByServer: Map<string, StructuredToolInterface[]>` already groups tools by MCP server. A semaphore would wrap `tool.func` in `reconnectServer` (`mcp-bridge.ts:417-455`) and the initial connect path.

### AgentCore runtime config

`.env`:

```
KAFKA_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:399987695868:runtime/kafka_mcp_server-7RjmF16MqA
KAFKA_AGENTCORE_PROXY_PORT=3000
AWS_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:356994971776:runtime/aws_mcp_server-57wIOB35U1
AWS_AGENTCORE_PROXY_PORT=3001
```

Runtime accounts: kafka in `399987695868`, aws in `356994971776`.

## Evidence source

**Use OTEL / LangSmith. Do NOT chase CloudWatch.** AgentCore runtime container logs are intentionally not shipped to CloudWatch; telemetry flows through OTEL. The original SIO-781 handover's "Phase 1: confirm cold-start from CloudWatch" was based on a wrong assumption — ignore it. See memory `reference_agentcore_logs_via_otel`.

For per-tool-call latencies and the `-32010` error body shape, pull child runs via the Python SDK (memory `reference_langsmith_child_runs_via_sdk`). The `langsmith-fetch` CLI returns top-level runs only.

## The measurement protocol

### Step 1 — Reproduce the original symptom

Goal: confirm the cold-start burst is still observable end-to-end on `main` @ `b0d77dd`.

```bash
# Boot the agent + all proxies fresh. Let everything sit idle for >5 min so
# AgentCore scales the kafka_mcp_server runtime to zero.
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
bun run dev
# Wait 6 minutes.
```

Then fire the standard kafka triage query from the SvelteKit UI (port 5173) — the PIM-sink-DLQ replay or any consumer-lag / topic-offsets query that produces a 10-way kafka `tool_use` fan-out in one LLM turn.

Capture: the LangSmith run ID, thread ID, and the proxy log output for the burst window.

Look for in the proxy log (`packages/mcp-server-kafka` stdout, port 3000):

- `Tool call proxied: kafka_* -> jsonrpc-error (retrying)` lines with `jsonRpcCode: -32010, attempt: 1..5`.
- Terminal lines with `gaveUpAfterMs: <ms>` — these are the real failures the user sees.
- Recovery lines with `recoveredAfterAttempts: <N>` — these are the burst calls that the proxy retry budget already saved.

Look for in LangSmith:

- Sub-agent run name `agent.sub-agent` with `dataSourceId: "kafka"`.
- `toolErrorCount` in the sub-agent's final state. The original SIO-781 trace had `toolErrorCount: 11`.

### Step 2 — Classify what you see

Four possible outcomes, with action for each:

| Observation | Action |
|---|---|
| `toolErrorCount: 0` and zero terminal `gaveUpAfterMs` lines | **Close Phase 2 with no code change.** The SIO-780 retry budgets cover the burst. Comment on SIO-781 with the run ID and close the ticket. |
| `toolErrorCount: 0` but the burst takes >10s to complete (lots of `recoveredAfterAttempts: 3..5`) | **Implement keep-alive only.** The retries are working but tail latency is bad; keep-alive eliminates the cold-start entirely. Skip the concurrency cap. |
| `toolErrorCount: 1..5` with some terminal `gaveUpAfterMs` lines | **Implement both keep-alive + concurrency cap.** The retry budget covers most of the burst but a few stragglers exhaust the 30s deadline. Both mitigations together eliminate the failure class. |
| `toolErrorCount: 6+` (same magnitude as the original SIO-781 trace) | **Stop and re-investigate.** SIO-782 was supposed to be probe-only; if tool failures didn't change, something else is going on. Pull the LangSmith trace + Python-SDK child runs, compare against the original SIO-781 run `8433266b-b865-4fb9-a3ca-9dcc7cbb9c41`. |

Don't pre-commit to "implement both" — measure first, then choose.

### Step 3 — If implementing, here's the sketch

These are starting points; verify code structure hasn't drifted before applying verbatim.

#### Mitigation A — AgentCore keep-alive ping

`packages/shared/src/agentcore-proxy.ts`, after the `Bun.serve({...})` block (near the existing `/health` and `/ping` routes around line 647-660):

```ts
// SIO-781 Phase 2: warm-keep ping to prevent AgentCore scale-to-zero.
// tools/list isn't billed; cheap enough to fire every 60s per proxy.
// Opt-in via env to keep cost predictable in low-traffic deployments.
const keepAliveMs = Number(process.env.AGENTCORE_KEEPALIVE_INTERVAL_MS ?? "0");
let keepAliveTimer: Timer | undefined;
if (keepAliveMs > 0) {
    keepAliveTimer = setInterval(async () => {
        try {
            const creds = await getCredentials();
            const targetUrl = new URL(`${basePath}?${queryString}`, baseUrl);
            const body = JSON.stringify({ jsonrpc: "2.0", id: "keepalive", method: "tools/list" });
            const headers = signRequest("POST", targetUrl, body, creds, config.region);
            await fetch(targetUrl.toString(), {
                method: "POST",
                headers,
                body,
                signal: AbortSignal.timeout(15_000),
            });
        } catch (err) {
            logger.debug({ err: err instanceof Error ? err.message : String(err) }, "Keep-alive ping failed");
        }
    }, keepAliveMs);
}

// In the existing close() handler, add: if (keepAliveTimer) clearInterval(keepAliveTimer);
```

`.env` additions:

```
KAFKA_AGENTCORE_KEEPALIVE_INTERVAL_MS=60000
AWS_AGENTCORE_KEEPALIVE_INTERVAL_MS=60000
```

The env-var name needs to be per-server-prefixed (matching the SIO-774 pattern, memory `reference_subagent_env_tunables`). Resolve the prefix inside `startAgentCoreProxy()` based on `config.serverName`, don't read a single shared `AGENTCORE_KEEPALIVE_INTERVAL_MS`.

#### Mitigation B — Per-server tool concurrency cap

`packages/agent/src/mcp-bridge.ts`, near `toolsByServer` (line 67):

```ts
// SIO-781 Phase 2: per-server semaphore wrapping tool funcs. Caps the LLM's
// first-turn fan-out so a cold AgentCore runtime serialises cleanly instead
// of getting hammered by 10 parallel calls during its init window.
const concurrencyBySrv = new Map<string, Semaphore>();

function maxConcurrentFor(serverName: string): number {
    const envKey = `${serverName.toUpperCase().replace(/-/g, "_")}_MAX_CONCURRENT_TOOLS`;
    return Number(process.env[envKey] ?? "0") || Infinity;
}
```

Write a minimal in-house semaphore (~20 lines, explicit `release()` in `finally`) — don't pull a dependency. Wrap `tool.func` in both `reconnectServer` and the initial connect path so reconnects don't drop the wrapper.

`.env` additions:

```
KAFKA_MCP_MAX_CONCURRENT_TOOLS=3
AWS_MCP_MAX_CONCURRENT_TOOLS=3
```

Default: `Infinity` (no cap) when the env var is unset, so non-AgentCore servers stay unconstrained.

## Verification (if you implement)

```bash
bun run typecheck && bun run lint && bun run --filter '@devops-agent/agent' test && bun run --filter '@devops-agent/shared' test
```

Then re-run the measurement protocol from Step 1 and confirm:

- For keep-alive: zero `gaveUpAfterMs` lines in the proxy log over a 6-minute-idle-then-burst cycle.
- For concurrency cap: synthetic 10-way burst (curl loop below) returns ≤1 `-32010` instead of the original 11.

Synthetic burst (only if you can't reproduce via the UI):

```bash
# After 6+ minutes of idle on the kafka proxy
for i in $(seq 1 10); do
  curl -s -X POST -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/call\",\"params\":{\"name\":\"kafka_get_consumer_group_lag\",\"arguments\":{\"groupId\":\"test-cg\"}}}" \
    http://localhost:3000/mcp &
done
wait
```

## Workflow

1. Branch off `main` only if Step 2 says to implement. Otherwise close SIO-781 with a comment.
2. Branch name (if implementing): `simonowusupvh/sio-781-phase2-<keepalive|concurrency-cap|both>`.
3. Linear status: `Backlog` → `In Progress` when you start coding. **Never set to Done without user approval** (project rule).
4. One PR per mitigation, or one combined PR — caller's choice. Reference SIO-781 in title and body. Use HEREDOC commit message with the `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer.
5. PR description must show before/after numbers from the measurement protocol.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Keep-alive doubles AgentCore traffic | Low | `tools/list` isn't billed; only `tools/call`. 1 ping/min × 2 runtimes = 2880 free invocations/day. |
| Keep-alive masks real outages | Medium | Log every keep-alive failure at `warn`; the SIO-780 `/ready` probe still surfaces real failure for the UI. Now that probe noise is gone (SIO-782), this is cleaner than before. |
| Concurrency cap throttles legitimate parallel queries | Medium | Per-server cap defaults to `Infinity`. Start with `KAFKA_MCP_MAX_CONCURRENT_TOOLS=3` only; measure before adding aws. |
| AgentCore changes scale-to-zero default | Low | Document the assumption in the code comment so future-us can revisit. |
| The 30s proxy retry deadline is hit on slower-than-usual cold-starts | Medium | If Step 2 shows mostly `gaveUpAfterMs: 25_000+` with few retries left at deadline, the cleanest fix is bumping `JSONRPC_RETRY_DEADLINE_MS` to 45_000 — simpler than adding new code paths. Consider this a third mitigation option. |

## Files (if implementing)

| File | Change |
|---|---|
| `packages/shared/src/agentcore-proxy.ts` | Keep-alive interval (~25 lines, opt-in via per-server env var) |
| `packages/shared/src/__tests__/agentcore-proxy.test.ts` (if exists) or new | Unit test: env off → no timer; env on → fetch called every N ms |
| `packages/agent/src/mcp-bridge.ts` | Per-server semaphore wrapping tool funcs (~30 lines) |
| `packages/agent/src/__tests__/mcp-bridge-concurrency.test.ts` (new) | Cap=2, 5 parallel calls → only 2 run concurrently |
| `.env.example` | Document new env vars |

Don't bundle:

- Probe-side changes — SIO-782 already shipped those.
- SIO-780 rollback — three-tier probe stays.
- AgentCore CloudWatch log shipping — intentional, see memory `reference_agentcore_logs_via_otel`.

## Out of scope

- AgentCore container log shipping (intentional, OTEL-only).
- Cross-account VPC peering for Confluent-prd (memory `reference_network_ask_agentcore_to_confluent`).
- Sub-agent confidence scoring on tool failure (covered by SIO-681 `enforceCorrelationsAggregate`).
- SIO-780 rollback. The three-tier probe design is sound after SIO-782's debounce.

## Related code references

- `packages/shared/src/agentcore-proxy.ts:18-20` — retry budget constants
- `packages/shared/src/agentcore-proxy.ts:522-619` — outer JSON-RPC retry loop
- `packages/shared/src/agentcore-proxy.ts:540-558` — terminal-log branch (`gaveUpAfterMs`)
- `packages/shared/src/agentcore-proxy.ts:583-619` — retry-log branch (`recoveredAfterAttempts`)
- `packages/shared/src/agentcore-proxy.ts:647-660` — existing `/health`, `/ping` routes (keep-alive lives near here)
- `packages/agent/src/mcp-bridge.ts:67` — `toolsByServer` registry (cap state lives here)
- `packages/agent/src/mcp-bridge.ts:417-455` — `reconnectServer` (inject tool-func wrapper here)
- `packages/agent/src/mcp-bridge.ts:339-407` — `probeServer` (already fixed by SIO-782; don't re-touch)
- `packages/agent/src/sub-agent.ts:464-493` — sub-agent fan-out (no changes needed; read for context)

## Memory references

- `reference_agentcore_logs_via_otel` — runtime telemetry flows through OTEL, not CloudWatch; empty `/aws/bedrock-agentcore/*` log group is intentional
- `reference_agentcore_sse_response_shape` — `-32010` is the documented cold-start code; 502 wrap also documented
- `reference_sio774_per_server_connect_timeouts` — 35s connect envelope kafka/aws inherit; reused by SIO-782 for the `/ready` probe
- `reference_kafka_mcp_agentcore_ksql_disabled` — current AgentCore deployment shape (ksql/connect/SR registered in 399987695868)
- `reference_aws_iam_role_and_externalid` — cross-account context; runtime accounts differ from local agent account
- `reference_langsmith_child_runs_via_sdk` — per-tool-call latency needs the Python SDK, not langsmith-fetch CLI
- `reference_subagent_env_tunables` — per-server-prefixed env-var pattern (`KAFKA_MCP_*`, `AWS_MCP_*`)
- `reference_supervisor_send_shape` — supervise() returns Send; relevant if you trace the burst back through the sub-agent dispatch
- `feedback_handover_doc_structure` — this doc follows the full structure
