# Handover — End of session 2026-05-16

**Date:** 2026-05-16
**Repo state:** `main` at `c7a9947` (SIO-771/772 just merged as PR #104)
**Branch:** on `main`, clean of all session work; only longstanding unrelated WIP remains in the working tree
**Open Linear queue for project "DevOps Incident Analyzer":** 3 Backlog tickets, 0 Todo, 0 In Progress

This handover wraps a productive session (3 PRs merged, all 5 originally-dormant SIO-764 correlation rules activated) and queues up the next session with clean pickup points. Read this first; you don't need to re-read the prior conversation.

---

## TL;DR

Today's work closed the entire SIO-764 dormant-rule cleanup epic by activating 4 of the 5 dormant rules (kafka-empty-or-dead-groups, kafka-significant-lag, and kafka-dlq-growth were already wired by SIO-770/769; gitlab-deploy-vs-datastore-runtime activated today via SIO-771+772). Plus an upstream fix to the kafka extractor pattern (Zod conversion). Backlog now has no urgent tickets; SIO-591 (CI/CD, High, 2pts) and SIO-579 (Teams webhook, Medium, 2pts) are the next substantive features. Both need brainstorming + spec + plan before implementation. SIO-773 (Phase C extractors tracker) is intentionally a "wait for a real consumer" deferral.

Working tree carries 4 modified files of unrelated WIP that's been there for multiple sessions (`.gitignore`, couchbase types, 2 AWS policy JSONs) — leave as-is, none of it bothered today's work.

---

## What shipped today

| PR | Linear | Subject | Status |
|---|---|---|---|
| [#102](https://github.com/zx8086/devops-incident-analyzer/pull/102) | [SIO-769](https://linear.app/siobytes/issue/SIO-769) | kafka-tool-failures reads top-level result.toolErrors | Merged, Done |
| [#103](https://github.com/zx8086/devops-incident-analyzer/pull/103) | [SIO-770](https://linear.app/siobytes/issue/SIO-770) | expose kafka_list_dlq_topics + dlqTopics extractor | Merged, Done |
| [#104](https://github.com/zx8086/devops-incident-analyzer/pull/104) | [SIO-771](https://linear.app/siobytes/issue/SIO-771) + [SIO-772](https://linear.app/siobytes/issue/SIO-772) | activate gitlab-deploy-vs-datastore-runtime rule | Merged, both Done |

Commits on `main` (most recent first):

```
c7a9947 SIO-771/772: activate gitlab-deploy-vs-datastore-runtime rule (#104)
e208df7 SIO-770: expose kafka_list_dlq_topics + dlqTopics extractor (#103)
6e59a4c SIO-769: kafka-tool-failures reads top-level result.toolErrors (#102)
e64f132 docs: formalize handover document structure in CLAUDE.md
3268a1a SIO-764: Phase A — kafka structured findings + extractFindings node (#101)
```

**SIO-764 epic status:** Done. All 5 originally-dormant correlation rules now live in production:

1. `kafka-empty-or-dead-groups` — active since SIO-764 Phase A (#101)
2. `kafka-significant-lag` — active since SIO-764 Phase A (#101)
3. `kafka-dlq-growth` — active since SIO-770 (#103) added the missing MCP tool + extractor branch
4. `kafka-tool-failures` — active since SIO-769 (#102) fixed the field-path bug
5. `gitlab-deploy-vs-datastore-runtime` — active since SIO-771+772 (#104) wired both gitlab and couchbase sides

---

## Backlog right now (cleaned-up view)

| Ticket | State | Priority | Effort | Why deferred |
|---|---|---|---|---|
| [SIO-591](https://linear.app/siobytes/issue/SIO-591) — 7.5: CI/CD pipeline (GitLab CI for AgentCore) | Backlog | High | 2 pts | Substantial infra work; spec needs refresh per [`project_deployment_target_agentcore`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/project_deployment_target_agentcore.md) memory (legacy K8s scope in old ticket text) |
| [SIO-579](https://linear.app/siobytes/issue/SIO-579) — 6.2: PagerDuty / Microsoft Teams webhook | Backlog | Medium | 2 pts | Self-contained feature; chat platform is **Teams** not Slack per [`project_chat_platform_teams`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/project_chat_platform_teams.md) |
| [SIO-773](https://linear.app/siobytes/issue/SIO-773) — SIO-764 Phase C: on-demand extractors for AWS/Elastic/Konnect/Atlassian | Backlog | Low | tracker only | Open per-datasource issues only when a real correlation-rule consumer arrives — don't do speculatively |

No Todo, no In Progress.

The `experiments/HANDOFF-2026-05-16-post-aws-rollout-followups.md` handover (which surfaced SIO-762/763/765/766/768) is **fully drained** — every actionable item from it has been merged in earlier PRs. Don't waste a session re-reading it.

---

## Recommended next session starting points

### Option 1: SIO-591 (CI/CD pipeline, High, 2pts) — fresh-context preferred

GitLab CI pipeline for AgentCore deployment. Per [`project_deployment_target_agentcore`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/project_deployment_target_agentcore.md): deployment target is AgentCore (not K8s). The original SIO-591 ticket may still reference legacy K8s scope — refresh during brainstorming. Spec needs to cover:

- Gate merges with `bun run typecheck && bun run lint && bun run test && bun run yaml:check`
- Selectively deploy changed MCP servers to AgentCore on merges to `main`
- Should follow the pattern already proven by `scripts/agentcore/deploy.sh` (used in the SIO-759 AWS rollout per Phase 3, PR #93)
- The deployment target is GitHub Actions (not GitLab CI) since the repo lives on github.com/zx8086 — verify against the existing `.github/workflows/` (or absence thereof) before writing the spec.

Brainstorm + spec + plan first.

### Option 2: SIO-579 (Teams webhook, Medium, 2pts)

PagerDuty + Microsoft Teams webhook endpoint. Memories that load:

- [`project_chat_platform_teams`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/project_chat_platform_teams.md) — chat platform is Teams (not Slack); webhook via Teams Outgoing Webhooks or Bot Framework
- [`project_apps_server_not_built`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/project_apps_server_not_built.md) — new HTTP routes go in `apps/web/src/routes/api/`, not the never-built `apps/server/`

Plan likely:
- New route under `apps/web/src/routes/api/incident/`
- POST `/api/incident/analyze` — accepts both PagerDuty and Teams payload shapes
- Reuses the existing SSE streaming pipeline from SIO-578 (PR #N — find it in git log)
- Zod schemas for the two webhook payload shapes
- Signature verification per PagerDuty + Teams webhook authentication patterns

Brainstorm + spec + plan first.

### Option 3: Anything else the user surfaces

The user may have a fresh ticket, a production incident, or a follow-up from a peer's PR review. Default to asking what they want before assuming SIO-591 vs SIO-579.

---

## State of the working tree

After session end:

```
M .gitignore                                                       (longstanding WIP, unrelated)
M packages/mcp-server-couchbase/src/types/mcp.d.ts                 (longstanding WIP, unrelated)
M scripts/agentcore/policies/devops-agent-readonly-policy.json     (longstanding WIP, unrelated)
M scripts/agentcore/policies/devops-agent-readonly-trust-policy.json (longstanding WIP, unrelated)

?? docs/superpowers/plans/2026-05-16-sio-771-772-gitlab-deploy-runtime-activation.md  (plan file from today, intentionally untracked)
?? experiments/HANDOFF-*.md (~15 historical handover docs, gitignored per reference_experiments_dir_gitignored)
?? experiments/SIO-701-iam-policy-runbook.md (also gitignored)
```

**Action needed before starting any new work:** stash the 4 unrelated WIP files so the new branch is clean:

```bash
git stash push -m "WIP-unrelated-policies-and-couchbase-types" -- \
  .gitignore \
  packages/mcp-server-couchbase/src/types/mcp.d.ts \
  scripts/agentcore/policies/
```

Pop after pushing the new branch + opening the PR. This is the same dance used in every PR today (#102, #103, #104).

The 4 modified files have been in the working tree for multiple sessions. They look like real work-in-progress someone left mid-stream — investigate before discarding, but they're not from today.

---

## Memories added this session (3 new)

Each captures a non-obvious finding worth knowing before touching adjacent code:

- [`reference_kafka_mcp_tool_count_canaries`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/reference_kafka_mcp_tool_count_canaries.md) — adding a new core read tool to `packages/mcp-server-kafka/src/tools/read/tools.ts` requires bumping 4 hardcoded canary counts atomically (3 in `full-stack-tools.test.ts`, 1 in `prompts-tags.test.ts`). Caught me once during SIO-770.
- [`reference_couchbase_query_response_shapes`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/reference_couchbase_query_response_shapes.md) — `executeAnalysisQuery` returns markdown (unparseable by the agent's `tryParseJson`); structural consumers need the new `executeAnalysisQueryStructured` sibling. Critical for any future couchbase tool that feeds an extractor.
- [`reference_typed_finding_helpers_inline_fixtures`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/reference_typed_finding_helpers_inline_fixtures.md) — the `with<Domain>Findings` helpers don't compose for multi-datasource integration fixtures; `styles-v3-replay.test.ts` uses inline sibling fields instead. Documents when to reach for which.

---

## Process notes worth carrying forward

1. **Spec → plan → subagent-driven execution works cleanly** for ticket-cluster work. The SIO-771/772 PR (15 tasks, 4 commits + 1 review-fix) ran end-to-end with zero rework loops beyond the single try/catch fix the code reviewer caught. Pattern: brainstorming skill → writing-plans skill → subagent-driven-development skill, with one implementer + spec reviewer + code-quality reviewer subagent per task.

2. **Code-quality reviewer catches issues spec-compliance review misses.** SIO-771/772's `executeAnalysisQueryStructured` was spec-compliant but the reviewer flagged the missing try/catch (sibling helper had one). Both reviews are load-bearing; don't skip either.

3. **Process correction from review:** for tasks that don't commit (Tasks 3, 4, 6, 7, 8, 9, 10, 11, 12, 13 in the SIO-771/772 plan), the code-quality reviewer can't run because it needs SHAs. Spec-compliance review is sufficient. Code quality reviews land on the bundling commit (commits 3 and 4 in this case) where everything is visible together.

4. **Handover doc structure** ([`feedback_handover_doc_structure`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/feedback_handover_doc_structure.md)): full structure (TL;DR, file refs, verification, risks, memory refs) — even when the handover is "session-end + next-session-starter" like this one. The thin "goals + next" shape is insufficient.

---

## Quick reference: today's high-touch files (for context)

| File | Why it mattered |
|---|---|
| `packages/agent/src/correlation/rules.ts` | Activated 4 rules across SIO-769/770/771/772. Helper migrations preserved trigger bodies. |
| `packages/agent/src/correlation/extractors/{kafka,gitlab,couchbase}.ts` | Three extractors now use uniform Zod safeParse pattern. |
| `packages/agent/src/extract-findings.ts` | Registry now dispatches kafka, gitlab, couchbase. |
| `packages/shared/src/agent-state.ts` | Added GitLabFindings, CouchbaseFindings schemas + 2 new slots on DataSourceResultSchema. |
| `packages/mcp-server-kafka/src/tools/read/{parameters,prompts,operations,tools}.ts` | SIO-770 added kafka_list_dlq_topics. |
| `packages/mcp-server-gitlab/src/tools/code-analysis/list-merge-requests.ts` | SIO-771 added gitlab_list_merge_requests. |
| `packages/mcp-server-couchbase/src/tools/queryAnalysis/{analysisQueries,queryAnalysisUtils,getLongestRunningQueries}.ts` | SIO-772 added lastExecutionTime + executeAnalysisQueryStructured + tool switch. |

---

## Out of scope (do NOT pick up reflexively)

- **SIO-773 Phase C extractors** — explicitly deferred. Don't add AWS/Elastic/Konnect/Atlassian findings extractors until a correlation rule needs them.
- **Konnect side of `gitlab-deploy-vs-datastore-runtime`** — deferred per SIO-773 policy. The rule's konnect iteration branch is intentionally a no-op via `getDatastoreSlowQueries(state, "konnect") -> []`. Activate only when there's a real reason.
- **Pre-existing lint pollution on `main`** — 4 unrelated formatting/import errors (couchbase types `.d.ts`, 2 policy JSONs, plus historically the kafka extractor test before today's Zod conversion fixed it). Out of scope for any unrelated PR; would benefit from its own focused cleanup ticket.
- **Pre-existing `@devops-agent/mcp-server-konnect` test failures** — missing `KONNECT_ACCESS_TOKEN` env var. Pre-existing; not your problem unless a session is specifically about konnect work.
- **Pre-existing `runSqlPlusPlusQuery` test failure** (1 of 96 in `@devops-agent/mcp-server-couchbase`) — intentional `WHRE` syntax-error performance test, unrelated to query analysis.

---

## Memory references applicable to next session

- [`project_deployment_target_agentcore`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/project_deployment_target_agentcore.md) — for SIO-591
- [`project_chat_platform_teams`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/project_chat_platform_teams.md) — for SIO-579
- [`project_apps_server_not_built`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/project_apps_server_not_built.md) — for SIO-579 (where the route lives)
- [`reference_experiments_dir_gitignored`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/reference_experiments_dir_gitignored.md) — this handover stays local
- [`feedback_handoff_docs_main_branch`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/feedback_handoff_docs_main_branch.md) — same
- [`reference_subagent_worktree_residue`](../../.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/reference_subagent_worktree_residue.md) — worktree cleanup if subagent-driven dev hits residue
- All 3 new references added today (listed above)

End of handover.
