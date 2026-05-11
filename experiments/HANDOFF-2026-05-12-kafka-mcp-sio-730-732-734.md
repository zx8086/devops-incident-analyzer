# Handoff: 2026-05-12 — Kafka MCP Phase 3 done (SIO-730, SIO-732, SIO-734); SIO-731 + SIO-733 remain

## TL;DR

Phase 3 of the SIO-725-734 pre-production hardening set is **done and merged**. Three tickets shipped this session: SIO-730 (tool tag prefixes), SIO-732 (registration-time gating), SIO-734 (ephemeral consumer cleanup tests). Two tickets remain — SIO-731 (medium, `list_topics` pagination) and SIO-733 (large, AgentCore SigV4 round-trip integration test). Both are unblocked. Pick up SIO-731 next; it's the natural next step and stands alone.

Previous handoff (the trigger): `experiments/HANDOFF-2026-05-12-kafka-mcp-phase-3-4.md`. Original epic handoff: `experiments/HANDOFF-2026-05-11-sio-725-734.md`.

## What shipped this session

| PR | Tickets | What it does |
|----|---------|--------------|
| [#75](https://github.com/zx8086/devops-incident-analyzer/pull/75) | SIO-730 | Tag all 55 Kafka MCP tool descriptions with `[READ]` / `[WRITE]` / `[DESTRUCTIVE]` bracket prefixes so the LLM ranker picks scope-appropriate tools. New source-set lint test (`tests/tools/prompts-tags.test.ts`) enforces the invariant: every `*_DESCRIPTION` export must match `/^\[(READ\|WRITE\|DESTRUCTIVE)\] /`. 2 new tests, 55 prefixed strings across 8 prompts files. Distribution: 29 `[READ]` + 17 `[WRITE]` + 9 `[DESTRUCTIVE]`. |
| [#76](https://github.com/zx8086/devops-incident-analyzer/pull/76) | SIO-732 | Gate 9 mutating tools at registration time so they no longer appear in `tools/list` when their gate is off. Files touched: `write/tools.ts` (3 tools), `destructive/tools.ts` (2), `schema/tools.ts` (3 kafka_*), `ksql/tools.ts` (1). New registered-set test (`tests/tools/registered-gating.test.ts`, 6 tests) is the SIO-732 companion to SIO-730's source-set test — walks `server._registeredTools` for 3 config permutations asserting both the tag-regex invariant AND the gating-membership invariant. **Drive-by fix**: `registerWriteTools`/`registerDestructiveTools`/`registerKsqlTools` were calling `getConfig()` internally; now they take `config: AppConfig` as a parameter like the others. |
| [#77](https://github.com/zx8086/devops-incident-analyzer/pull/77) | SIO-734 | Tests-only PR locking the SIO-699 ephemeral-consumer cleanup invariant. The ticket asked for try/finally refactoring; SIO-699 already shipped the correct shape in both `consumeMessages` (kafka-service.ts:411-445) and `getMessageByOffset` (kafka-service.ts:724-767). The gap was test coverage for the throw paths. Added 4 tests proving `consumer.close()` fires when (a) `consume()` rejects, (b) the for-await iterator throws mid-stream — for both methods. **+124 LOC tests, 0 LOC source**. |

Net: **3 PRs merged**, **12 new tests** added (2 + 6 + 4), **all 3 Linear tickets moved Todo → Done**. Verification after every PR: 263 → 269 → 273 kafka tests passing, typecheck clean across all 12 packages, lint clean except the pre-existing couchbase issue.

## Remaining tickets (2)

| ID | Title | Priority | Effort | Audit | Status |
|---|---|---|---|---|---|
| [SIO-731](https://linear.app/siobytes/issue/SIO-731) | Paginate `list_topics` (limit + prefix + truncated marker) | Medium | M | D2 | Todo |
| [SIO-733](https://linear.app/siobytes/issue/SIO-733) | AgentCore SigV4 round-trip integration test | Medium | L | G1 | Todo |

## Suggested order for next session

**1. SIO-731 first.** Medium effort, standalone, touches the kafka-service signature plus prompt + parameter schema. The pickup is straightforward but **needs a c72 prod baseline probe before locking the default `limit`** — see "Open questions" below.

**2. SIO-733 last.** Largest single item in the remaining set (~250-350 LOC). Mock plumbing for the AgentCore SigV4 round-trip. Adds CI safety net but no user-visible behavior change. Ship standalone.

## Files of interest

### SIO-731 (paginate list_topics)
- `packages/mcp-server-kafka/src/services/kafka-service.ts:380` — `listTopics()` method (verify exact line; file has churned)
- `packages/mcp-server-kafka/src/tools/read/parameters.ts` — Zod schema for `list_topics`
- `packages/mcp-server-kafka/src/tools/read/prompts.ts:3` — `LIST_TOPICS_DESCRIPTION` (now starts with `[READ]`; preserve the prefix when editing per SIO-730's lint test)
- Tests: `packages/mcp-server-kafka/tests/services/` — multiple kafka-service test files; check existing list_topics coverage before writing new

### SIO-733 (AgentCore round-trip test)
- `packages/shared/src/agentcore-proxy.ts` — the production code under test (raw fetch + hand-rolled SigV4)
- `packages/shared/src/__tests__/agentcore-proxy-tool-status.test.ts` — existing inner-status mocking pattern (SIO-718). Use this as the template.
- **New file**: `packages/mcp-server-kafka/src/transport/__tests__/agentcore-roundtrip.test.ts`
- Mock the destination (`https://bedrock-agentcore.${region}.amazonaws.com/...`), NOT the SDK client — the proxy uses raw fetch.

## Verification commands

```bash
bun run typecheck                                           # exit 0 across all 12 packages
bun run lint                                                # exit 1, pre-existing couchbase issue only
bun run --filter '@devops-agent/mcp-server-kafka' test     # 273 pass after this session's work
bun run --filter '@devops-agent/shared' test                # if you touch shared (SIO-733)
bun run --filter '@devops-agent/agent' test                 # if you touch tool surfaces that rule fixtures depend on
```

End-to-end smoke pattern (worked for all three this-session PRs):

```bash
MCP_TRANSPORT=http MCP_PORT=9081 KAFKA_PROVIDER=local KAFKA_BOOTSTRAP_BROKERS=localhost:9092 \
  bun run --filter '@devops-agent/mcp-server-kafka' start
curl -sS -X POST http://127.0.0.1:9081/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

After SIO-731 lands: probe with the SigV4 proxy at `localhost:3000/mcp` (per `feedback_probe_agentcore_via_sigv4_proxy`) to confirm the new `limit`/`prefix`/`offset` params surface correctly in AgentCore's view.

## Workflow (proven across PRs #72-77)

This sequence shipped **six PRs in two days** without surprises:

1. Pick the smallest unblocked ticket.
2. **Plan-mode pass first** for non-trivial changes — read touching files, write plan to `~/.claude/plans/`, get user approval.
3. Cut branch off `main` (naming: `sio-<NNN>-<short-slug>`).
4. Move Linear ticket to **In Progress**.
5. TDD-friendly step order; one task at a time via TaskCreate/TaskUpdate.
6. After every meaningful step: per-package `test` + `typecheck` to fail fast.
7. Final verification: full repo `typecheck` + `lint` + tests in touched packages. **Manual end-to-end where feasible** — SIO-730 and SIO-732 smoke tests both confirmed wire-shape changes that unit tests alone wouldn't.
8. Commit only on user "commit" signal. Stage files by name, not `git add -A`.
9. Push branch + `gh pr create`. PR body should include the wire-shape diff / config / test plan.
10. After merge: user confirms, mark Linear **Done**, sync `main`, delete merged local branch.

The plan file at `~/.claude/plans/read-the-handover-and-sorted-giraffe.md` has been overwritten three times this session (SIO-730 → SIO-732 → would have been SIO-734 but SIO-734 was small enough to skip plan mode). It's a good template for what a fresh session should produce.

## Dependencies and gotchas

- **SIO-731 changes a tool signature.** Anyone calling `list_topics` from outside the agent (manual MCP debug, the SigV4 proxy bash one-liners per `feedback_probe_agentcore_via_sigv4_proxy`) needs to know about the new `limit`/`prefix`/`offset` params + the truncation marker. **Update that memory note when shipping.** Default `limit = 100` per the ticket is a guess; probe c72 first.
- **SIO-733 mock setup is non-trivial.** The proxy uses raw `fetch` + a hand-rolled SigV4 signer (not the AWS SDK). Mocking the **destination** is the right approach, not mocking an SDK client. SIO-718 added inner-status parsing tests — use that as the pattern.
- **SIO-730 lint test enforces 55 description count exactly.** If SIO-731 adds new descriptions (e.g. a `list_topics_truncated` companion tool — unlikely but possible), update the canary count in `tests/tools/prompts-tags.test.ts:55` AND the corresponding count in `tests/tools/registered-gating.test.ts`'s membership sets.
- **SIO-732 toolCount math lives in TWO places** that must stay in sync: `src/tools/index.ts` (logger line at the end of `registerAllTools`) and `src/index.ts` (the `onStarted` callback). Both were updated this session; touch both if the per-package tool counts change.
- **`bun --hot` doesn't re-resolve node_modules** (per `reference_bun_hot_does_not_reresolve_modules`). Full restart needed between dependency-affecting changes. N/A for this session's PRs (no dep changes), but watch for it in SIO-733 if any new dev-deps are needed for mocking.
- **Pre-existing couchbase lint error** at `packages/mcp-server-couchbase/src/types/mcp.d.ts:36` (import sort). On `main` since before this set. Flag if it ever blocks CI; otherwise ignore. Confirmed pre-existing across PRs #72-77.
- **Pre-existing `KAFKA_TOOL_TIMEOUT_MS` missing from `numberPaths`** in `packages/mcp-server-kafka/src/config/loader.ts` (called out in the prior handoff). If you touch `loader.ts` for any reason, fix this drive-by.

## Open questions

1. **`list_topics` baseline on c72 prod.** Default `limit = 100` is still a guess. Probe via the SigV4 proxy before locking the SIO-731 default — could be way too low if the cluster has thousands of small topics. The structured-error work in PRs #72-74 makes failure modes safe to probe.

## Out of scope (carried forward)

- **SIO-716** (env-var fix on AgentCore runtime) is owned by another team — Urgent / Todo in their backlog. Phase 1's structured-error work makes the agent resilient to the next misroute incident; SIO-716 itself fixes the misroute. Don't wait for it.
- **Pre-existing couchbase lint error** (`mcp-server-couchbase/src/types/mcp.d.ts:36` import sort). Not in this set's scope. Flag during a low-context moment.
- **Dependabot high-severity alert** on main (https://github.com/zx8086/devops-incident-analyzer/security/dependabot/1). Still untriaged. Flag during a low-context moment, not while picking up SIO-731.
- **`KAFKA_TOOL_TIMEOUT_MS` not in `loader.ts` numberPaths** (pre-existing oversight). Drive-by candidate.
- **Kafka MCP HTTP `/ping` endpoint** doc inconsistency in `docs/operations/observability.md`. Unrelated. Not in this set.

## Memory references (load-bearing for SIO-731 + SIO-733)

These memories under `~/.claude/projects/.../memory/` should be read at session start:

- `feedback_probe_agentcore_via_sigv4_proxy.md` — how to probe the live AgentCore MCP for ground truth during SIO-731 limit-tuning and SIO-733 mock validation
- `reference_kafka_mcp_agentcore_ksql_disabled.md` — current AgentCore tool registration state, useful for SIO-731 validation
- `reference_c72_msk_service_mapping.md` — c72 is production; use it as the SIO-731 baseline cluster
- `feedback_handoff_docs_main_branch.md` — this doc commits directly to main; no PR
- `reference_bun_hot_does_not_reresolve_modules.md` — full restart after `bun install`
- `feedback_never_create_linear_done.md` — never create issues directly in Done; use In Review for retroactive tracking
- `feedback_linear_doc_syncs.md` — doc-only commits skip Linear ticket creation
- `feedback_lead_with_infra_blockers.md` — surface missing dependencies as primary finding

## Session summary (for the activity log)

- **3 PRs shipped** (#75, #76, #77) — Phase 3 + part of Phase 4 of SIO-725-734 complete
- **3 Linear tickets moved Todo → Done** (SIO-730, SIO-732, SIO-734)
- **~600 LOC added** across the codebase (mostly tests; 320 source/test for SIO-732, 113 for SIO-730, 124 for SIO-734)
- **12 new tests, all green**
- **1 latent inconsistency caught and fixed** (registerWrite/Destructive/Ksql functions calling `getConfig()` internally instead of taking config as a parameter — exposed when SIO-732's gating broke the full-stack-tools.test.ts fixture)
- **1 scope reality-check** during SIO-734 (source already correct; tests-only PR was the right scope, not source refactoring)

Bigger arc: PRs #72-77 represent the full SIO-725-734 set minus SIO-731 and SIO-733. That's **8 of 10 tickets done across two sessions**.

For next session — fresh start should:
1. Read this handover (`HANDOFF-2026-05-12-kafka-mcp-sio-730-732-734.md`).
2. Read the prior two handovers if more historical context needed (`HANDOFF-2026-05-12-kafka-mcp-phase-3-4.md`, `HANDOFF-2026-05-11-sio-725-734.md`).
3. Pick up with **SIO-731** (paginate `list_topics`). Probe c72 via the SigV4 proxy first to lock the default `limit`.
