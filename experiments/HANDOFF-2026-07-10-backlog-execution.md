# HANDOFF: 2026-07-10 backlog execution - SIO-1044..1047 + SIO-1050/1052 all shipped

- **Date**: 2026-07-10
- **Tickets shipped (all Done with user approval, all PRs squash-merged same day)**:
  - https://linear.app/siobytes/issue/SIO-1044 - record/replay factory rollout to 8 MCP servers (PR #330, main `2ae7e57`)
  - https://linear.app/siobytes/issue/SIO-1050 - elasticsearch_get_aliases prod regression, found during SIO-1044 planning (fixed inside PR #330)
  - https://linear.app/siobytes/issue/SIO-1045 - CI v2: blocking test job + hermetic test fixes (PR #331, main `0bb52d7`)
  - https://linear.app/siobytes/issue/SIO-1046 - gitagent-bridge prompt-overlay exports removed (PR #332, main `1862437`)
  - https://linear.app/siobytes/issue/SIO-1047 - fallow second batch (PR #333, main `d2e8e55`)
  - https://linear.app/siobytes/issue/SIO-1052 - couchbase docs:// resolution fix, found by SIO-1044's final review (PR #334, main `fb48e47`)
- **Repo state**: `main` @ `fb48e47`, clean tree, no open branches from this work. CI (all four jobs incl. Test) blocking and green.
- **Session ledger**: `.superpowers/sdd/progress.md` (git-ignored scratch) carries the full per-task commit trail.
- **Predecessor handover**: `experiments/HANDOFF-2026-07-09-optimisation-audit.md` (this session executed its entire follow-up backlog).

## TL;DR

The whole 2026-07-09 handover backlog is done: 5 PRs (#330-334) merged, 6 tickets Done, CI test job now blocking and green. Two production bugs were discovered and fixed along the way (SIO-1050: the record/replay recorder was blind to the legacy `server.tool` API, dropping `elasticsearch_get_aliases` from every replayed elastic server since PR #327; SIO-1052: couchbase `docs://` tools never resolved because the registry walk used field names that don't exist on SDK 1.29 internals). Fallow dead-code issues went 866 -> 721 and circular deps 6 -> 3 under a user-approved deletion batch. The hardest lesson of the session - Bun `mock.module` namespace live-binding poisoning, which defeated three CI-fix attempts before the value-snapshot pattern landed - is written to project memory. No work is left open from this stream; only un-ticketed follow-up candidates remain (below).

## Context - how this session ran

Continuation of the 2026-07-09 optimisation audit. Each ticket was executed as: plan (plan-mode with Explore/Plan agents for SIO-1044 only; the rest were fully specified in Linear), branch off main, subagent-driven development (implementer + task reviewer per task, final whole-branch review on the most capable model), PR ready-for-review, merge + Linear Done only on explicit user approval. Two AskUserQuestion gates were used: PR structure for SIO-1044 (user chose single PR) and the SIO-1047 deletion batch (user approved in full).

## What landed (key anchors on main @ fb48e47)

### SIO-1044 + SIO-1050 (PR #330)
- `packages/shared/src/cached-server-factory.ts` - records all SIX registration methods (`registerTool/registerResource/registerPrompt` + legacy `tool/resource/prompt`) in one ordered `{method, args}[]` log. SDK 1.29's sugar methods do NOT delegate to `register*` (each pair independently calls a private `_createRegistered*`), which is why the original 3-method recorder silently dropped legacy registrations (SIO-1050).
- Adoptions in aws, elastic-iac, knowledge-graph, atlassian, gitlab (SIO-703 once-flags deleted), kafka, konnect (`ToolPerformanceCollector`/`ElicitationOperations` hoisted to initDatasource - explicit process-global), couchbase (async playbook enumeration hoisted to `loadPlaybooks` in initDatasource; `registerAllResources` now sync; `readResourceByUri` double-assignment race removed; `playbook://` fast path restored by the final review after the race fix had canonicalized the broken implementation).
- 9 per-package `factory-replay.test.ts` files: replayed servers == directly-registered control server; this per-package coverage class is what the shared mechanism tests could never catch.

### SIO-1045 (PR #331) - CI v2
- apps/web mock stubs completed (union-of-mocks rule), `bunx svelte-kit sync` added to the web test script (cold checkouts lack the generated `.svelte-kit/tsconfig.json` that defines `$lib`), `continue-on-error` removed from the test job, `.bun-version` (1.3.14) pinned in all four jobs, and the agent memory-recall suites made order-independent via value-snapshot mock restores.
- The failure chain took 4 CI round-trips because three plausible fixes (report-file hermetic fixes, bun pin, victim-owned namespace mocks) each addressed a real but non-root cause. Root cause: `import * as ns` is a LIVE VIEW - a poison `mock.module` live-patches captured namespaces, so every "restore the real module" that re-registers the namespace restores the poison. See memory `reference_bun_mock_namespace_live_binding_poisoning`.

### SIO-1046 (PR #332)
- `buildAllToolPrompts`/`buildRelatedToolsMap` deleted (test-only after SIO-1043); `matchesPattern` kept module-level for its internal caller (tool-mapping.ts:31), removed from the public index surface, tests import the module directly.

### SIO-1047 (PR #333) - fallow second batch
- Fallow: total issues 866 -> 721; circular deps 6 -> 3 (nodes.ts<->reconcile.ts broken via new leaf `packages/agent/src/iac/mr-live-state.ts`; couchbase errors<->mcpErrors and the konnect enforcement-internal cycle closed as deletion byproducts).
- User-approved deletion batch: 42 files (konnect `src/enforcement/` island incl. its 4 tests - which also removes the SIO-1045-era CI-flaky elicitation tests permanently; couchbase legacy `lib/*` cluster; 2 aws scripts), 21 dead exports, 39 unexports. One triage gate miss (`syncWritesEnabled`) was caught by tests during execution and fully reverted.
- Refactors: enrich `get_policy_improved` cognitive 70->30, `execute_policy` 38->28; `throwZodValidationMcpError` helper (`packages/mcp-server-elastic/src/utils/toolErrorHandling.ts`) replaces 9 verbatim clone sites; 24 characterization tests for `extract-findings.ts` landed BEFORE any refactor touches it.

### SIO-1052 (PR #334)
- `docs://` fast path in couchbase `readResourceByUri` dispatching to the `DocumentationHandler` (returned up through `registerAllResources`), because the scoped docs resources are registered under literal placeholder names - a corrected walk alone could only serve the root URI. Generic fallback rewritten to mirror SDK 1.29's real dispatch (`_registeredResources` keyed by uri with `readCallback` + `enabled`; templates via `uriTemplate.match`). 4 positive-content regression tests through replayed servers.

## Gotchas discovered this session (read before touching adjacent code)

1. **SDK 1.29 sugar methods bypass `register*`** - any registration interceptor must patch all six methods; single ordered log preserves mixed-API replay order. Memory: `reference_sdk_sugar_methods_bypass_register`.
2. **Bun mock.module namespace live-binding poisoning** - restores must use value snapshots (`{...ns}`) captured in the pristine load phase; NO poison mocks at file scope anywhere in a package; victims re-claim in `beforeEach`. `mock.restore()` does not undo `mock.module()`. Memory: `reference_bun_mock_namespace_live_binding_poisoning`.
3. **CI-only failures usually mean local .env or macOS/Linux file order** - reproduce with `env -i HOME="$HOME" PATH="$PATH" bun test ...` and, for order bugs, Docker: `docker run --rm -v "$PWD":/repo -w /repo oven/bun:1.3.14 sh -c "bun install --frozen-lockfile && bun run --filter '<pkg>' test"`. The Docker repro is what finally proved the SIO-1045 fix pre-push.
4. **setup-bun@v2 installs latest by default** - the repo now pins via `.bun-version` (1.3.14) + `bun-version-file` in ci.yml. Keep it in sync with local upgrades.
5. **Cold-checkout web tests need `svelte-kit sync` first** - `$lib` lives in the generated `.svelte-kit/tsconfig.json`; the web `test` script now syncs (mirrors the typecheck script).
6. **Piped verification masks exit codes** - `bun run typecheck | tail -1` returns tail's exit code; SIO-1052's CI typecheck failure was locally invisible because of exactly this. Check exit codes unmasked (`cmd > /dev/null 2>&1; echo $?`).
7. **apps/web union-of-mocks rule** - any new export consumed (transitively) by web-test-imported modules must be added to ALL shared/agent mock blocks (6 sites). SIO-1044's knowledge-graph `createCachedServerFactory` import broke one web test post-merge until the stubs were widened.
8. **The elastic watcher/autoscaling/enrich/analytics tool families are feature-flagged off BY DESIGN** - fallow flags them as unused files (32 of the remaining 38); they were deliberately kept. Do not delete without a product decision.
9. **`gh pr checks` on a v1-era branch showed Test "fail" even on pass** - that artifact is gone now that continue-on-error is removed, but branches created before PR #331 need a main-merge to pick up CI v2.
10. **Konnect had TWO elicitation systems** - the deleted `enforcement/` island was superseded by `utils/simple-elicitation.ts`; the surviving surface is `src/utils/elicitation.ts` + `src/tools/elicitation-tool.ts` (covered by `tests/simple-elicitation.test.ts`).

## Un-ticketed follow-up candidates (create tickets before picking up)

- **Memoized tools/list installer** (SIO-1044 optional Phase 2): measure stateless tools/list p95 first via SIO-974 logs/OTEL; only pursue if serialization cost remains material.
- **apps/web shared mock-factory helper**: removes the 6-block union-of-mocks whack-a-mole (flagged by implementer, reviewer, and again post-merge).
- **Elastic remaining 29 Zod-catch clone instances** (ilm/indices/template/transform/search/watcher/ingest/document/alias/bulk/index_management/diagnostics) - same `throwZodValidationMcpError` treatment as the 9 done in SIO-1047.
- **3 remaining circular deps**: `aws-tool-estate-wrapper.ts <-> mcp-bridge.ts` (agent), `manifest-loader.ts <-> shared-merge.ts` (gitagent-bridge), `kong-api.ts <-> portal-api.ts` (konnect).
- **Konnect dual ElicitationOperations instances** (server datasource + module-level in the surviving elicitation code) - share underlying singletons; unification is cosmetic.
- **Couchbase scoped docs are placeholder-quality**: `DocumentationHandler.getScopeDocumentation/getCollectionDocumentation/getDocumentationFile` return canned placeholder text; a real fs-backed implementation is future work (SIO-1052 fixed resolution, not content depth).
- **Known pre-existing local flakes** (never reproduced on CI): shared `agentcore-proxy-roundtrip` ECONNRESET under parallel load; shared oauth `waitForOAuthCallback` under full-suite load; lbug/Kuzu teardown segfault (exit 133) in knowledge-graph full-suite runs. If CI ever shows them: rerun, don't revert.

## Verification (all green on main @ fb48e47)

```bash
bun run typecheck && bun run lint && bun run yaml:check
bun run test          # every package 0 fail (local full-run may exit 133 from the known lbug teardown segfault - tests still pass)
# CI: all four jobs blocking and green on the merge commits (runs linked from PRs #330-334)
```

Manual probes if needed: stateless replay smoke = boot any MCP server, `curl -X POST :<port>/mcp ... tools/list` three times, lists must be identical (catches template-only registrations); docs fix = `capella_list_documentation` with `CB_DOCUMENTATION_ENABLED`-style env set (see `packages/mcp-server-couchbase/src/config/loader.ts:87`) returns real scope listings.

## Workflow reminders

Branch off main per ticket (Linear suggests names); In Progress -> In Review with PR -> Done only with explicit user approval; PRs ready-for-review, never draft; `SIO-XXXX:` commit prefix; handover docs commit directly to main.

## Memory references

`reference_sdk_sugar_methods_bypass_register`, `reference_bun_mock_namespace_live_binding_poisoning`, `reference_optimisation_audit_2026_07` (predecessor session), `reference_prompt_context_mock_pollutes_direct_imports` (same bug family as the SIO-1045 saga), `reference_lbug_cypher_and_teardown_gotchas` (the exit-133 explanation), `reference_main_preexisting_test_lint_failures` (now largely obsolete - CI is blocking green; treat with suspicion).
