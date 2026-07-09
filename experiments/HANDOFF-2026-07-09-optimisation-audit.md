# HANDOFF: 2026-07-09 optimisation audit - shipped work + follow-up backlog

- **Date**: 2026-07-09
- **Tickets shipped (all Done, merged same day)**:
  - https://linear.app/siobytes/issue/SIO-1040 - Bedrock prompt caching + generalized model tiering (PR #329, main `c7ba848`)
  - https://linear.app/siobytes/issue/SIO-1041 - MCP stateless record/replay server factory + async Pino (PR #327, main `78b7f07`)
  - https://linear.app/siobytes/issue/SIO-1042 - frontend markdown throttle + DOMPurify + keyed messages (PR #326, main `265e9a5`)
  - https://linear.app/siobytes/issue/SIO-1043 - dead code, tracing factory, persisted toolOutputs cap, CI v1 (PR #328, main `066b631`)
- **Follow-up tickets created (Backlog, fully specified in Linear)**:
  - https://linear.app/siobytes/issue/SIO-1044 - record/replay rollout to the remaining 8 MCP servers
  - https://linear.app/siobytes/issue/SIO-1045 - CI v2: env-gate live-API tests, flip test job to blocking
  - https://linear.app/siobytes/issue/SIO-1046 - remove unconsumed gitagent-bridge prompt-overlay exports
  - https://linear.app/siobytes/issue/SIO-1047 - fallow second batch (iac/nodes.ts cycle, konnect registry, elastic enrich complexity)
- **Repo state**: `main` @ `066b631`. No open branches from this work (feature branches deleted after squash-merge).
- **Audit plan (full findings + designs)**: `~/.claude/plans/are-there-any-optimisation-humble-liskov.md` (outside repo). Session ledger: `.superpowers/sdd/progress.md` (git-ignored scratch).

## TL;DR

Whole-repo optimisation audit -> 4 workstreams -> 4 PRs, all task-reviewed, merged, and verified green on main. What's done: prompt caching (live-verified: Bedrock cache write 3478 tokens -> read 3478 within 5m TTL), a record/replay MCP server factory on elastic (~35-40% p50 drop on stateless tools/list), the frontend O(n^2) markdown re-parse + a live XSS fixed, dead code removed, tracing consolidated, checkpointed toolOutputs capped, and the repo's first CI. What's next: the four backlog tickets above - each is self-contained in Linear. Gotchas hit are listed below; read them before touching the adjacent code.

## Context - how this work came to be

User asked "are there any optimisation best-practise opportunities for the current setup?" (2026-07-09). Audit fan-out (3 Explore agents + fallow 3.3.0) found the system already strong on Send-API fan-out, tool truncation, state pruning, and client singletons, but with four high-impact gaps. User selected all four for implementation; each became a Linear issue + PR executed via subagent-driven development in isolated worktrees.

## What landed (key code anchors on main @ 066b631)

### SIO-1040 prompt caching + tiering (packages/agent, packages/gitagent-bridge)
- `packages/agent/src/prompt-cache.ts` - `buildCachedSystemMessage(stable, volatile)` emits SystemMessage content blocks `[text, {cachePoint:{type:"default"}}, text]`; kill-switch `AGENT_PROMPT_CACHE_ENABLED` (default ON, "false" disables -> byte-identical plain string).
- Applied at `packages/agent/src/aggregator.ts:146` and `packages/agent/src/sub-agent.ts:462` (sub-agent = the dominant win: prefix + ~25 tool schemas re-sent up to 40 ReAct iterations).
- Stable/volatile split: `packages/agent/src/orchestrator-prompt-assembly.ts` (pure module, deliberately separate from prompt-context.ts - see mock-pollution gotcha) + `buildSystemPromptParts` in `packages/gitagent-bridge/src/skill-loader.ts`. Byte-identity invariant tests live next to the assembly module.
- Tiering: `packages/agent/src/llm.ts:160-183` - `TIERABLE_ROLES` + `AGENT_LLM_TIER_<ROLE>=light|standard` env overrides; `DEFAULT_LIGHTWEIGHT_ROLES` = classifier only (unchanged behavior).
- Live-verified: cache write 3478 -> read 3478 tokens (LangSmith runs `019f486e-8419-...`, `019f486e-8953-...`; see PR #329 comments).

### SIO-1041 record/replay + async Pino (packages/shared, packages/mcp-server-elastic)
- `packages/shared/src/cached-server-factory.ts:32` - records final registration triples once at boot (recorder patched onto the bare server BEFORE the package's own registerTool monkey-patch, so it becomes the patch's delegate), replays onto a fresh McpServer per stateless request. Elastic adoption at `packages/mcp-server-elastic/src/server.ts:315`.
- A server POOL was explicitly rejected: `handleRequest` returns the SSE Response immediately while tool results stream later through the single `_transport` slot - pooling risks cross-request leakage.
- Async Pino: `packages/shared/src/logger.ts:244` (`sync:false, minLength` batch, registry-guarded exit-hook flushSync + unref'd 5s interval). Prod/staging branch only.

### SIO-1042 frontend (apps/web)
- `apps/web/src/lib/markdown.ts:84` - `renderMarkdown` = marked -> DOMPurify (`ADD_ATTR:["target"]`), plus escape-at-source fixes (codespan was a LIVE XSS; link href/title; table align allowlist). New dep `dompurify` (user-approved).
- `MarkdownRenderer.svelte` - 120ms trailing-edge throttle ($state + $effect; `svelte-ignore state_referenced_locally` is intentional and documented in-file).
- Stable message ids (crypto.randomUUID) + keyed `{#each}` in `+page.svelte` (index kept - load-bearing).

### SIO-1043 hygiene + CI
- 9 dead files removed (couchbase lib/*, konnect session-manager, atlassian telemetry + tools barrel, agent prompt-overlay + trimmed test imports).
- `packages/shared/src/tracing/server-tracing-factory.ts` - `createServerTracing(...)`; all 6 server `utils/tracing.ts` are now thin shims.
- `packages/agent/src/sub-agent-truncate-tool-output.ts:51` `getSubAgentStateOutputCapBytes` (env `SUBAGENT_STATE_TOOL_OUTPUT_CAP_BYTES`, default 65536, "0" disables) applied at `packages/agent/src/sub-agent.ts:602` - caps persisted `toolOutputs[].rawJson` at creation; verified kafka/elastic extractors survive capping.
- `.github/workflows/ci.yml` - typecheck/lint/yaml-check blocking, test `continue-on-error` (v1).
- `biome.json` gained excludes: `!guides` (machine-local symlink committed to the repo, broken on CI runners) and `!docs/reference/agent-memory-openapi.json` (verbatim export, format churn).

## Gotchas discovered this session (read before touching adjacent code)

1. **CI test job shows a red X by design**: job-level `continue-on-error` passes the workflow but the check still displays "fail". Fixed properly by SIO-1045, not by tweaking the display.
2. **langsmith-fetch trace exports strip run token stats** - to read `cacheReadInputTokens`/`cacheWriteInputTokens`, hit the REST API directly: `GET https://api.smith.langchain.com/api/v1/runs/{run_id}` with `x-api-key`.
3. **DOMPurify has NO pass-through without a DOM** - `createDOMPurify()` never defines `sanitize` when `window.document` is absent; guard on `DOMPurify.isSupported` (already done in markdown.ts). "Degrades to pass-through" claims are false.
4. **Bedrock cache checkpoints below 1024 tokens (Sonnet) are silently ignored** - do NOT add cache points to short static prompts (responder/followUp/mitigation): +25% write premium, zero benefit.
5. **entityExtractor must stay on Sonnet** - Haiku eval verdict MIXED: 10/10 routing match when a UI datasource selection is present (override makes the model inert) but only 3/10 without; fewer toolActions (Jaccard 0.56); one JSON-parse fallback. Full analysis in PR #329 comments. Revisit only via a UI-selection-gated tier (code change) or a hardened prompt + re-eval.
6. **Recorder-before-monkey-patch ordering is load-bearing** in cached-server-factory adoptions (SIO-1044): install the recorder on the bare server first so the package's own registerTool wrapper binds it as delegate.
7. **@langchain/aws resolves to 1.3.7** (bun.lock), not the 0.1.15 a node_modules directory scan suggests - always check bun.lock for the resolved version.

## Verification (all run green on main @ 066b631 this session)

```bash
bun install                       # picks up dompurify on a stale checkout
bun run typecheck && bun run lint && bun run yaml:check
bun run --filter '@devops-agent/agent' test      # 1814 pass
bun run --filter '@devops-agent/shared' test     # 371 pass
# Known remaining red (pre-existing, tracked): apps/web 5 mock-isolation tests,
# SIO-863/864/865 suites - see SIO-1045 for the cleanup plan.
```

Manual probes if needed: prompt-cache live check = one incident query + follow-up within 5 min, then read the Bedrock child runs via the LangSmith REST API (gotcha 2); elastic stateless latency = 20-50x `curl -X POST :9080/mcp` tools/list timing.

## Out of scope / deliberately not done

- Prompt-cache extension to the elastic-iac graph prompts (`packages/agent/src/iac/nodes.ts` ~868/1236) and tool-list cache points - optional, un-ticketed, noted in PR #329.
- UI-selection-gated Haiku tier for entityExtractor - optional, un-ticketed (gotcha 5).
- Flipping any tiering default beyond classifier, or `AGENT_PROMPT_CACHE_ENABLED` rollout policy per environment - env decisions, not code.

## Workflow for the follow-up tickets

Branch off main per ticket (Linear suggests branch names), In Progress -> In Review with PR -> Done only with explicit user approval. Commit format `SIO-XXXX: message`; PRs ready-for-review, never draft; no direct pushes to main (handover docs excepted).

## Memory references

`reference_optimisation_audit_2026_07` (this session's full learnings incl. all of the gotchas above), `reference_prompt_context_mock_pollutes_direct_imports` (why orchestrator-prompt-assembly.ts is a separate module), `reference_main_preexisting_test_lint_failures` (CI test-job policy), `reference_fresh_worktree_no_workspace_symlinks` (worktree setup for follow-up work).
