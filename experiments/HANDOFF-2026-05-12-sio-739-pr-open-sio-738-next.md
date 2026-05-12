# Handover — 2026-05-12 — SIO-739 merged, SIO-738 next

## TL;DR

SIO-739 (post-validate pipeline hang) shipped via PR #81 — squash-merged on `origin/main` as `3886990`. Smoke verification on `main` is the only step left before moving Linear to Done. SIO-738 (kafka sub-agent filter excludes `restproxy_*` / `connect_*`) hasn't been touched yet and is ready to pick up via the same `brainstorm → spec → plan → TDD` flow.

| Linear | State | Where it stands |
|---|---|---|
| [SIO-739](https://linear.app/siobytes/issue/SIO-739) | Merged (`3886990` on main), In Review until smoke passes | PR #81 — https://github.com/zx8086/devops-incident-analyzer/pull/81 |
| [SIO-738](https://linear.app/siobytes/issue/SIO-738) | Backlog | Untouched. Repro evidence below; pick up next. |

---

## SIO-739 — what shipped (PR #81, squash-merged as `3886990`)

### What the PR does

Adds a per-call wall-clock deadline to LLM `invoke` calls in `proposeMitigation` (Step 1 + Step 2) and `generateSuggestions`. When the deadline trips, the node soft-fails: empty mitigation steps / fallback follow-up suggestions, and appends `{node, reason}` to a new `partialFailures` state field. The SSE handler emits an additive `partial_failure` event so the frontend can surface "mitigation unavailable" later (no UI in this PR). The graph-level `AbortSignal.timeout(720s)` and `withFallbacks()` cascade are untouched — this PR is defence in depth.

### Design choices worth knowing

- **Per-role deadlines** (`packages/agent/src/llm.ts`): mitigation 120s, actionProposal 60s, followUp 60s. Everything else is `0` (no per-call timer; relies on the graph-level signal). Defaults are overridable per role via `AGENT_LLM_TIMEOUT_<SCREAMING_SNAKE_ROLE>_MS` (e.g. `AGENT_LLM_TIMEOUT_FOLLOW_UP_MS`, `AGENT_LLM_TIMEOUT_ACTION_PROPOSAL_MS`). Single-word roles use `MITIGATION` directly; multi-word roles get an underscore via `roleToEnvSegment`.
- **`DeadlineExceededError`** distinguishes a local-deadline trip from an external abort. The helper uses a private `AbortController` and checks `localController.signal.aborted` in the catch block — if the graph signal fired first, the local controller is NOT aborted, and the original AbortError rethrows unchanged so the existing graph-timeout path runs.
- **`partialFailures`** is an append-only state field on `AgentState` (`packages/agent/src/state.ts`). The reducer is `(prev, next) => [...prev, ...next]` with NO empty-reset (deliberately different from `dataSourceResults`). The "monotonic" semantic is pinned by a dedicated test.
- **SSE de-dup** uses `${node}:${reason}` keyed `Set<string>` scoped per-request inside the `ReadableStream.start(controller)` callback. Cannot leak across requests.
- **No frontend changes**. The new `partial_failure` event is additive; unknown event types are ignored by the existing SvelteKit client.

### Tests added (26 new)

- `packages/agent/src/llm.invoke-with-deadline.test.ts` (12 tests across 3 describe blocks — defaults, env getter, helper)
- `packages/agent/src/state-partial-failures.test.ts` (4 tests — default, append, monotonic, type)
- `packages/agent/src/mitigation.deadline.test.ts` (3 tests — both hang, succeed-then-hang, wall clock)
- `packages/agent/src/follow-up-generator.deadline.test.ts` (2 tests — hang, wall clock)
- `apps/web/src/routes/api/agent/stream/server.test.ts` (6 new tests in a SIO-739 describe block)

Pattern lesson: **mock at the `@langchain/aws` boundary, not `./llm.ts`**. The first attempt mocked `./llm.ts` with an async factory that re-imported the module — this deadlocked in Bun v1.3.13. The aggregator.test.ts pattern (`mock.module("@langchain/aws", () => ({ ChatBedrockConverse: class { withFallbacks() {return this;} bindTools() {return this;} async invoke(...) }}))`) is the right shape and is now used by both `mitigation.deadline.test.ts` and `follow-up-generator.deadline.test.ts`.

Second pattern lesson: **don't `mock.module("./action-tools/executor.ts", ...)`** to control `getAvailableActionTools()` output. The mock leaks across test files in a single `bun test` invocation and breaks `executor.test.ts`. Instead, set the env vars that drive `isSlackConfigured()` and `isLinearConfigured()`:

```ts
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_DEFAULT_CHANNEL = "#test";
process.env.LINEAR_API_KEY = "lin_api_test";
process.env.LINEAR_TEAM_ID = "test-team";
process.env.LINEAR_PROJECT_ID = "test-project";
```

The real `getAvailableActionTools()` then returns `["notify-slack", "create-ticket"]` and the env restore in `afterEach` cleans up.

### Verification status

Done in-session (fresh run):
- `bun run typecheck` — every package exits 0
- `bun run lint` — 0 violations (the 1 info is the pre-existing biome migrate notice)
- Agent package: 354 pass / 15 skip / 0 fail
- Web package: 33 pass / 0 fail
- All 26 new tests pass

**Smoke run NOT done — pending on `main`.** Requires:
1. `git pull` to fetch `3886990`.
2. Set `AGENT_LLM_TIMEOUT_MITIGATION_MS=2000` in `.env`.
3. Fully restart the web dev server (memory `reference_bun_hot_does_not_reresolve_modules.md` — `bun --hot` doesn't pick up dependency changes; full restart needed). Kafka MCP can keep running.
4. Run a real prompt through http://localhost:5173 that reaches `proposeMitigation`.
5. Open DevTools → Network → the `stream` request. Confirm the SSE stream emits a `partial_failure` event with `node: "proposeMitigation"` after ~2s, then a `done` event, and the full validated answer renders.
6. `LANGSMITH_API_KEY=<key> LANGSMITH_PROJECT=devops-incident-analyzer langsmith-fetch traces /tmp/traces --limit 1 --include-metadata` — confirm the `proposeMitigation` span duration ≤ 2.5s with a thrown `DeadlineExceededError`, not a 25-min hang.
7. Unset the env override and re-run the same prompt — confirm normal mitigation steps appear and no `partial_failure` event fires.

Move SIO-739 from In Review → Done only after those checks pass (CLAUDE.md rule: no Linear → Done without explicit user approval).

### Out of scope (NOT in PR #81)

- Frontend UI surface for `partial_failure` (badge / toast). Server emits; client ignores unknown events. Wire UI when product asks.
- Per-call deadlines for streaming roles (`aggregator`, `responder`) and the other non-streaming roles (`orchestrator`, `classifier`, `subAgent`, `entityExtractor`, `normalizer`, `runbookSelector`). They keep `0` in `ROLE_DEADLINES_MS` and rely on the 720s graph signal. Flipping a future entry is the entire fix when needed.
- Removing `withFallbacks()` from `createLlm`. Separate reliability story.
- SIO-738 — handled separately, see below.

### Branch hygiene

- `SIO-739-post-validate-llm-deadlines` is safe to delete locally and on origin once you confirm `main` has the merge (`git log origin/main --oneline | grep SIO-739`).
- All 11 in-progress commits were squash-merged into single commit `3886990` on `main`. The PR body is the canonical record of what shipped.
- Local `main` is at `3886990` (just pulled).

---

## SIO-738 — what's waiting

### The bug

Across 47 tool invocations in the kafka sub-agent during the 2026-05-12 12:00 UTC smoke run, **zero** were `restproxy_*` and **zero** were `connect_*` REST tools — even though `RESTPROXY_ENABLED=true` and `CONNECT_ENABLED=true` per memory `reference_kafka_mcp_agentcore_confluent_tools.md` (note: file is still on disk as `reference_kafka_mcp_agentcore_ksql_disabled.md` — pending rename; see "while you're here" below).

Earlier log line at 11:53:11:

```
Creating ReAct agent with tools {toolCount:25, totalTools:55, filtered:true}
```

The action-driven filter pared 55 tools down to 25, but excluded all `restproxy_*` and `connect_*` tools regardless of prompt content. The generated report claimed "Kafka Connect REST API not probed: no `connect_*` tool available" — that's wrong; the tools are registered server-side but filtered out client-side.

Acceptance criteria from the ticket:
- A query naming "REST Proxy" surfaces a `restproxy_*` probe in the agent's tool calls.
- A query naming "Connect" surfaces `connect_get_cluster_info` or `connect_list_connectors`.
- The Gaps section no longer claims these REST APIs are unavailable when they ARE registered.
- Non-REST-Proxy / non-Connect prompts still see the same 25-tool budget as today.

### Where to start

1. **`agents/incident-analyzer/agents/kafka-agent/tools/`** — the YAML tool catalogs and action mappings. Find which actions surface `restproxy_*` and `connect_*` tools. Likely the answer is "none."
2. **`packages/gitagent-bridge/`** — the prompt-to-action classifier. When a user prompt names "REST Proxy", does any action fire? Same for "Connect" / "Kafka Connect".
3. **Test fix candidate**: add a new action (e.g. `rest_proxy_health`, `connect_topology_probe`) whose tool list includes the relevant tools. Re-run the same smoke prompt and verify these tools appear in the trace.

### Follow the SIO-739 process exactly

The user explicitly asked for `brainstorm → spec → plan → TDD` for both tickets. Start with `superpowers:brainstorming`. Don't open SIO-738 implementation until the spec is committed and the plan file lists concrete tasks.

---

## "While you're here" carry-overs from the previous handoff

These were noted in `HANDOFF-2026-05-12-sio-738-sio-739.md` and still apply:

### 1. Memory file slug is stale

`/Users/Simon.Owusu@Tommy.com/.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/reference_kafka_mcp_agentcore_ksql_disabled.md`

The body documents enabled tools (since 2026-05-11) but the slug still says `_disabled`. Rename to something like `reference_kafka_mcp_agentcore_confluent_tools.md` and update the `MEMORY.md` index entry. 1-minute task — fold into the SIO-738 session if convenient.

### 2. 30s per-call AgentCore JSON-RPC deadline tight on cold starts

Already documented in the prior handoff; nothing changed this session. Module-scope constant `JSONRPC_RETRY_DEADLINE_MS = 30_000` in `packages/shared/src/agentcore-proxy.ts`. SIO-737 scoped env-var configuration out. Don't lift it pre-emptively — wait for evidence it bites.

### 3. New: SIO-739 per-role env vars

Once SIO-739 is merged, the operator surface has new env tunables. If you ever need to relax a per-call deadline live (e.g. mitigation legitimately takes 100s on a particular prompt and you want headroom), set:

```bash
AGENT_LLM_TIMEOUT_MITIGATION_MS=180000      # 3 minutes
AGENT_LLM_TIMEOUT_ACTION_PROPOSAL_MS=90000  # 1.5 minutes
AGENT_LLM_TIMEOUT_FOLLOW_UP_MS=60000        # 1 minute (default)
```

Don't ship these to prod without evidence — the defaults exist to bound the failure mode, not as a default-safe value.

### 4. New: konnect package has pre-existing test failures

When running `bun run test` workspace-wide, `mcp-server-konnect` reports `106 pass / 19 fail / 1 error`. The failures are integration tests hitting a real Kong API without `KONNECT_ACCESS_TOKEN` set locally. They pre-date SIO-739 (verified against `6b3156f` on main). Not a regression. If you want a clean `bun run test` for CI/local dev, that's a separate ticket — `packages/mcp-server-konnect/` needs its integration tests gated behind a "credentials present" check.

---

## Context for the next session

- **Run state**: nothing of mine running. The kafka-mcp PID from the previous session is whatever you have alive locally; `bun --hot` does NOT pick up node_modules changes (memory `reference_bun_hot_does_not_reresolve_modules.md`) — restart fully if you make dependency changes.
- **Branch state**: local `main` at `3886990` (SIO-739 squash-merged). `SIO-739-post-validate-llm-deadlines` is now mergeable to delete; the work lives on main.
- **Authoritative source for the run logs**: LangSmith project `devops-incident-analyzer`, requestId from this session's smoke (when you do it). Use `langsmith-fetch traces /tmp/traces --limit 5 --include-metadata` per the global CLAUDE.md pattern.
- **Linear**: SIO-739 is in "In Review" pending the smoke checks above; move to Done only after they pass. SIO-738 still in Backlog awaiting brainstorm.
- **Spec / plan docs** for SIO-739 live at:
  - `docs/superpowers/specs/2026-05-12-sio-739-post-validate-llm-deadlines-design.md`
  - `docs/superpowers/plans/2026-05-12-sio-739-post-validate-llm-deadlines.md`
- **Don't open SIO-738 without the brainstorming skill** — same rule as last time. Start with `superpowers:brainstorming`.
