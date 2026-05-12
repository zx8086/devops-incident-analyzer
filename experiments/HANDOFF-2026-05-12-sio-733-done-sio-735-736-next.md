# Handoff: 2026-05-12 — SIO-733 done (PR #79); SIO-735 + SIO-736 next; SIO-716 still likely blocking deployment

## TL;DR

PR #79 (SIO-733 — AgentCore SigV4 round-trip integration test, 11 tests, ~290 LOC) merged this session. **SIO-725-734 pre-production hardening set is now 10/10 complete.** SIO-723 was already shipped in PR #70 but lingered as In Review; moved to Done this session. The two filed-during-SIO-731 follow-ups (SIO-735, SIO-736) remain Todo and are the next obvious picks. SIO-716 (AgentCore env-var fix from dev to prd Confluent endpoints) is still owned by another team; last-known AgentCore config is dev — verify before assuming it's done.

Previous handoffs (chronological): `HANDOFF-2026-05-11-sio-725-734.md` -> `HANDOFF-2026-05-12-kafka-mcp-phase-3-4.md` -> `HANDOFF-2026-05-12-kafka-mcp-sio-730-732-734.md` -> `HANDOFF-2026-05-12-sio-731-done-sio-733-remains.md` -> this one.

## What shipped this session

| PR | Tickets | What it does |
|----|---------|--------------|
| [#79](https://github.com/zx8086/devops-incident-analyzer/pull/79) | SIO-733 | End-to-end AgentCore SigV4 round-trip test. 11 tests across 3 describe blocks pin: SigV4 contract (URL, Authorization scope, signed-headers, x-amz-date, host); four SIO-718 inner-status states (ok, error(`<service> <code>`), jsonrpc-error, unparseable); retry semantics (ECONNRESET retry-then-success, retry-exhausted-502, TimeoutError-retryable, non-retryable-no-retry); mcp-session-id capture+replay. **+1427/-0 across 4 files** (1 production seam + 11 tests + spec + plan). Production change: single `clearCredentialCache()` export at `packages/shared/src/agentcore-proxy.ts:43-49`. All 11 tests deterministic, no real AWS network calls. |

Also moved to Done this session:
| Ticket | Why it shipped silently | PR |
|---|---|---|
| [SIO-723](https://linear.app/siobytes/issue/SIO-723) | Code merged 2026-05-11 in PR #70 alongside SIO-718; ticket left In Review by accident. User-approved Done transition this session. | [#70](https://github.com/zx8086/devops-incident-analyzer/pull/70) — `f52a518 SIO-718 + SIO-723: drop inner/outer proxy log; flag inferred Confluent groups` |

Net: **1 PR merged**, **2 Linear tickets moved to Done** (SIO-733 + SIO-723), **11 new tests** (159 → 170 in shared pkg; kafka unchanged at 283). Verification: typecheck clean across 12 packages; lint clean except pre-existing couchbase `mcp.d.ts:36` import-sort (carried since before this set).

## Remaining ticket status across all your asks

| ID | Title | Status | What's true | What's left |
|---|---|---|---|---|
| [SIO-723](https://linear.app/siobytes/issue/SIO-723) | Disclose inferred connect-/_confluent-ksql- groups | **Done** | Code merged 2026-05-11 in PR #70 (`f52a518`). Moved to Done this session. | Nothing. Closed. |
| [SIO-716](https://linear.app/siobytes/issue/SIO-716) | AgentCore Kafka MCP mis-pointed at dev Confluent endpoints | **Todo (Urgent)** | No PR, never started, owned by platform/shared-services team. Last-known AgentCore config (per memory, 2026-05-11): `KSQL_ENDPOINT=...dev.shared-services.eu.pvh.cloud` — i.e. still dev, still broken. **Not verified since.** | A platform-side env-var change on AgentCore runtime `kafka_mcp_server-sCQa486nea`. Once landed: redeploy, restart local SigV4 proxy, re-run c72 health prompt — `ksql_get_server_info` should return real JSON (not 503 HTML). |
| [SIO-735](https://linear.app/siobytes/issue/SIO-735) | Paginate `kafka_get_cluster_info` topic list | **Todo** | Filed 2026-05-12 00:08 UTC during SIO-731 planning. No work started. Unblocked. | Implementation. S-M effort (~50 LOC source + tests). **Recommended next pickup.** |
| [SIO-736](https://linear.app/siobytes/issue/SIO-736) | Paginate `restproxy_list_topics` (limit + prefix + offset) | **Todo** | Filed 2026-05-12 00:08 UTC during SIO-731 planning. No work started. Unblocked. | Implementation. M effort (~70 LOC source + ~130 LOC tests). Direct mirror of SIO-731 PR #78 in the REST Proxy path. |

## SIO-716 verification protocol (do this first if you're worried about deployment lag)

The honest state of SIO-716 is "last known: not fixed; no evidence it was fixed since." If the next session wants to confirm, here's the cheapest verification path:

1. Start the SigV4 proxy locally (per `feedback_probe_agentcore_via_sigv4_proxy`):
   ```bash
   AGENTCORE_RUNTIME_ARN=<arn> AGENTCORE_REGION=eu-central-1 \
     bun packages/shared/src/agentcore-proxy.ts &
   ```
2. Call `ksql_get_server_info` via tools/call through the proxy.
3. Interpret:
   - **200 with `ksqlServiceId`, `kafkaClusterId`, `version`** -> SIO-716 is done; move ticket to Done, update `reference_kafka_mcp_agentcore_ksql_disabled.md` memory.
   - **HTML 503 page** -> SIO-716 still pending; keep moving and check again next session.
4. If still 503: the platform team owns it. Don't try to fix from this side.

This entire check is < 2 minutes. Worth running at the top of any session that needs c72 production correctness.

## Next pickup: SIO-735 first, then SIO-736

### SIO-735 — paginate `kafka_get_cluster_info` topic list

Smaller of the two and has a clean binary design decision to make up front.

**Files:**
- `packages/mcp-server-kafka/src/services/kafka-service.ts:540-552` (`getClusterInfo` method — currently returns full topic list inline)
- `packages/mcp-server-kafka/src/tools/read/prompts.ts` (description update)
- `packages/mcp-server-kafka/tests/services/` (unit test update; check existing pattern in `kafka-service-list-topics.test.ts`)

**Two design options** (per the ticket's Scope section):
1. **Drop `topics` array entirely**, return only `topicCount`. Direct LLM to `kafka_list_topics` for names. Simplest, most aggressive — saves the most tokens but breaks any caller that depends on inline topic names.
2. **Inline first N (e.g. 20) topics** plus `topicCount` + `truncated: true`. Less aggressive, keeps a peek at the topic shape, still tokens-bounded.

**Recommended**: brainstorm before picking — check whether the agent currently uses the inline `topics` for anything (grep `topics` in `agents/incident-analyzer/agents/kafka-agent/` and `packages/agent/src/` to confirm). If nothing depends on it, option 1 wins. If something does, option 2 with N=20.

**Effort**: S-M (~50 LOC source + ~80 LOC tests).

**Probe c72 first** (per the SIO-731 lesson — c72 was 166 topics, not "thousands"): a quick `kafka_get_cluster_info` call against the local kafka-mcp server confirms what the production response actually looks like before designing the response shape. If c72 is unreachable, use `KAFKA_PROVIDER=local KAFKA_BOOTSTRAP_BROKERS=localhost:9092` and seed with `kafka_create_topic` to simulate.

### SIO-736 — paginate `restproxy_list_topics`

Direct mirror of SIO-731's PR #78 — design lifts verbatim, just into the REST Proxy service path.

**Files:**
- `packages/mcp-server-kafka/src/services/restproxy-service.ts:43` (extend existing `listTopics` or add `listTopicsPaged` — verify via grep for internal callers, same approach as SIO-731)
- `packages/mcp-server-kafka/src/tools/restproxy/parameters.ts` (extend `ListTopicsParams` with `prefix`, `limit` (1-500, default 100), `offset` (>=0, default 0))
- `packages/mcp-server-kafka/src/tools/restproxy/prompts.ts` (`RESTPROXY_LIST_TOPICS_DESCRIPTION` — preserve `[READ]` tag per SIO-730)
- `packages/mcp-server-kafka/src/tools/restproxy/operations.ts` (wire defaults)
- `packages/mcp-server-kafka/tests/services/` (mirror `kafka-service-list-topics.test.ts`, ~10 cases)

**Response shape**: same as SIO-731 — `{ topics, total, truncated, hint? }` with ASCII sort.

**Effort**: M (~70 LOC source + ~130 LOC tests).

**Cross-impact check** to do up front: when `KAFKA_PROVIDER=confluent`, does anything in `packages/agent/src/` (correlation rules especially) treat the REST Proxy `topics` shape as a flat array? If so, the response-shape change needs an aligned consumer-side update. Grep `restproxy_list_topics` and `restProxyListTopics` in the agent package first.

**Canaries to keep silent** (per SIO-730 + SIO-732 invariants):
- SIO-730 description-count canary: 55 tool descriptions in kafka MCP — extending an existing description does not change the count.
- SIO-732 registration-gating canaries: `restproxy_list_topics` is an ungated READ tool — no gate change needed.

### Could they ship as one PR?

The two are independent code paths (AdminClient vs REST Proxy) but share the design pattern. Bundling has marginal upside (one review cycle) and real downside (blast radius doubles; if one trips agent rule fixtures, both block). **Recommended: separate PRs.**

## Workflow that has now shipped 10 PRs (PRs #70-#79)

Unchanged from prior handoff. The process is stable enough to copy verbatim:

1. Pick the smallest unblocked ticket.
2. **Plan-mode first** for any non-trivial work — read touching files, write a spec to `docs/superpowers/specs/`, write a plan to `docs/superpowers/plans/`, get user approval. PR #79's branch carried the spec + plan as commits; that worked well for traceability.
3. Cut branch off `main` (naming: `sio-<NNN>-<short-slug>`).
4. Move Linear ticket to In Progress.
5. TDD-friendly step order; one task at a time via TaskCreate/TaskUpdate.
6. After every meaningful step: per-package `test` + `typecheck` + `lint` to fail fast.
7. Final verification: full repo `typecheck` + `lint` + tests in touched packages. **Manual end-to-end where feasible.**
8. Commit only on user "commit" signal. Stage files by name, not `git add -A`.
9. Push branch + `gh pr create`. PR body should include the wire-shape diff / config / test plan.
10. After merge: user confirms, mark Linear **Done**, sync `main`, delete merged local branch (`git fetch --prune` handles remote-tracking refs).

PR #79 used the subagent-driven-development skill for the first time across the whole 7-task plan — fresh subagent per task, two-stage review (spec compliance then code quality) per task. That pattern catches integration mistakes the per-task model misses; recommended for the next ticket if it's similarly multi-step.

## Dependencies and gotchas

- **AgentCore deployment still lags `main` by many PRs.** PRs #75 (`[READ]` tags), #76 (registration gating), #77 (ephemeral consumer cleanup tests), #78 (`kafka_list_topics` pagination), and now #79 (round-trip test) are all on `main` but the AgentCore-deployed Kafka MCP runtime version 3 was last refreshed 2026-05-11 16:32 UTC+2. Redeploy via `scripts/agentcore/deploy.sh` / `Dockerfile.agentcore`. **This is operational, not code work** — flag it whenever someone reports AgentCore-routed calls don't show the new behavior.
- **SIO-716 deployment-side blocker still live** (per the verification protocol above). When it lands, the c72 confidence ceiling rises from ~0.45 to ~0.78+ because ksqlDB/Connect/SR/RestProxy stop returning 503 against the dev pool.
- **Pre-existing couchbase lint error** at `packages/mcp-server-couchbase/src/types/mcp.d.ts:36`. Trivial one-line fix (import order: `Transport, JSONRPCMessage` -> `JSONRPCMessage, Transport`). On `main` across PRs #72-#79. Lint:fix attempts it automatically, so **revert it** if you don't want it in your PR — it's not your scope.
- **`bun --hot` doesn't re-resolve node_modules** (per `reference_bun_hot_does_not_reresolve_modules`). Full restart needed between dependency-affecting changes.
- **Pre-existing `KAFKA_TOOL_TIMEOUT_MS` missing from `numberPaths`** in `packages/mcp-server-kafka/src/config/loader.ts` (called out in 3 prior handoffs now). If you touch `loader.ts` for any reason, fix this drive-by.
- **Dependabot high-severity alert** on main (https://github.com/zx8086/devops-incident-analyzer/security/dependabot/1). Still untriaged. Surfaces on every push. Worth one focused look during a low-context moment.

## Out of scope (carried forward)

- **SIO-716** — owned by another team. Verify first per protocol above; otherwise carry forward again.
- **Pre-existing couchbase lint error** — see above.
- **`KAFKA_TOOL_TIMEOUT_MS` not in `loader.ts` numberPaths** — drive-by candidate.
- **Kafka MCP HTTP `/ping` endpoint doc inconsistency** in `docs/operations/observability.md`. Unrelated. Not in any current ticket.
- **Dependabot alert** — needs separate triage session.
- **Non-`tools/call` JSON-RPC methods (initialize, tools/list) through the proxy.** SIO-733's final reviewer flagged: the round-trip suite doesn't exercise these. Out of scope per spec (would have re-tested classifyToolStatus, already covered by SIO-718). File a follow-up only if MCP lifecycle logging is added.

## Memory references (load-bearing for SIO-735/SIO-736)

These memories under `~/.claude/projects/.../memory/` should be read at session start:

- `feedback_probe_agentcore_via_sigv4_proxy.md` — how to probe the live AgentCore MCP for ground truth (SIO-716 verification + SIO-735/736 c72-shape probe)
- `reference_kafka_mcp_agentcore_ksql_disabled.md` — current AgentCore tool registration state; **may be stale if SIO-716 lands between sessions**
- `feedback_handoff_docs_main_branch.md` — handover docs commit to main directly, no PR
- `feedback_linear_doc_syncs.md` — doc-only commits skip Linear ticket creation
- `feedback_never_create_linear_done.md` — never create issues directly in Done; In Review is the right state for retroactive tracking
- `reference_bun_hot_does_not_reresolve_modules.md` — full restart after `bun install`
- `reference_biome_type_before_value_imports.md` — type imports sort before value imports in multi-import blocks (came up in SIO-733 helper layout)

## Session summary (for the activity log)

- **1 PR shipped** (#79) — SIO-733 done; closes the SIO-725-734 audit set at 10/10
- **2 Linear tickets moved Todo/In Review -> Done** (SIO-733 + SIO-723; latter was already-merged backlog cleanup)
- **+1427/-0 LOC** across 4 files (1 prod seam + 11-test suite + spec + plan)
- **11 new tests, all green** (159 -> 170 in shared pkg)
- **0 Linear follow-up tickets filed** — SIO-733 was thorough enough; one optional follow-up (non-`tools/call` MCP method coverage) was flagged in PR #79 review but not filed
- **Subagent-driven-development skill used for the first time across a 7-task plan** — pattern worked well; two-stage review (spec compliance + code quality) caught two non-trivial issues mid-plan (Test 4 try/finally scope, missing `toHaveLength` guard). Recommended for next multi-task plans.
- **1 SIO-716 verification gap** — last-known AgentCore config still points at dev Confluent endpoints; no probe done this session. Next session should run the 2-minute protocol above before assuming.

Bigger arc: 10 PRs across 5 sessions for the SIO-725-734 set. **Set is fully closed.** Two extension tickets (SIO-735, SIO-736) and one carried-forward urgent (SIO-716) remain.

For next session — fresh start should:
1. Read this handover.
2. Read the four prior handovers if more historical context needed (chronological list at top of this file).
3. Run the SIO-716 verification protocol (2 minutes; updates one memory file either way).
4. Pick up **SIO-735** with a c72-shape probe first, then a brainstorm on the topics-array drop-vs-truncate design choice. Plan-mode workflow that shipped 10 PRs.
5. Then **SIO-736** as a direct SIO-731 PR #78 mirror.
