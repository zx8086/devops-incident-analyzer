# HANDOFF — Kafka MCP cold-start under burst (SIO-781)

| | |
|---|---|
| **Date** | 2026-05-17 |
| **Ticket** | [SIO-781](https://linear.app/siobytes/issue/SIO-781) (High, Backlog) |
| **Parent** | [SIO-780](https://linear.app/siobytes/issue/SIO-780) (Done — readiness work) |
| **Repo state** | `main` @ `8a900a1832cf1f541beb0ba6d1ee636a0651557e` (SIO-780 fix merged) |
| **Suggested branch** | `simonowusupvh/sio-781-kafka-mcp-cold-start-under-burst` (Linear-suggested) |

## TL;DR

When the kafka sub-agent fires a burst of 10+ concurrent tool calls against an idle AgentCore-hosted Kafka MCP runtime, the first call triggers a cold-start while the remaining 9 land on a runtime that hasn't passed its health gate yet — every concurrent caller gets `MCP error -32010: Runtime health check failed or timed out`. The proxy's existing 5-attempt jittered-backoff retry loop recovers most calls, but not all. End user sees a deceptively-completed run with 11 tool failures and a finding that says "Kafka broker layer is unreachable — sub-agent cache findings are unconfirmed."

**The run completed.** Aggregator reported `successes: 5, errors: 0`. Nothing is broken in the structural sense — but live broker-level findings (consumer lag, topic offsets, DLQ state) couldn't be confirmed because every tool that needed live broker data failed during the burst.

**Recommended path forward**: implement a 60s warm-keep ping in the SigV4 proxy AND a per-server concurrency cap in the langchain tool wrapper. Either alone is insufficient. See [Mitigation options](#mitigation-options) below.

## Context — how SIO-781 came to be

This surfaced during a live production query at 19:19–19:21 UTC on 2026-05-17, the same day SIO-780 (identity + readiness) merged. The user noted:

> Kafka broker layer is unreachable (11 tool failures, MCP error -32010). Consumer lag, topic offsets, and DLQ state for PIM sink connectors cannot be confirmed from live broker data. Sub-agent cache findings are unconfirmed.

This is **not** the bug SIO-780 fixed. SIO-780 was about the `/ready` probe mis-parsing AgentCore's SSE-framed response (PR #111 / commit `8a900a1`). SIO-781 is about tool-call traffic under burst against a cold AgentCore runtime — a different code path, different failure mode, no `/ready` involvement.

The dashboard warnings `MCP server upstream degraded ... components: {}` at `19:21:55` and `19:22:55` are a **second, related** issue: the agent-side `/ready` probe at `packages/agent/src/mcp-bridge.ts:382-401` has a 5s timeout, while the proxy `/ready` itself runs a 20s upstream probe. When the proxy's `/ready` cache misses against a cold runtime, the agent's 5s fetch times out and synthesises `components: {}`. Tracked separately (out of scope per SIO-781 description); flag in a follow-up if it becomes a UI problem.

## Where the bodies are buried

### Proxy retry budget (likely too tight for 10-way fan-out on cold AgentCore)

`packages/shared/src/agentcore-proxy.ts:18-20`:

```ts
const JSONRPC_RETRY_BACKOFFS_MS = [300, 800, 1500, 3000] as const;
const JSONRPC_RETRY_MAX_ATTEMPTS = JSONRPC_RETRY_BACKOFFS_MS.length + 1; // 5
const JSONRPC_RETRY_DEADLINE_MS = 30_000;
```

The retry loop itself is at `packages/shared/src/agentcore-proxy.ts:522-619`. Key behaviour:

- 5 attempts total, jittered (see `computeJitteredBackoff`)
- Cumulative 30s wallclock deadline — when next backoff would push past it, give up
- `-32010` is in `isRetryableJsonRpcCode`; only retryable codes go through this loop

`packages/shared/src/agentcore-proxy.ts:540-558` is the terminal-log branch — that's where the `gaveUpAfterMs` field comes from in the log timeline below.

### Sub-agent concurrency (no cap)

`packages/agent/src/sub-agent.ts:464-493`:

```ts
const log = logger.child({ requestId: state.requestId, dataSourceId, isRetry });
// ...
log.info({ deployments, isRetry }, "Elastic sub-agent fanning out across deployments");

const results = await Promise.all(
    deployments.map((deploymentId) =>
        runSubAgent(state, dataSourceId, agentName, isRetry, log, config, { deploymentId }),
    ),
);
```

That's the *elastic* fan-out across deployments. The kafka sub-agent goes through a single `runSubAgent` call but the **LLM inside it** issues multiple `tool_use` blocks in one turn — and langchain dispatches all of them in parallel via `Promise.all`. Search for the `getTools()` wrapping in `mcp-bridge.ts:431` to find where the tool concurrency is unbounded.

### AgentCore runtime config

`.env`:

```
KAFKA_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-central-1:399987695868:runtime/kafka_mcp_server-7RjmF16MqA
KAFKA_AGENTCORE_PROXY_PORT=3000
```

Runtime account: **399987695868** (NOT the local agent account `352896877281` — see `reference_aws_iam_role_and_externalid` memory). CloudWatch log group for the runtime: `/aws/bedrock-agentcore/runtimes/kafka_mcp_server-7RjmF16MqA/*`. Requires cross-account access or local AWS-CLI session with role assumption into the runtime account.

### MCP tool wrapper

`packages/agent/src/mcp-bridge.ts:417-455` (`reconnectServer`) shows the per-server tool registration. Per-server semaphore would go here, wrapping `tool.func` before tools are appended to `allTools`. Look at the structure — `toolsByServer.set(name, tools)` already exists, which is the right map to attach a per-server `Sema` to.

## Reproduction (the trace we already have)

Don't re-run — the evidence is in LangSmith. **Run ID**: `8433266b-b865-4fb9-a3ca-9dcc7cbb9c41`, **thread ID**: `f411cbab-db46-4503-a3f5-2f6d8f75e5af`, project `devops-incident-analyzer`. Pull it with:

```bash
LANGSMITH_API_KEY=$(grep ^LANGSMITH_API_KEY= .env | cut -d= -f2-) \
LANGSMITH_PROJECT=devops-incident-analyzer \
  langsmith-fetch traces /tmp/sio781 --limit 1 --include-metadata
```

Filter for the run-id above. The 11 tool errors and the parent sub-agent run name `agent.sub-agent` will show the full LLM ↔ tool ↔ proxy chain. For child-run granularity (per-tool latencies + the `-32010` body), pull via Python SDK — see `reference_langsmith_child_runs_via_sdk` memory.

### Synthetic reproduction (if needed)

To synthesise the burst on demand without the full agent:

```bash
# 1. Restart kafka-mcp proxy and let it sit idle for >5 minutes (AgentCore scale-down)
cd packages/mcp-server-kafka && bun --env-file=../../.env --hot src/index.ts
# Wait 6 minutes.

# 2. Fire 10 concurrent tool calls via the proxy /mcp endpoint
for i in $(seq 1 10); do
  curl -s -X POST -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/call\",\"params\":{\"name\":\"kafka_get_consumer_group_lag\",\"arguments\":{\"groupId\":\"test-cg\"}}}" \
    http://localhost:3000/mcp &
done
wait
```

Expect: most return `-32010` on first attempt; some recover after proxy retries; some give up after `gaveUpAfterMs: ~20–30s`.

## The investigation path

### Phase 1 — Confirm root cause from CloudWatch (do this FIRST)

The hypothesis is "AgentCore scale-to-zero after 2 min idle, then cold-start serialisation under burst." Confirm before designing mitigations.

```bash
# Assume into 399987695868 (the runtime account) — credentials must already be configured
# Pull the runtime's Init Duration / start timestamps across the 19:16–19:21 window

aws --profile <runtime-account> logs filter-log-events \
  --log-group-name /aws/bedrock-agentcore/runtimes/kafka_mcp_server-7RjmF16MqA \
  --start-time $(date -j -f "%Y-%m-%d %H:%M:%S" "2026-05-17 19:15:00" +%s)000 \
  --end-time   $(date -j -f "%Y-%m-%d %H:%M:%S" "2026-05-17 19:22:00" +%s)000 \
  --filter-pattern "Init Duration"
```

Look for:

1. Was the runtime cold at `19:19:03` first invocation? (`Init Duration` line ≈ that timestamp)
2. How long did the health check take? Compare `Init Duration` to the 17-second window between `19:19:16` (burst start) and `19:20:18` (first recovery).
3. Did the runtime container restart during the burst? (`SIGTERM`, `Restart`, or fresh request ID)
4. What does the `19:20:14` 502 look like upstream? (`-32010 (Received error (502) from runtime)` — the proxy got a 502 wrapped in a JSON-RPC envelope; could be runtime OOM, init-script failure, or AgentCore framework bug)

Expected outcome of Phase 1: either confirm the scale-to-zero hypothesis (`Init Duration` at `19:19:03`) and the burst hit during ongoing init, OR reveal a different failure mode (runtime kept alive but health check intermittent, container OOM during burst, etc.). The mitigation choice depends on which.

### Phase 2 — Pick mitigations based on Phase 1 findings

**If Phase 1 confirms scale-to-zero**: implement (1) keep-alive + (2) concurrency cap from the Linear ticket. Sequence:

1. Add keep-alive first (smaller, isolated). Test: idle the proxy 10 min, fire single tool call → expect `ok` first try, no `-32010` retries.
2. Then add concurrency cap. Test: synthetic 10-way burst (above) → expect ≤1 `-32010` end-to-end.

**If Phase 1 reveals a different cause** (e.g. intermittent health check, container OOM): mitigation may be different — possibly an AgentCore deployment-side fix (resource sizing, init-script optimisation), not a proxy/agent-side fix. Document findings and re-scope SIO-781.

### Phase 3 — Verification

After mitigations land:

```bash
# Restart kafka proxy, let it sit idle 6 min, fire the synthetic burst
# Expect: ≤1 -32010 in the response set
# Also: zero `gaveUpAfterMs` lines in the proxy log

cd packages/mcp-server-kafka && bun --env-file=../../.env --hot src/index.ts
sleep 360
# (run synthetic burst from "Reproduction" section)
```

End-to-end via the real agent:

```bash
# In apps/web (after letting the agent sit idle ≥5min):
# Fire the standard PIM-sink-DLQ replay query
# Expect: kafka sub-agent log shows `toolErrorCount: 0` (down from 11)
```

## Implementation sketches

These are STARTING POINTS for the fresh session — verify the code structure hasn't drifted before applying verbatim.

### Option 1 — Keep-alive ping in proxy

`packages/shared/src/agentcore-proxy.ts`, after the `Bun.serve({...})` block:

```ts
// SIO-781: warm-keep ping to prevent AgentCore scale-to-zero. tools/list is
// not billed; cheap enough to fire every 60s per proxy. Opt-in via env to
// keep cost predictable in low-traffic deployments.
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

`.env` addition:

```
KAFKA_AGENTCORE_KEEPALIVE_INTERVAL_MS=60000
AWS_AGENTCORE_KEEPALIVE_INTERVAL_MS=60000
```

Test fixture: mock `fetch` and assert the interval fires + signs the request with the correct method.

### Option 2 — Per-server concurrency cap

`packages/agent/src/mcp-bridge.ts`, near `toolsByServer` (line 144):

```ts
import { Semaphore } from "@some/sema-lib"; // or write a 20-line in-house semaphore
const concurrencyBySrv = new Map<string, Semaphore>();

function maxConcurrentFor(serverName: string): number {
    const envKey = serverName.toUpperCase().replace(/-/g, "_") + "_MAX_CONCURRENT_TOOLS";
    return Number(process.env[envKey] ?? "0") || Infinity;
}
```

Then wrap tool functions in `reconnectServer` (and the initial connect path):

```ts
const cap = maxConcurrentFor(name);
if (cap !== Infinity) {
    if (!concurrencyBySrv.has(name)) concurrencyBySrv.set(name, new Semaphore(cap));
    const sema = concurrencyBySrv.get(name)!;
    for (const tool of tools) {
        const origFunc = tool.func;
        tool.func = async (...args: unknown[]) => {
            await sema.acquire();
            try { return await origFunc(...args); }
            finally { sema.release(); }
        };
    }
}
```

Recommend `KAFKA_MCP_MAX_CONCURRENT_TOOLS=3` and `AWS_MCP_MAX_CONCURRENT_TOOLS=3` to start.

## Files to modify

| File | Change |
|---|---|
| `packages/shared/src/agentcore-proxy.ts` | Add keep-alive interval (~25 lines, behind opt-in env var) |
| `packages/shared/src/__tests__/agentcore-proxy.test.ts` (if exists) or new test file | Unit test the keep-alive: env var off → no timer; env var on → fetch called every N ms |
| `packages/agent/src/mcp-bridge.ts` | Add per-server semaphore wrapping tool funcs (~30 lines) |
| `packages/agent/src/__tests__/mcp-bridge-concurrency.test.ts` (new) | Test that with cap=2 and 5 parallel calls, only 2 run concurrently |
| `.env.example` | Document the new env vars |
| `CLAUDE.md` | Update env var table for the per-server tunables (mirror the existing pattern — see `reference_subagent_env_tunables`) |

Don't bundle the SIO-780 follow-up (agent-side 5s probe timeout) into this PR.

## Workflow

1. Branch off `main` (`8a900a1`): `git checkout -b simonowusupvh/sio-781-kafka-mcp-cold-start-under-burst`
2. Linear status: keep `Backlog` → move to `In Progress` when you start coding. **Never set to Done without user approval** (per CLAUDE.md).
3. One PR; reference SIO-781 in title and body.
4. Commit format: `SIO-781: <change>` with HEREDOC body. Trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
5. Verification block must include `bun run typecheck && bun run lint && bun run test` at minimum, plus the synthetic-burst reproduction from the "Phase 3 — Verification" section above.
6. PR description must show before/after `toolErrorCount` numbers from the synthetic burst — that's the acceptance criterion.

Commit template:

```
git commit -m "$(cat <<'EOF'
SIO-781: AgentCore proxy keep-alive + per-server tool concurrency cap

[1-paragraph description]

Verified: synthetic 10-way concurrent burst on a 6-minute-idle kafka
proxy. Before: 11 -32010 errors. After: 0 errors, all calls ok first try.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Keep-alive doubles AgentCore traffic | Low | `tools/list` isn't billed; only `tools/call`. 1 ping/min × 2 runtimes = 2880 free invocations/day. |
| Keep-alive masks real outages (always-warm = always-reachable in logs) | Medium | Log every keep-alive failure at `warn` level; existing /ready probe will still surface the real failure for the dashboard. |
| Concurrency cap throttles legitimate parallel queries | Medium | Make per-server cap configurable; default to `Infinity` (no cap) unless env var set. Start with `KAFKA_MCP_MAX_CONCURRENT_TOOLS=3` only. |
| Semaphore implementation correctness | Low | Use a battle-tested lib OR write a minimal one with explicit `release()` in `finally`. Add a unit test specifically for `release()` on thrown error. |
| AgentCore changes scale-to-zero default | Low | Document the assumption in the code comment so future-us can revisit. |
| `Init Duration` not exposed via CloudWatch (different metric path) | Medium | Phase 1 alternative: probe AgentCore's `/runtime/health` directly via SigV4; track first-call latency over time to infer cold-starts. |

## Out of scope

- The 5s agent-side `/ready` probe timeout mismatch (`mcp-bridge.ts:383`) — surfaces as `MCP server upstream degraded ... components: {}` dashboard warnings. Different code path, different timeout. Open separately if it becomes a UI problem.
- Cross-account VPC peering for Confluent-prd (`reference_network_ask_agentcore_to_confluent`).
- Sub-agent confidence scoring when tools fail — already covered by SIO-681's `enforceCorrelationsAggregate` (caps confidence at 0.6 when rules degraded).
- AWS sub-agent's identical exposure (it shares the SigV4 proxy + AgentCore pattern). Acceptance criteria here mention `AWS_MCP_MAX_CONCURRENT_TOOLS` already — if Phase 1 confirms scale-to-zero, the same fix applies to both proxies and should ship together.

## Related code references

- `packages/shared/src/agentcore-proxy.ts:230` — `classifyToolStatus` (existing SSE-aware parser, useful pattern reference)
- `packages/shared/src/agentcore-proxy.ts:430-505` — `doFetchWithTcpRetry` (the inner TCP retry loop, separate from JSON-RPC retry)
- `packages/shared/src/agentcore-proxy.ts:522-619` — outer JSON-RPC retry loop (where `-32010` is retried)
- `packages/shared/src/agentcore-proxy.ts:647-660` — existing `/health`, `/ping` routes (keep-alive lives near here)
- `packages/agent/src/mcp-bridge.ts:144-150` — `toolsByServer` registry (concurrency cap state lives here)
- `packages/agent/src/mcp-bridge.ts:417-455` — `reconnectServer` (where to inject the tool-func wrapper)
- `packages/agent/src/mcp-bridge.ts:381-401` — three-tier probe (out of scope but adjacent)
- `packages/agent/src/sub-agent.ts:464-493` — sub-agent fan-out (read for context; no changes needed here)
- AWS Bedrock AgentCore service contract: `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html` (URL appears in every `-32010` error message)

## Memory references

- `reference_agentcore_sse_response_shape` — `-32010` is the documented cold-start code; the 502 wrap is also documented here
- `reference_sio774_per_server_connect_timeouts` — kafka/aws already get 35s connect timeout for cold-start; this ticket extends the same logic to tool-call traffic
- `reference_kafka_mcp_agentcore_ksql_disabled` — current AgentCore deployment shape; ksql/connect/SR ARE registered in account 399987695868
- `reference_aws_iam_role_and_externalid` — cross-account context (LLM account `352896877281` ≠ runtime account `399987695868`)
- `reference_langsmith_child_runs_via_sdk` — needed for per-tool-call latency analysis in Phase 1
- `feedback_handover_doc_structure` — this doc follows the full structure (TL;DR + file:line refs + verification + risks + memory refs)
