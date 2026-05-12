# Handoff: 2026-05-12 — SIO-731 done (PR #78); SIO-733 is the last ticket in the SIO-725-734 set

## TL;DR

PR #78 (SIO-731 — `kafka_list_topics` pagination) merged this session. **9 of 10 tickets done** in the SIO-725-734 pre-production hardening set. Only **SIO-733** remains — the AgentCore SigV4 round-trip integration test. Two follow-up tickets were filed during SIO-731 planning (SIO-735, SIO-736) — both Todo, Medium, unblocked but **outside the original audit scope**. Pick up SIO-733 next to close the set.

Previous handoffs in chronological order: `HANDOFF-2026-05-11-sio-725-734.md` -> `HANDOFF-2026-05-12-kafka-mcp-phase-3-4.md` -> `HANDOFF-2026-05-12-kafka-mcp-sio-730-732-734.md` -> this one.

## What shipped this session

| PR | Tickets | What it does |
|----|---------|--------------|
| [#78](https://github.com/zx8086/devops-incident-analyzer/pull/78) | SIO-731 | Paginate `kafka_list_topics`. New `prefix` (case-sensitive startsWith), `limit` (1-500, default 100), `offset` (>=0, default 0) params. Response shape becomes `{ topics, total, truncated, hint? }` with ASCII sort for stable offsets. New sibling `KafkaService.listTopicsPaged()` method; existing `listTopics()` left untouched because `listDlqTopics()` at `kafka-service.ts:283` depends on the unbounded shape. **+203/-3 across 5 files** (73 source + 130 test). 10 new tests, all green. |

Plus two follow-up Linear tickets filed during planning (per user decision):

| Ticket | Title | Status | Priority |
|---|---|---|---|
| [SIO-735](https://linear.app/siobytes/issue/SIO-735) | Paginate `kafka_get_cluster_info` topic list | Todo | Medium |
| [SIO-736](https://linear.app/siobytes/issue/SIO-736) | Paginate `restproxy_list_topics` (limit + prefix + offset) | Todo | Medium |

Both linked to SIO-731 via `relatedTo`. Filed because the unbounded-response problem in `kafka_list_topics` exists in two sibling tools the agent also hits.

Net: **1 PR merged**, **2 follow-up tickets filed**, **10 new tests** (273 -> 283 in kafka pkg). Verification: typecheck clean across 12 packages; lint clean except the pre-existing couchbase `mcp.d.ts:36` import-sort (carried since before this set).

## Remaining ticket from the original SIO-725-734 set (1)

| ID | Title | Priority | Effort | Audit | Status |
|---|---|---|---|---|---|
| [SIO-733](https://linear.app/siobytes/issue/SIO-733) | AgentCore SigV4 round-trip integration test | Medium | L | G1 | Todo |

After SIO-733 the original audit set is complete. SIO-735/SIO-736 are extensions for follow-up sessions; they're not blocking and not part of the audit.

## SIO-733 pickup notes

### Goal

Add a CI-runnable integration test that exercises the full AgentCore SigV4 proxy path: tool registration -> proxy -> hand-rolled SigV4 signer -> destination at `https://bedrock-agentcore.${region}.amazonaws.com/...` -> response unwrapping. Currently the proxy has only inner-status tests (SIO-718's `agentcore-proxy-tool-status.test.ts`); the outer round-trip is uncovered.

### Files of interest

- `packages/shared/src/agentcore-proxy.ts` — production code under test. Uses **raw `fetch`** + hand-rolled SigV4 (not the AWS SDK).
- `packages/shared/src/__tests__/agentcore-proxy-tool-status.test.ts` — existing inner-status mocking pattern (SIO-718). **Template** for the new test.
- **New file**: `packages/mcp-server-kafka/src/transport/__tests__/agentcore-roundtrip.test.ts` (or under `packages/shared/src/__tests__/` if the test stays generic — pick based on scope).

### Mock strategy

**Mock the destination, not the SDK client.** The proxy bypasses the AWS SDK entirely. Stub `fetch` at the global level (or via Bun's `mock.module()`) so a request to `bedrock-agentcore.${region}.amazonaws.com/runtimes/${runtimeId}/invocations` returns a deterministic MCP-shaped response. Verify:

1. SigV4 signature headers (`Authorization`, `x-amz-date`, `x-amz-content-sha256`) are present and well-formed.
2. The proxy unwraps the AgentCore envelope correctly into a standard MCP JSON-RPC response.
3. Error paths: 4xx / 5xx / network failure / malformed envelope.
4. Region selection and runtime ID propagation match the configured values.

### Effort estimate

L (~250-350 LOC). Most of it is mock plumbing — the signer call and envelope unwrap logic are short, but you need fixtures for at least 4-5 response variants.

### Plan-mode-first recommendation

This one is large enough to warrant the EnterPlanMode workflow that shipped PRs #75/76/77/78 cleanly. Read `agentcore-proxy.ts` and the SIO-718 test file end-to-end first, then write the plan to `~/.claude/plans/`, then get user approval before branching.

## Verification commands (carried from prior handoff, still valid)

```bash
bun run typecheck                                          # exit 0 across all 12 packages
bun run lint                                                # exit 1, pre-existing couchbase issue at packages/mcp-server-couchbase/src/types/mcp.d.ts:36
bun run --filter '@devops-agent/mcp-server-kafka' test    # 283 pass (up from 273 pre-SIO-731)
bun run --filter '@devops-agent/shared' test               # if you touch shared (SIO-733)
bun run --filter '@devops-agent/agent' test                # if you touch tool surfaces that rule fixtures depend on
```

End-to-end smoke pattern (same as PRs #75-#78):

```bash
MCP_TRANSPORT=http MCP_PORT=9081 KAFKA_PROVIDER=local KAFKA_BOOTSTRAP_BROKERS=localhost:9092 \
  bun run --filter '@devops-agent/mcp-server-kafka' start
curl -sS -X POST http://127.0.0.1:9081/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

SigV4 probe at `localhost:3000/mcp` per `feedback_probe_agentcore_via_sigv4_proxy` — useful for SIO-733 to compare mocked envelope shape against production. **Note**: the AgentCore deployment still lags `main`. As of end-of-session: the deployed `kafka_list_topics` description has neither the `[READ]` tag (SIO-730 / PR #75) nor the new pagination params (SIO-731 / PR #78). A redeploy is needed before the agent can use either improvement against the live AgentCore endpoint.

## Workflow that has now shipped 9 PRs (PRs #70-#78)

Unchanged from prior handoff. Process is rock-solid:

1. Pick the smallest unblocked ticket.
2. **Plan-mode pass first** for non-trivial changes — read touching files, write plan to `~/.claude/plans/`, get user approval.
3. Cut branch off `main` (naming: `sio-<NNN>-<short-slug>`).
4. Move Linear ticket to **In Progress**.
5. TDD-friendly step order; one task at a time via TaskCreate/TaskUpdate.
6. After every meaningful step: per-package `test` + `typecheck` to fail fast.
7. Final verification: full repo `typecheck` + `lint` + tests in touched packages. **Manual end-to-end where feasible** — SIO-731's wire smoke via local HTTP MCP confirmed both the new schema and Zod validation.
8. Commit only on user "commit" signal. Stage files by name, not `git add -A`.
9. Push branch + `gh pr create`. PR body should include the wire-shape diff / config / test plan.
10. After merge: user confirms, mark Linear **Done**, sync `main`, delete merged local branch.

The plan file at `~/.claude/plans/cheerful-purring-quill.md` from this session is a clean template for SIO-733 to fork.

## Dependencies and gotchas

- **Probe production before committing to defaults.** The c72 probe before SIO-731 changed the response design (166 topics, not "thousands" — confirmed `limit=100` is right). For SIO-733, do the analogous SigV4-proxy probe of the live AgentCore endpoint's response envelope before designing the mock fixtures. Real envelopes have quirks unit tests can't predict.
- **AgentCore deployment lags `main` by multiple PRs.** As of EOS, the deployed Kafka MCP lacks SIO-730 (read tags) and SIO-731 (pagination). A redeploy is a separate operational step (`scripts/agentcore/deploy.sh` / `Dockerfile.agentcore`). Flag this if anyone asks why AgentCore-routed calls don't show the new behavior.
- **Pre-existing couchbase lint error** at `packages/mcp-server-couchbase/src/types/mcp.d.ts:36`. Trivial one-line fix (import order: `Transport, JSONRPCMessage` -> `JSONRPCMessage, Transport`). Has been on `main` across PRs #72-#78. Lint:fix attempts it automatically, so **revert it** if you don't want it in your PR — it's not your scope. Or pick it up as a standalone doc-style commit some day.
- **`bun --hot` doesn't re-resolve node_modules** (per `reference_bun_hot_does_not_reresolve_modules`). Full restart needed between dependency-affecting changes. N/A for this session's work (no dep changes). Probably N/A for SIO-733 unless the mock approach needs a new dev-dep.
- **Pre-existing `KAFKA_TOOL_TIMEOUT_MS` missing from `numberPaths`** in `packages/mcp-server-kafka/src/config/loader.ts` (called out in two prior handoffs now). If you touch `loader.ts` for any reason, fix this drive-by.
- **Dependabot high-severity alert** on main (https://github.com/zx8086/devops-incident-analyzer/security/dependabot/1). Still untriaged. Surfaces on every push. Flag during a low-context moment, not while picking up SIO-733.

## Out of scope (carried forward)

- **SIO-716** (env-var fix on AgentCore runtime) — still owned by another team; Urgent / Todo in their backlog.
- **Pre-existing couchbase lint error** — see above.
- **`KAFKA_TOOL_TIMEOUT_MS` not in `loader.ts` numberPaths** — drive-by candidate.
- **Kafka MCP HTTP `/ping` endpoint** doc inconsistency in `docs/operations/observability.md`. Unrelated. Not in this set.

## Memory references (load-bearing for SIO-733)

These memories under `~/.claude/projects/.../memory/` should be read at session start:

- `feedback_probe_agentcore_via_sigv4_proxy.md` — how to probe the live AgentCore MCP for ground truth during SIO-733 mock fixture design
- `reference_kafka_mcp_agentcore_ksql_disabled.md` — current AgentCore tool registration state; useful for cross-checking what the mock should support
- `feedback_handoff_docs_main_branch.md` — this doc commits directly to main; no PR
- `feedback_linear_doc_syncs.md` — doc-only commits skip Linear ticket creation
- `feedback_never_create_linear_done.md` — never create issues directly in Done; use In Review for retroactive tracking
- `reference_bun_hot_does_not_reresolve_modules.md` — full restart after `bun install`

## Session summary (for the activity log)

- **1 PR shipped** (#78) — SIO-731 in the bag; closes 9 of 10 in the SIO-725-734 set
- **1 Linear ticket moved Todo -> Done** (SIO-731)
- **2 Linear follow-up tickets filed** (SIO-735, SIO-736) — Todo, Medium, related to SIO-731, outside the original audit scope
- **+203/-3 LOC** across 5 files (73 source + 130 test + 1 prompt rewrite)
- **10 new tests, all green** (273 -> 283 in kafka pkg)
- **1 c72 probe done before planning** — 166 topics confirmed; top prefixes `T_` 79, `DLQ_` 39, `dead*` 13; informed the `limit=100`/`max=500` defaults
- **1 silent-regression caught in planning** — naive signature change to `listTopics()` would have broken `listDlqTopics()` at line 283. Switched to sibling-method approach (`listTopicsPaged()`) before writing any code.
- **1 scope-discipline call** — reverted Biome's auto-fix of the unrelated couchbase import-sort to keep PR #78 focused on SIO-731

Bigger arc: PRs #72-#78 represent the SIO-725-734 set minus only SIO-733. **9 of 10 done across three sessions**.

For next session — fresh start should:
1. Read this handover.
2. Read the three prior handovers if more historical context needed:
   - `HANDOFF-2026-05-12-kafka-mcp-sio-730-732-734.md`
   - `HANDOFF-2026-05-12-kafka-mcp-phase-3-4.md`
   - `HANDOFF-2026-05-11-sio-725-734.md`
3. Pick up with **SIO-733** (AgentCore SigV4 round-trip test). Probe the live AgentCore MCP via the SigV4 proxy first to inform mock fixture design.
4. After SIO-733 ships, the SIO-725-734 set is fully closed. Two extensions (SIO-735, SIO-736) remain available but are unbundled from the audit.
