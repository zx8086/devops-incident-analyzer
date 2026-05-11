# Handoff: 2026-05-12 — Kafka MCP pre-production hardening, Phases 3+4 (SIO-730 to SIO-734)

## TL;DR

Phases 1 and 2 of the SIO-725-734 pre-production hardening set are **done and merged**. Five tickets remain: three Phase 3 (LLM signal quality) and two Phase 4 (hardening backlog). All five are unblocked. Pick up with **SIO-730** (smallest, ~80 LOC cosmetic change) — it's the lowest-risk re-entry into the codebase after the bigger Phase 1/2 changes, and SIO-732's lint test naturally piggybacks on its work.

Previous handoff (the trigger for all this work): `experiments/HANDOFF-2026-05-11-sio-725-734.md`. Audit (private, reference only): `~/.claude/plans/can-we-check-the-functional-flurry.md`.

## What shipped in this two-day arc

| PR | Tickets | What it does |
|----|---------|--------------|
| [#72](https://github.com/zx8086/devops-incident-analyzer/pull/72) | SIO-725 + SIO-728 + SIO-729 | Structured upstream errors for the 4 Confluent services. `fetchUpstream()` helper + `KafkaToolError` widened with `hostname` / `upstreamContentType` / `statusCode`. `---STRUCTURED---` sentinel wire format carries these from MCP to agent. `findConfluent5xxToolErrors` prefers structured fields with regex fallback. 30 new tests. |
| [#73](https://github.com/zx8086/devops-incident-analyzer/pull/73) | SIO-726 | `/ready` endpoint reflecting upstream reachability. Single-value 30s TTL cache with thundering-herd guard. Probes kafka broker via `withAdmin(a => a.metadata({}))` plus the 4 HTTP services via `probeReachability`. Components map: `ok` / `unreachable` / `disabled`. 16 new tests. |
| [#74](https://github.com/zx8086/devops-incident-analyzer/pull/74) | SIO-727 | Graceful shutdown drain on SIGTERM. Hybrid: Bun-native `server.stop()` drain + `shuttingDown` gate for clean JSON-RPC 503 envelope on racing requests. 25s default deadline, tunable via `SHUTDOWN_DRAIN_TIMEOUT_MS`. Bug caught + fixed: env var coercion missing for the new field. 15 new tests + verified manually (28ms drain on real Bun.serve). |

Net: 61 new tests, 3 PRs, all merged into main, all SIO-725 to SIO-729 Done in Linear. SIO-716 (env-var fix on AgentCore runtime) is still owned by another team — independent of this work.

## Remaining tickets (5)

| ID | Title | Priority | Effort | Audit | Status |
|---|---|---|---|---|---|
| [SIO-730](https://linear.app/siobytes/issue/SIO-730) | Tag tool descriptions with `[READ]` / `[WRITE]` / `[DESTRUCTIVE]` | Medium | S | D1 | Todo |
| [SIO-731](https://linear.app/siobytes/issue/SIO-731) | Paginate `list_topics` (limit + prefix + truncated marker) | Medium | M | D2 | Todo |
| [SIO-732](https://linear.app/siobytes/issue/SIO-732) | Gate destructive tools at registration time | Medium | S | A2 | Todo |
| [SIO-733](https://linear.app/siobytes/issue/SIO-733) | AgentCore SigV4 round-trip integration test | Medium | L | G1 | Todo |
| [SIO-734](https://linear.app/siobytes/issue/SIO-734) | Ephemeral consumer cleanup in `finally` | Low | S | A3 | Todo |

## Suggested execution order

### Phase 3 — LLM signal quality (one PR or split, judgment call)

**1. SIO-730 first.** Cosmetic prefix change across ~6 prompt files. The most valuable side-effect is that it gives SIO-732 a natural lint test: "every registered tool description must start with `[READ]|[WRITE]|[DESTRUCTIVE]`." If SIO-730 lands first, SIO-732's test cost drops.

**2. SIO-732 second** (small dep on SIO-730). Move destructive-tool gating from call-time (in `wrap.ts`) to registration-time (in `tools/index.ts`). The wrap-layer check stays as belt-and-braces. Add a unit test that asserts `server.listTools()` reflects `allowDestructive` config.

**3. SIO-731 third.** Bigger than the other two — touches the kafka-service signature plus prompt + parameter schema. Stands alone; ship whenever.

Phase 3 verification at the end: agent transcript test ("list all topics") — the model should pick `[READ] list_topics` over `[WRITE] create_topic`, and on a 500-topic cluster the response should be truncated to 100 with a `truncated: true` marker.

### Phase 4 — Hardening backlog

**4. SIO-734.** Small (~30 LOC source). Wrap the ephemeral-consumer code paths in `kafka-service.ts` (around lines 399-448 and 714-767 per the ticket — **verify ranges before editing**, file has grown since the audit) in `try { ... } finally { await consumer.close().catch(noop); }`. Test: simulate timeout mid-consume, assert `consumer.close()` was called.

**5. SIO-733 last.** The big one — L effort (~250-350 LOC). New `agentcore-roundtrip.test.ts` mocking `BedrockAgentRuntimeClient`. Don't bundle with anything else; this is the largest single item in the remaining set. Adds CI safety net for AgentCore-side regressions but doesn't ship user-visible behaviour.

## Dependencies and gotchas

- **SIO-732 depends on SIO-730** for the lint-test piggyback. If you ship SIO-732 first, you'll write the lint test against the source set (which is fine — just less elegant than asserting against the registered set after the tag prefix lands).
- **SIO-731 changes a tool signature.** Anyone calling `list_topics` from outside the agent (manual MCP debug, the SigV4 proxy bash one-liners per `feedback_probe_agentcore_via_sigv4_proxy`) needs to know about the new `limit`/`prefix`/`offset` params + the truncation marker. **Update that memory note when shipping.** Default `limit = 100` per the ticket; the original handover called out the open question "what's the actual topic count on c72 prod?" — the value is still a guess. Probe c72 (via the SigV4 proxy at `localhost:3000/mcp`) before locking the default.
- **SIO-734 line ranges have moved.** The ticket cites `kafka-service.ts:399-448` and `714-767`. Re-grep for `mcp-consume-` and `mcp-seek-` prefixes to find the current sites; the file has had churn since the audit.
- **SIO-733 mock setup is non-trivial.** The proxy at `packages/shared/src/agentcore-proxy.ts` uses raw `fetch` + a hand-rolled SigV4 signer (not the AWS SDK). Mocking the **destination** (`https://bedrock-agentcore.${region}.amazonaws.com/...`) is the right approach, not mocking an SDK client. SIO-718 added inner-status parsing tests in `packages/shared/src/__tests__/agentcore-proxy-tool-status.test.ts` — use that as the pattern.
- **`bun --hot` doesn't re-resolve node_modules** (per `reference_bun_hot_does_not_reresolve_modules`). Full restart after any dependency-affecting change.
- **The pre-existing lint error** in `packages/mcp-server-couchbase/src/types/mcp.d.ts:36` (import sort) is on `main` and will appear in every `bun run lint` run. Not yours to fix in this set — flag if it ever blocks CI, but otherwise ignore. Confirmed pre-existing via `git stash` during PR #73 and #74 verification.
- **`KAFKA_TOOL_TIMEOUT_MS` is missing from `numberPaths`** in `packages/mcp-server-kafka/src/config/loader.ts` (pre-existing oversight, found while fixing the same bug for `SHUTDOWN_DRAIN_TIMEOUT_MS` in PR #74). If you touch `loader.ts` for any reason, fix this drive-by.

## Files of interest (verify line numbers before editing)

### SIO-730 (tag prefixes)
- `packages/mcp-server-kafka/src/tools/read/prompts.ts`
- `packages/mcp-server-kafka/src/tools/read/prompts-extended.ts`
- `packages/mcp-server-kafka/src/tools/write/prompts.ts`
- `packages/mcp-server-kafka/src/tools/restproxy/prompts.ts`
- `packages/mcp-server-kafka/src/tools/schema/prompts.ts`
- `packages/mcp-server-kafka/src/tools/ksql/` (any `prompts.ts` files; check `tools/ksql/` subdir)
- `packages/mcp-server-kafka/src/tools/destructive/prompts.ts` (if it exists — destructive tools may live elsewhere)

### SIO-731 (paginate list_topics)
- `packages/mcp-server-kafka/src/services/kafka-service.ts` — `listTopics()` method
- `packages/mcp-server-kafka/src/tools/read/parameters.ts` — Zod schema for `list_topics`
- `packages/mcp-server-kafka/src/tools/read/prompts.ts` — description
- Tests: `packages/mcp-server-kafka/tests/services/kafka-service*.test.ts` (currently three files for kafka-service)

### SIO-732 (registration-time gate)
- `packages/mcp-server-kafka/src/tools/index.ts` — `registerAllTools()` and callees
- `packages/mcp-server-kafka/src/tools/destructive/tools.ts` (verify path; this is the registration entry point for destructive ops)
- `packages/mcp-server-kafka/src/tools/wrap.ts` — leave the existing check as belt-and-braces, don't remove
- `packages/mcp-server-kafka/src/index.ts:177-193` — toolCount calculation; update if registration changes

### SIO-733 (AgentCore round-trip test)
- `packages/shared/src/agentcore-proxy.ts` — the production code under test (raw fetch + SigV4)
- `packages/shared/src/__tests__/agentcore-proxy-tool-status.test.ts` — existing pattern for inner-status mocking (SIO-718)
- **New file**: `packages/mcp-server-kafka/src/transport/__tests__/agentcore-roundtrip.test.ts`

### SIO-734 (ephemeral consumer cleanup)
- `packages/mcp-server-kafka/src/services/kafka-service.ts` — grep for `mcp-consume-` and `mcp-seek-`; ranges have moved since the audit

## Verification commands

```bash
bun run typecheck                                           # exit 0 across all 12 packages
bun run lint                                                # exit 1, but only the pre-existing couchbase issue -- confirm no NEW errors
bun run --filter '@devops-agent/mcp-server-kafka' test
bun run --filter '@devops-agent/shared' test                # if you touch shared (SIO-733)
bun run --filter '@devops-agent/agent' test                 # if you touch tool surfaces that rule fixtures depend on
```

End-to-end smoke after each PR (per the established pattern):

```bash
MCP_TRANSPORT=http MCP_PORT=9081 KAFKA_PROVIDER=local KAFKA_BOOTSTRAP_BROKERS=localhost:9092 \
  bun run --filter '@devops-agent/mcp-server-kafka' start
curl -sS http://127.0.0.1:9081/health    # 200
curl -sS http://127.0.0.1:9081/ready     # 503 + structured snapshot (no broker)
```

For SIO-730 specifically: send a manual MCP `tools/list` request via the SigV4 proxy at `localhost:3000/mcp` (per `feedback_probe_agentcore_via_sigv4_proxy`) and confirm every description starts with one of the three tags.

## Workflow (proven across PRs #72-74)

This sequence shipped three PRs in two days without surprises:

1. Pick the smallest unblocked ticket.
2. **Plan-mode pass first** — read the touching files, write a plan to `~/.claude/plans/`, get user approval before coding.
3. Cut branch off `main` (naming: `sio-<NNN>-<short-slug>`).
4. Move Linear ticket to **In Progress**.
5. TDD-friendly step order from the plan; one task at a time via TaskCreate/TaskUpdate.
6. After every step: per-package `test` + `typecheck` to fail fast.
7. Final verification: full repo `typecheck` + `lint` + tests in touched packages. **Manual end-to-end where feasible** — the SIO-727 verification caught a real bug (env-var coercion) that unit tests didn't.
8. Commit only on user "commit" signal. Stage files by name, not `git add -A`.
9. Push branch + `gh pr create`. PR body should include the wire-shape / config / acceptance checklist.
10. After merge: user confirms, mark Linear **Done**, sync `main`.

The plan files at `~/.claude/plans/the-handover-has-concurrent-riddle.md`, `sio-726-ready-endpoint.md`, `sio-727-graceful-shutdown-drain.md` are good templates for what a fresh session should produce before coding.

## Open questions

1. **`list_topics` baseline on c72 prod.** Default `limit = 100` is a guess — could be way too low if the cluster has thousands of small topics. Probe via the SigV4 proxy before locking the SIO-731 default.

## Out of scope for this set

- **SIO-716** (env-var fix on AgentCore runtime) is owned by another team — Urgent / Todo in their backlog. Phase 1's structured-error work makes the agent resilient to the next misroute incident; SIO-716 itself fixes the misroute. Don't wait for it.
- **The pre-existing couchbase lint error** (`mcp-server-couchbase/src/types/mcp.d.ts:36` import sort). On `main` since at least the SIO-725 push. Not in this set's scope.
- **Dependabot high-severity alert** on main (https://github.com/zx8086/devops-incident-analyzer/security/dependabot/1). Untriaged; flag during a low-context moment, not while picking up this work.
- **Kafka MCP HTTP `/ping` endpoint.** Mentioned in `docs/operations/observability.md` but only exists in the AgentCore transport (`packages/shared/src/transport/agentcore.ts:57`). If a reviewer asks during SIO-730/732 PR review, that's an unrelated doc inconsistency, not something to fix in this set.

## Memory references (load-bearing for this work)

These memories under `~/.claude/projects/.../memory/` should be read before starting:

- `feedback_probe_agentcore_via_sigv4_proxy.md` — how to probe the live AgentCore MCP for ground truth during SIO-731 limit-tuning and SIO-733 mock validation
- `reference_kafka_mcp_agentcore_ksql_disabled.md` — current AgentCore tool registration state, useful for SIO-732 testing
- `reference_c72_msk_service_mapping.md` — c72 is production; use it as the SIO-731 baseline cluster
- `feedback_handoff_docs_main_branch.md` — handoff docs commit directly to main; this doc included
- `reference_bun_hot_does_not_reresolve_modules.md` — full restart after `bun install`
- `feedback_never_create_linear_done.md` — never create issues directly in Done; use In Review for retroactive tracking
- `feedback_linear_doc_syncs.md` — doc-only commits skip Linear ticket creation
- `feedback_lead_with_infra_blockers.md` — surface missing dependencies as the primary finding when investigating
