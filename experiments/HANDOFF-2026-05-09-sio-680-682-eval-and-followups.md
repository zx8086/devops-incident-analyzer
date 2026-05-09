# Handoff: SIO-680/682 LangSmith eval pipeline + follow-ups

**Date:** 2026-05-09
**Session theme:** Built the permanent agent eval pipeline, propagated description coverage across all 6 datasource YAMLs, fixed two real production bugs surfaced during verification, and filed 3 follow-up tickets for known issues that remain.

**Repo state on session close:** `main` at `797c2f2`, local + remote in sync. Working tree clean. No background processes. No temp files.

---

## Goals (start of session)

The session opened mid-flight on SIO-680/682 -- the kafka-introspect.yaml v2.0.0 work was already pushed at `c4d7f9b`. The user asked, in this rough order:

1. Sync the docs/ tree against the post-merge code.
2. Update kafka-introspect.yaml curated tools (became the v2.0.0 + sibling-YAML + cross-ref work).
3. Add per-action descriptions to the 5 sibling YAMLs.
4. Add the smoke-test as a permanent dev script (became a formal LangSmith eval pipeline).
5. Run the eval. Diagnose any issues.
6. Fix the underlying robustness gaps (MCP connect timeout).
7. File follow-up tickets for what's left.
8. Doc-sync the new eval pipeline into the operator-facing docs/ tree.

---

## What landed

Commits pushed today (chronological), all on `main`:

| SHA | Subject |
|---|---|
| `1701ef6` | doc-sync: post-merge state across CLAUDE.md / README / system-overview / mcp-integration / monorepo-structure / testing / getting-started (node count, kafka tool count, SIO-663/664 paragraphs) |
| `03e1c9d` | runbook hygiene: kafka-consumer-lag.md (add kafka_describe_cluster to tail, drop project_id from backticks) |
| `5e4242e` | runbook hygiene: msk-iam-permissions.md (add tail section) |
| `b2bf369` | schema: add optional `action_descriptions` to ToolMappingSchema with superRefine cross-field check + 3 tests |
| `1bb90b3` | follow-up: align action_descriptions superRefine with kafka schema style (drop "first .superRefine() in codebase" claim, switch to z.ZodIssueCode.custom) |
| `21378ea` | extractor: extract `formatActionCatalog` as pure helper for testing + 5 unit tests |
| `35fd8c1` | data: action_descriptions for all 12 kafka-introspect actions + coverage assertion (10/10 in test) |
| `d777ad6` | docs: action_descriptions field in docs/development/action-tool-maps.md |
| `3dd029a` | follow-up: tighten cloud_deployment description with billing cross-ref (smoke surfaced billing+cloud_deployment ambiguity) |
| `7546d01` | rename: kafka-introspect-coverage.test.ts → tool-yaml-coverage.test.ts |
| `c8b6396` | data: action_descriptions for all 5 sibling YAMLs (39 new descriptions across elastic/couchbase/konnect/gitlab/atlassian) |
| `e853fa5` | extend tool-yaml-coverage with parameterized 5-test second describe() block |
| `7767a51` | eval: precheck script + workspace wiring (eval:precheck) |
| `9406caf` | eval: dataset (5 incident queries) + uploader (eval:upload-dataset) |
| `3333a91` | eval: run-function + 3 evaluators + langsmith/openai deps |
| `ca77af6` | eval: entry point + README + workspace script (eval:agent) |
| `ae806d3` | bug fix: eval runAgent must initialize MCP client before invoking graph (Phase 1 root cause from systematic-debugging) |
| `8d8fb06` | robustness: add withTimeout helper to mcp-bridge for bounded connects + 3 tests |
| `34bb6fc` | robustness: wire withTimeout into mcp-bridge connect + reconnect call sites |
| `797c2f2` | doc-sync: LangSmith eval pipeline into docs/development/testing.md + docs/configuration/environment-variables.md + docs/operations/observability.md |

Plus 5 spec/plan documents in `docs/superpowers/{specs,plans}/`:
- `2026-05-08-action-descriptions-llm-steering-design.md` + plan
- `2026-05-09-sibling-yaml-action-descriptions-design.md` + plan
- `2026-05-09-langsmith-final-response-eval-design.md` + plan
- `2026-05-09-mcp-connect-timeout-design.md` + plan

---

## End-to-end verification result

Ran `bun run eval:agent` end-to-end on 2026-05-09. Experiment `agent-eval-postfix-34bb6fc-94f5e041` in LangSmith. **5/5 queries processed**, ~14 minutes wall-clock, ~$1-2 Bedrock cost.

The full graph executed for every query:
- 18 sub-agent invocations completed (across 5 queries × varying datasource targets)
- 1 sub-agent failure (Q4 elastic "input too long", recovered on retry)
- 5/5 aggregations + 5/5 validations passed
- 3/5 confidence checks passed (2 hit the 0.6 cap because gitlab was wholly unreachable)
- Q5 (kafka payments-ingest) was the cleanest: 12126-char synthesized answer, confidence 0.62, 5 mitigation steps

**The runAgent fix from `ae806d3` and the connect-timeout from `34bb6fc` together work.** The original "response = input query" bug from the first eval run is gone.

---

## Open issues filed today (in Linear backlog, Siobytes / DevOps Incident Analyzer)

| Ticket | Priority | Topic |
|---|---|---|
| **SIO-685** | High | GitLab MCP OAuth flow re-authorizes on every request — state not persisting (browser popups during eval verification) |
| **SIO-686** | Medium | Sub-agent "Input is too long" on first attempt — context bloat from unsplit tool result accumulation |
| **SIO-687** | Medium | LangSmith trace upload 422s — payload exceeds 25MB ingest limit |

SIO-686 ↔ SIO-687 are linked as Related (same upstream cause: unsplit tool result accumulation). Fixing 686 likely closes 687 transitively.

Each ticket has: verbatim log evidence, hypotheses to investigate, acceptance criteria, related-source-file pointers.

---

## Next steps (any order)

1. **Pick up SIO-685** (highest priority -- it actively interrupts work). The fix is likely in `packages/mcp-server-gitlab/src/` -- check whether the OAuth state cache exists and where it writes the token. Compare to `packages/mcp-server-atlassian/` which has a working OAuth flow.
2. **Pick up SIO-686 + SIO-687 together** (same root cause). Investigate `packages/agent/src/sub-agent.ts` ReAct loop for tool result accumulation. Likely fix: truncate tool outputs at 10KB before re-adding to message history with a `[truncated, N more chars]` marker.
3. **Re-run the eval after SIO-685 lands.** With gitlab reachable, expect 4/5 confidence checks instead of 3/5 (Q1, Q2, Q5 all expect gitlab).
4. **Add `OPENAI_API_KEY` to .env** -- already done by user post-session per their message. Next eval run will populate the response_quality column.
5. **Optional: add a 6th-8th query to the eval dataset** (the spec started at 5 per user direction; range was 5-8). Edit `packages/agent/src/eval/dataset.ts` and re-run `eval:upload-dataset`.

---

## Gotchas worth remembering

1. **The `langsmith evaluate()` overload-resolution issue** -- the LangSmith SDK's `evaluate()` function in `langsmith/evaluation` has an overload signature that TS can't narrow cleanly. The eval entry point (`packages/agent/src/eval/run-eval.ts`) uses `as any` with a `// biome-ignore lint/suspicious/noExplicitAny: SIO-680 - langsmith evaluate overload resolution` comment as a documented workaround.

2. **Bun + top-level await module marker** -- `precheck.ts` needs `export {};` for tsc to treat it as a module (top-level await requires module syntax). Don't remove it -- a Phase 1 spec reviewer flagged it as bloat but the implementer was right.

3. **`MultiServerMCPClient.getTools()` has no AbortSignal parameter** in `@langchain/mcp-adapters@1.1.3`. The `withTimeout` helper races against `AbortSignal.timeout(ms)` but doesn't actually cancel the in-flight HTTP request. Each timed-out connect leaks one promise. Documented as KNOWN LIMITATION in the helper's JSDoc; bounded by the 30s health-poll cycle.

4. **`runAgent` MUST call `ensureMcpConnected()` before `buildGraph()`** -- the graph itself doesn't bootstrap the MCP client. The eval pipeline learned this the hard way; the production path in `apps/web/src/lib/server/agent.ts:38-44` was always doing it correctly. Don't remove the `ensureMcpConnected()` call from `packages/agent/src/eval/run-function.ts`.

5. **Kafka MCP defaults to agentcore-proxy when `AGENTCORE_RUNTIME_ARN` is set** -- it'll try to bind port 3000 (already in use locally). To run kafka MCP in HTTP mode locally for the eval, override at spawn time: `AGENTCORE_RUNTIME_ARN= MCP_TRANSPORT=http MCP_PORT=9081 bun run --filter @devops-agent/mcp-server-kafka dev`. Even then it'll fail Zod validation without `msk.bootstrapBrokers` or `msk.clusterArn`. Easier path: rely on the agentcore deployment via `KAFKA_MCP_URL` in `.env` -- the connect-timeout fix from `34bb6fc` makes this safe even when kafka isn't reachable.

6. **GitLab MCP OAuth popups appear DURING eval runs** -- per SIO-685. Cancel them; the agent's alignment node correctly classifies them as non-retryable auth errors and the run continues.

7. **The eval's precheck script is localhost-only** -- it probes `localhost:9080`-`9085`. If any MCP servers run on remote hosts (e.g. AgentCore), the precheck will report them missing even though the actual MCP URLs in `.env` may work. Bypass with a temp script if needed (`packages/agent/src/eval-verify.ts` is the pattern, but always delete it after; never commit).

8. **Auto-memory files at `~/.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/`** include a `MEMORY.md` index plus per-topic memory files. Today's session reinforced the "doc/eval-infra syncs reuse originating ticket IDs" rule -- 4 commits today rode SIO-680/682 prefix without new Linear issues per the established pattern.

---

## What NOT to do in next session

- Don't try to fix SIO-685/686/687 with quick patches. Each one was filed with hypotheses to investigate, acceptance criteria, and source-file pointers -- the next session should run each through brainstorming → spec → plan as separate work, not bundle them together.
- Don't re-run the eval until SIO-685 (gitlab OAuth) is fixed. It'll just produce more browser popups and the same partial-confidence pattern.
- Don't change `packages/agent/src/eval/run-function.ts`'s ensureMcpConnected setup unless you understand exactly why it's there (see Gotcha 4).
- Don't remove the `as any` workaround in `packages/agent/src/eval/run-eval.ts` unless `@langchain/langsmith` ships a fix for the evaluate() overload issue. Verify by searching their changelog before ripping out the suppression.

---

## Files to read first in the next session

If you're picking up SIO-685: `packages/mcp-server-gitlab/src/index.ts`, `packages/mcp-server-atlassian/src/oauth/` for the working pattern.

If you're picking up SIO-686/687: `packages/agent/src/sub-agent.ts:114` (the tier-2 fallback that masks the bug), `packages/agent/src/langsmith.ts` (existing trace payload patches that don't fully cover the case).

If you're running the eval: `packages/agent/src/eval/README.md` (canonical procedure) + the new `docs/development/testing.md` Agent Eval section that landed in `797c2f2`.
