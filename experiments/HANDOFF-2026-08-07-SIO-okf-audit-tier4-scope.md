# Handover: OKF Spec Audit — Tier 4 Scoping (Sub-Agent Skills/Workflows/Memory/KG Alignment)

**Date**: 2026-08-07
**Ticket**: none yet — this handover's job is to scope and file it. No Linear issue exists for "tier 4" as of this writing.
**Parent epic/program**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a) project; direct predecessors are [SIO-1440](https://linear.app/siobytes/issue/SIO-1440/okf-spec-audit-tier-1-static-consistency-checks-for) (tier 1, merged), [SIO-1441](https://linear.app/siobytes/issue/SIO-1441/okf-spec-audit-tier-2-isolated-single-agent-probe-harness-bypass-the) (tier 2, merged), [SIO-1442](https://linear.app/siobytes/issue/SIO-1442/okf-spec-audit-tier-3-trajectory-grounded-runbook-selection-and) (tier 3, merged).
**Repo state**: `origin/main` HEAD is `fef935617022a29deef2716b1e80621bd3f609c1` ("SIO-1442: tier-3 trajectory-grounded runbook-selection and citation evaluators (#633)"). **Do not branch from this worktree's current HEAD** — this worktree (`.claude/worktrees/awesome-mahavira-bd8b64`) is a *recycled* worktree still checked out on the old `claude/okf-agent-audit-approach-9c5763` branch (HEAD `b7574ef2`, which predates the tier 3 merge). Start the next session by fetching and branching from `origin/main` directly, or use a fresh worktree.
**Suggested branch name**: `claude/sio-1443-okf-audit-tier4-subagent-alignment` (next SIO number unconfirmed — check Linear before filing, SIO-1442 was the last one this program used and SIO-1443 may already be taken by unrelated work per `sio-1322-steering-verification-a4479b` worktree's branch name `simonowusupvh/sio-1443-couchbase-v2-full-coverage`; **verify the next free SIO number in Linear before creating the ticket**).

## TL;DR

Three tiers of an OKF spec audit program (SIO-1440/1441/1442) shipped this session — static consistency checks, an isolated single-agent probe harness, and trajectory-grounded runbook-selection/citation evaluators. All three graded the **orchestrator's** use of its own knowledge/runbooks. The user then asked a **new, unscoped** question for next session: are the 7 sub-agents' skills and workflows internally aligned/coherent, and — separately — do sub-agents make use of live memory and the knowledge graph "as much as possible"? This session did enough live grepping to answer the second half definitively: **sub-agents currently have zero live-memory or knowledge-graph wiring, at both the code level (`sub-agent.ts` imports nothing memory/KG-related) and the OKF spec level (`agent.yaml` declares no `knowledge:`/memory fields for any sub-agent)**. This is either a real gap worth closing or an intentional architecture choice nobody has written down — that ambiguity is exactly what the next session needs to resolve before proposing a fix. Success for next session = a scoped Linear ticket (or tickets) with a concrete recommendation, backed by the evidence below, not a re-run of the same greps.

## Context — how this came to be

This session executed a 3-tier audit program the user approved via plan mode at session start (plan file: `/Users/Simon.Owusu@Tommy.com/.claude/plans/what-is-the-best-concurrent-teapot.md`, still present on disk). That plan explicitly scoped only tiers 1-3 and named tiers 2/3 as "documented here for context/future tickets." All three were built, PR'd, CodeRabbit-triaged across 2-3 rounds each, and merged in sequence:

- Tier 1 static checks → [SIO-1440](https://linear.app/siobytes/issue/SIO-1440), PR [#630](https://github.com/zx8086/devops-incident-analyzer/pull/630), merged `970b7afa`.
- Tier 2 isolated single-agent probe harness → [SIO-1441](https://linear.app/siobytes/issue/SIO-1441), PR [#632](https://github.com/zx8086/devops-incident-analyzer/pull/632), merged `98ca8eb7`.
- Tier 3 trajectory-grounded evaluators → [SIO-1442](https://linear.app/siobytes/issue/SIO-1442), PR [#633](https://github.com/zx8086/devops-incident-analyzer/pull/633), merged `fef93561`.

After tier 3 merged and its Linear issue auto-transitioned to Done, the user asked "what's next," and I (correctly, per the original plan's own scoping) said there was no ticketed tier 4 — only unticketed candidate follow-ons (run the tier 2/3 harnesses for real, knowledge-tree scaling, JSONL run-scoping). The user then asked a **new** question, not on that candidate list: audit whether the incident-analyzer's **sub-agent** skills/workflows are internally aligned and whether they make full use of agentic memory and the knowledge graph. This is a genuinely new axis — tiers 1-3 all graded the **orchestrator** (SOUL/RULES/knowledge consistency, orchestrator probe, orchestrator's runbook selection and citation grounding). None of them touched the 7 sub-agents' own SOUL/RULES/skills/workflows content, or memory/KG usage at the sub-agent level at all.

## Where the bodies are buried

### 1. Sub-agent directory shape is inconsistent — not obviously by design

```
agents/incident-analyzer/agents/
  atlassian-agent/   SOUL.md, agent.yaml                                    (no RULES.md, no skills/, no workflows/)
  aws-agent/         SOUL.md, agent.yaml, RULES.md, workflows/
  capella-agent/     SOUL.md, agent.yaml, skills/{fatal-request-investigation,no-index-diagnosis,slow-query-triage}, workflows/
  elastic-agent/     SOUL.md, agent.yaml, skills/{ml-anomaly-investigation}, workflows/
  gitlab-agent/      SOUL.md, agent.yaml, skills/{code-change-correlation,code-search-selection,project-resolution}, workflows/
  kafka-agent/       SOUL.md, agent.yaml, RULES.md, workflows/
  konnect-agent/     SOUL.md, agent.yaml, workflows/                        (no RULES.md, no skills/)
```

Observed via `ls agents/incident-analyzer/agents/*/` this session (raw output, not summarized). Three sub-agents have zero skills (`atlassian-agent`, `aws-agent`, `konnect-agent`), two have `RULES.md` (`aws-agent`, `kafka-agent`) and five don't. This alone doesn't prove a defect — atlassian/konnect/aws may genuinely need no domain-specific procedural skills if their MCP tool surface is simple enough. **Tier 4's first job is determining which asymmetries are justified (e.g., "Kong Konnect has only 3 real investigation patterns, captured directly in SOUL.md") vs. which are gaps (e.g., "aws-agent has RULES.md but no skills/, yet AWS estate investigation is clearly complex enough to warrant procedural skills the way capella-agent's 3 skills do").**

Each `workflows/*.yaml` file's actual schema/consumption path was not inspected this session — confirmed only that `gitlab-agent/workflows/resolve-identifiers.yaml` exists as a single file. Whether "workflows" here means something consumed by `packages/gitagent-bridge` at prompt-assembly time, or something else entirely (a separate execution-time construct), is **unverified** — check `packages/gitagent-bridge/src/manifest-loader.ts` and `skill-loader.ts` for a `workflows` field/directory read before assuming they're prompt content.

### 2. Sub-agents have zero live-memory or knowledge-graph wiring — confirmed at both code and spec level

**Code level.** `packages/agent/src/sub-agent.ts`'s full import list (lines 3-35+) contains no reference to memory or the knowledge graph:

```
grep -n "memory\|knowledgeGraph\|KnowledgeGraph\|wiki" packages/agent/src/sub-agent.ts
→ (zero matches)
```

Its imports are: `gitagent-bridge` (tool resolution), `observability`, `shared` types, LangGraph/LangChain core, `graph-budget`, `llm`, `mcp-bridge`, `message-utils`, `network-baseline`, `prompt-cache`, `prompt-context`, `state`, `sub-agent-context-budget`, `sub-agent-focus-block`, `sub-agent-instrumentation`. No memory-writer, no KG client, no wiki-lint reference.

Contrast with the orchestrator's volatile prompt layer (`packages/agent/src/orchestrator-prompt-assembly.ts:19,52,64`):

```typescript
// line 19
	wiki: string;
// line 52 (comment)
// volatile = filtered knowledge + compliance + live memory + wiki + graph, in the
// line 64
		sections.wiki +
```

`aggregator.ts` (the orchestrator's own turn-processing) references `graphEnrich` in comments around line 187-194, confirming KG context is read there, not in any sub-agent code path.

**Graph-topology level.** `packages/agent/src/graph.ts` node wiring (confirmed via `addNode`/`addEdge` grep, lines 109-258) shows the two gated KG nodes (`recordEntities`, `graphEnrich`, SIO-850) sit strictly *before* the sub-agent fan-out and are never revisited per-sub-agent:

```
.addEdge("entityExtractor", knowledgeGraphEnabled ? "recordEntities" : "awsEstateRouter")
.addEdge("recordEntities", "graphEnrich")
.addEdge("graphEnrich", "awsEstateRouter")
...
.addEdge("awsEstateRouter", "resolveIdentifiers")
.addEdge("resolveIdentifiers", "detectTopicShift")
...
.addEdge("queryDataSource", "align")   // <- the sub-agent fan-out's single dispatch node, feeds directly into align/aggregate
```

`queryDataSource` is the one node every sub-agent invocation runs through (via `Send`, per the CLAUDE.md pipeline diagram); it sits entirely after `graphEnrich` has already written whatever it's going to write into **orchestrator** state (`networkContext`/`mlAnomalyContext`, confirmed via the `aggregator.ts:187` comment: "populated early by graphEnrich, still valid here since it's a plain state"). Nothing in the fan-out reads that state back out to individual sub-agents, and nothing after `queryDataSource` feeds sub-agent-specific KG context back in before the sub-agent's own LLM call completes.

**Spec level (OKF).** Neither `agents/incident-analyzer/agents/gitlab-agent/agent.yaml` nor `agents/incident-analyzer/agents/aws-agent/agent.yaml` declares a `knowledge:` field or anything memory-related:

```
grep -n "knowledge:\|memory" agents/incident-analyzer/agents/gitlab-agent/agent.yaml agents/incident-analyzer/agents/aws-agent/agent.yaml
→ (zero matches)
```

This needs to be spot-checked against the other 5 sub-agents' `agent.yaml` too (not done this session) but the pattern from 2 of 7 strongly suggests it's uniform: **sub-agents have no `knowledge:` block in their OKF spec at all**, meaning even the ordinary (non-memory, non-KG) knowledge-loading path documented in CLAUDE.md's "Assembly order" section may not apply to sub-agents the way it does to the orchestrator. Verify this claim — it wasn't directly confirmed that sub-agent `agent.yaml` files never have `knowledge:` populated, only that 2 sampled files don't.

### 3. What already exists that tier 4 must not re-invent

`packages/gitagent-bridge/src/skill-tool-coverage.test.ts` (462 lines, confirmed present) already covers, per its 3 `describe` blocks:

```
describe("SIO-1228: skill prose cannot promise tools the datasource does not expose", ...)
describe("SIO-1257: sub-agent prose never defers to a human", ...)
describe("SIO-1257: the non-interactive preamble reaches every sub-agent prompt", ...)
```

Tier 4 should NOT re-propose tool-name/binding cross-checks or the "prose never defers to a human" ban-pattern scan — both already exist and are tested. Tier 4's genuinely new territory is: (a) cross-sub-agent skill/workflow **consistency** (not tool-binding correctness, but "does gitlab-agent's 3-skill pattern make sense compared to atlassian-agent's zero-skill pattern, given their respective tool-surface complexity"), and (b) memory/KG **utilization**, which nothing today checks at all.

`packages/gitagent-bridge/src/okf-spec-audit.ts` (tier 1's own deliverable) exports exactly two functions: `findFrontmatterDegradations` and `findOrphanedKnowledgeFiles`. Both operate on `agentDir` + `KnowledgeIndex` and were run against the **root** incident-analyzer agent plus (per `spec-audit-cli.ts`'s `flattenAgents()` fix this session) all 7 sub-agents already, via the tier-1 CLI (`packages/agent/src/eval/spec-audit-cli.ts`). So tier 1's checks (frontmatter degradation, orphaned knowledge) **already run against sub-agents** — that part of "are sub-agent knowledge files healthy" is covered. What's NOT covered by tier 1: whether sub-agents' skills/workflows are *used* at all relative to what's available (memory/KG), or whether their SOUL/RULES/skill triad is internally coherent the way tier-1's contradiction scan checks for the orchestrator.

### 4. Relevant existing memory/KG audit work (from persistent memory, not re-verified this session)

Two prior, unrelated audit efforts already exist and may share findings or methodology worth reusing:

- `project_kg_agent_memory_audit_complete` — memory slug for a COMPLETE audit spanning SIO-1339 through SIO-1343, described as "KG+AgentMemory audit COMPLETE." This was a *different* audit (not sub-agent-specific per the one-line memory index description) — read the full memory file before assuming it covers sub-agent usage; it may only have audited the orchestrator's own KG/memory wiring quality, which would make it a precedent for methodology but not a source of "sub-agents already covered" comfort.
- `reference_agent_memory_relevant_k_default_10_truncation` — a known gotcha about Agent Memory's `relevant_k` defaulting to 10 and truncating recall; relevant if tier 4 proposes wiring memory recall into sub-agents (their recall calls would need the same truncation awareness the orchestrator's do).
- `reference_incident_kg_enrichment_not_fanout` — memory slug literally named "not fanout," strongly suggesting a **prior, deliberate decision** that KG enrichment should NOT be a per-sub-agent fan-out operation. **This is the single most important memory to read first in the next session** — it may mean the "sub-agents have zero KG wiring" finding above is not a gap at all, but a previously-decided architecture choice with a real rationale (likely cost/latency: KG enrichment as a fan-out across 7 sub-agents × however many tool calls each would be expensive and probably redundant if the entities are incident-level, not sub-agent-level). If that memory confirms this was intentional, tier 4's framing shifts from "why don't sub-agents use the KG" to "is the current single-enrichment-point design actually serving sub-agents' needs, or would a narrower, cheaper per-sub-agent KG *read* (not a full enrich) add value." Read this memory file in full before writing any ticket.

## The scoping work still needed (this is NOT a ready-to-implement plan — it's a research/scoping task)

This handover deliberately does not propose a fix, because the live-verified facts above raise a real fork the next session must resolve first:

1. **Read `reference_incident_kg_enrichment_not_fanout` in full.** If it documents a deliberate no-fan-out decision with a still-valid rationale, tier 4 reframes around "is a lighter-weight per-sub-agent KG *read* worth adding" rather than "why is this missing." If the memory turns out to be about something narrower (e.g., just `recordEntities`/`graphEnrich` specifically, not memory recall generally), the framing splits further between memory and KG.
2. **Check whether live memory (not KG) has ever been discussed for sub-agents.** Nothing found this session suggests it has — `readLiveMemory`/`appendDailyLog`/`recordKeyDecision` (the SIO-938 writer, `packages/agent/src/memory-writer.ts`) is a single writer; check whether it's called anywhere reachable from a sub-agent turn (this session confirmed `sub-agent.ts` doesn't import it directly, but didn't check whether e.g. `prompt-context.ts`'s `buildSubAgentPrompt` transitively pulls in memory content some other way — verify before concluding "definitely zero," since `buildSubAgentPrompt`'s own source wasn't read this session).
3. **Audit the 5 remaining sub-agents' `agent.yaml` for `knowledge:`/memory fields** (only 2 of 7 were sampled: gitlab-agent, aws-agent). If the pattern holds across all 7, that's strong evidence this is architectural, not accidental — worth a direct question to whoever designed the OKF spec format (or a `git log`/`git blame` archaeology pass on when `knowledge:` was added to the root agent's `agent.yaml` vs. never added to sub-agents').
4. **Determine what "workflows/" actually means at runtime** — read `packages/gitagent-bridge/src/manifest-loader.ts` and `skill-loader.ts` for any `workflows` handling. This session found the directories exist (`aws-agent/workflows/`, `gitlab-agent/workflows/resolve-identifiers.yaml`, etc.) but never confirmed whether they're loaded into prompts, used as a separate execution mechanism, or dead/aspirational content. This is foundational — "are workflows aligned with skills" is unanswerable until it's known what a workflow actually *does*.
5. **Only after 1-4**, form a recommendation: either (a) file a ticket to add narrow, targeted memory/KG reads to specific sub-agents where it would plausibly help (e.g., gitlab-agent reading KG-known code-ownership relationships it currently has to re-derive from scratch every turn), or (b) file a ticket that documents *why* the current design is correct and adds the missing static checks (skill/workflow consistency lint, `knowledge:`-field-presence lint) without touching runtime wiring, or (c) some mix.

## Verification

No code changes were made this session related to tier 4 — this is pure scoping/research, captured here. Before filing any ticket:

```bash
bun run typecheck && bun run lint && bun run test
```
(baseline — should already pass on `origin/main`, not specifically exercised by tier-4 scoping work.)

Manual probes the next session should run early:
```bash
# Confirm the 2-of-7 agent.yaml sample generalizes:
grep -l "knowledge:" agents/incident-analyzer/agents/*/agent.yaml
# Expected if the finding holds: no output at all (grep -l finds nothing)

# Confirm workflows/ directory contents across all sub-agents that have one:
find agents/incident-analyzer/agents/*/workflows -type f

# Confirm sub-agent.ts truly never reaches memory/KG transitively via prompt-context.ts:
grep -n "memory\|knowledgeGraph\|KnowledgeGraph\|wiki" packages/agent/src/prompt-context.ts
```

## Files to modify

None yet — this is a scoping handover, not an implementation plan. The eventual tier-4 ticket will likely touch:

| Area | Likely files |
|------|-------------|
| New static lint (if scope (b) above) | `packages/gitagent-bridge/src/okf-spec-audit.ts` (extend with a skill/workflow-consistency or `knowledge:`-field-presence check), companion `.test.ts` |
| Sub-agent memory/KG wiring (if scope (a) above) | `packages/agent/src/sub-agent.ts`, `packages/agent/src/prompt-context.ts` (`buildSubAgentPrompt`), possibly `packages/agent/src/memory-writer.ts` if a new read-only accessor is needed |
| Workflow-definition clarity (prerequisite research, not a code change) | `packages/gitagent-bridge/src/manifest-loader.ts`, `packages/gitagent-bridge/src/skill-loader.ts` |

## Workflow

Branch off `origin/main` (HEAD `fef935617022a29deef2716b1e80621bd3f609c1`), not off this worktree's stale branch. Per CLAUDE.md: every approved plan needs a Linear issue before implementation begins — since this session's output is scoping only, the next session's first concrete deliverable should be filing that issue (Siobytes team, added to the DevOps Incident Analyzer project, commit format `SIO-XX: message`, default backlog status, never set to Done without user approval). Given the fork in "what the fix even is" described above, consider whether this warrants **two** tickets — one for "sub-agent skill/workflow consistency lint" (mechanical, tier-1-shaped) and one for "sub-agent memory/KG utilization" (architectural, needs the `reference_incident_kg_enrichment_not_fanout` memory read first) — rather than forcing both into one ticket the way tiers 1-3 were each a single ticket.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `reference_incident_kg_enrichment_not_fanout` reveals the "gap" is actually intentional and well-reasoned | Medium-high, given the memory slug's name | Read it FIRST, before writing any ticket framing this as a defect |
| `workflows/*.yaml` turns out to be dead/aspirational, unread by any loader | Unverified, plausible given no grep was run against `manifest-loader.ts` this session | Check `manifest-loader.ts`/`skill-loader.ts` for `workflows` handling before assuming they're live prompt content |
| Sampling bias: only 2 of 7 `agent.yaml` files checked for `knowledge:`/memory fields | Certain (explicitly a sampling gap, not a risk of being wrong necessarily) | Run the `grep -l "knowledge:"` all-files probe in Verification above before concluding the pattern is uniform |
| Adding memory/KG reads to sub-agents could reintroduce the exact cost/latency problem `not_fanout` was presumably designed to avoid | Medium, if scope (a) is chosen without reading the prior decision's rationale | Gate any new sub-agent KG/memory read behind a narrow, single-lookup design (not a re-enrichment), and behind its own feature flag per the SIO-640 edge-gate idiom already used elsewhere in this graph |

## Out of scope

- Re-running or re-verifying tiers 1-3's own findings — they're merged, closed, and not in question.
- The three candidate follow-ons already named at the end of the prior session (run tier 2/3 harnesses for real; knowledge-tree scaling; JSONL run-scoping) — those are separate, already-identified backlog items, not part of this new sub-agent-alignment question. Don't conflate them.
- Any actual code change to `sub-agent.ts`, `graph.ts`, or any `agent.yaml`/SOUL/RULES/skill file — this handover is scoping only.
- Auditing the *orchestrator's* memory/KG usage quality — that's what `project_kg_agent_memory_audit_complete` already covered (per its memory slug name); tier 4 is specifically about the 7 sub-agents.

## Related code references

- `packages/agent/src/graph.ts:109-258` — full node/edge wiring; the authoritative source for "what runs before/after the sub-agent fan-out," already spot-checked this session.
- `packages/agent/src/orchestrator-prompt-assembly.ts:19,52,64` — the volatile-layer field list showing memory/wiki/KG are orchestrator-only inputs today.
- `packages/gitagent-bridge/src/skill-tool-coverage.test.ts` — existing coverage tier 4 must not duplicate (tool-binding correctness, human-deferral ban-pattern).
- `packages/gitagent-bridge/src/okf-spec-audit.ts` — tier 1's pattern for a new static check, if tier 4 goes that route.
- CLAUDE.md's "Assembly order" section (this file, top of repo) — the documented prompt-assembly order tier 4 should confirm still matches reality for sub-agents specifically (it was written/verified against the orchestrator during the original planning session, not re-verified against sub-agents this session).

## Memory references

- `reference_incident_kg_enrichment_not_fanout` — **read this first**, see above.
- `project_kg_agent_memory_audit_complete` — prior, separate KG+AgentMemory audit (SIO-1339-43); check whether its scope overlaps sub-agents at all before assuming it doesn't.
- `reference_agent_memory_relevant_k_default_10_truncation` — relevant if tier 4 proposes wiring recall into sub-agents.
- `project_two_format_split_skills_agentskills_runbooks_okf` — background on the SKILL.md vs. AgentSkills vs. runbooks vs. OKF format split; relevant context for judging whether sub-agent skill-count asymmetry (3 skills for gitlab-agent vs. 0 for atlassian-agent) is meaningful or just reflects how much procedural content that domain has ever needed written down.
- `reference_sio1347_skill_spec_gate.md` (per MEMORY.md index: "SIO-1347 SKILL.md spec gate PR#569") — existing validation for skill frontmatter; check whether it already covers anything tier 4 would otherwise re-propose.
- `project_eval_quality_program_sio1378_1404` — the broader eval program tiers 1-3 sit alongside; useful context for how "grading" work in this repo is normally structured (LangSmith evaluators, judge patterns) if tier 4 ends up needing a runtime eval rather than a static lint.
