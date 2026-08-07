# Sub-Agent Context Assembly

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-08-07 (SIO-1444)

What each of the 7 specialist sub-agents (elastic, kafka, capella, konnect, gitlab, atlassian, aws) actually receives in its system prompt, what is deliberately excluded, and which build-time gates keep the two from drifting. This document exists because the tier-4 OKF audit (SIO-1444, scoped by `experiments/HANDOFF-2026-08-07-SIO-okf-audit-tier4-scope.md`) found the exclusions were real architecture decisions recorded only in code comments and session memory — auditors kept rediscovering them as suspected gaps.

---

## What a sub-agent prompt contains

`buildSubAgentPrompt(agentName)` (`packages/agent/src/prompt-context.ts`) delegates to `buildSubAgentSystemPrompt` (`packages/gitagent-bridge/src/skill-loader.ts`), which assembles, in order:

1. **`SUB_AGENT_NON_INTERACTIVE_PREAMBLE`** (SIO-1257) — prepended so it frames everything that follows; kept in the prompt-cache-stable half. There is no human in a sub-agent's turn: never offer/ask, call at least one tool, absence claims need evidence.
2. **`buildSystemPrompt(agent)`** — the same core assembly the orchestrator uses, over the sub-agent's own `LoadedAgent`:
   - `SOUL.md` (identity), `RULES.md` (constraints, optional), `DUTIES.md` (GAP dialect, optional)
   - **Every skill body, every turn** — local skills declared in `agent.yaml skills:`, plus shared skills from `agents/shared` (local shadows shared). There is no `activeSkills` filter on the sub-agent path.
   - **Knowledge, if present** — `loadKnowledge` runs for every agent tier and `buildSystemPromptParts` renders a knowledge section whenever `agent.knowledge` is non-empty. No sub-agent declares `knowledge:` today (all 7 verified 2026-08-07), so this section is empty for all of them — the capability is live but unused, not broken.

A sub-agent directory that exists on disk but is not declared in the orchestrator's `agents:` map falls back to the ROOT agent's prompt (still with the preamble). `index.test.ts` ("every sub-agent directory on disk is declared") pins that this fallback is never hit unintentionally.

## What is deliberately excluded, and why

These are decisions, not gaps. Each has a ticket; do not re-file them as defects.

| Excluded | Decision | Rationale |
|---|---|---|
| Live memory (`readLiveMemory`, daily log, key decisions) | SIO-843: hooks/memory are **root-only** (`manifest-loader.ts`, `LoadAgentOptions`) | Memory is a session/agent-level concern; sub-agents are stateless per-dispatch specialists. Only `buildOrchestratorPromptParts` carries the `liveMemory` section (SIO-845). |
| Wiki (`buildWikiSection`) | Same seam as live memory | Wiki focus is derived per orchestrator turn; sub-agents get their slice of the incident via the dispatch payload instead. |
| Knowledge graph | SIO-1026/1027: the KG is **enrichment, not a fan-out participant** | The supervisor fan-out is hard-bounded to the 7 `DATA_SOURCE_IDS`; a `knowledge-graph` sub-agent can never be dispatched. `graphEnrich` writes `state.graphContext`, consumed by the single-completion aggregator. elastic-iac binds `kg_*` tools because it is a single-agent conversational ReAct flow — that contrast is intentional. SIO-1445 tracks the open question of passing a narrow per-domain graphContext slice into dispatch payloads. |
| Runbook selection (`selectRunbooks`, `knowledge:` categories) | Orchestrator-only today | Sub-agents carry their procedures as always-on skills instead; the runbook selector operates on the root agent's knowledge tree. |

## Workflows are not prompt content

`workflows/*.yaml` files are **SkillsFlow definitions**: code-executed deterministic DAGs, loaded for every agent tier (SIO-1352) and executed by the `packages/skillflow` executor inside the `resolveIdentifiers` node — never rendered into a prompt. Six sub-agents ship a `resolve-identifiers.yaml` preset; atlassian-agent has none **by design** (SIO-1096 removed its resolveIdentifiers probe). The taxonomy settled in the SIO-1352-57 series:

- **Skill** — a procedure the LLM follows (agentskills.io format, `skills/*/SKILL.md`).
- **Runbook/playbook** — knowledge the LLM consults (OKF format, `knowledge/**`), no ordering semantics.
- **Workflow** — a deterministic DAG code executes (SkillsFlow YAML, `workflows/*.yaml`).

Skill-count asymmetry across sub-agents is content placement, not missing capability: aws-agent keeps its procedures in a 281-line RULES.md (33-line SOUL, 0 skills), kafka in RULES too, while capella/gitlab/elastic factor theirs into skills (SIO-1180 pattern). All of it reaches the prompt either way, and all of it is scanned by the same tool-promise gate (next section).

## Build-time gates over this assembly

| Gate | Where | Guards |
|---|---|---|
| SIO-1228/1234 tool-promise canary | `skill-tool-coverage.test.ts` | Every tool-like name in prompt prose — skills AND SOUL/RULES/DUTIES/sharedContext via `extractPromptToolNames` — exists in the datasource's action map; no cross-datasource tool names; per-agent budget ratchet. |
| SIO-1257 non-interactive prose | `skill-tool-coverage.test.ts` | Sub-agent prose never defers to a human; the preamble reaches every sub-agent prompt. |
| SIO-1347 skill spec gate | `skill-spec-compliance.test.ts` | Every SKILL.md satisfies the agentskills.io frontmatter spec. |
| SIO-1281 root skill-declaration drift | `index.test.ts` | Root incident-analyzer + elastic-iac `skills/` dirs match their `agent.yaml skills:` allowlists. |
| SIO-1444 tree-wide skill-declaration drift | `okf-spec-audit.ts` (`findSkillDeclarationDrift`) + `okf-spec-audit.test.ts` + `spec-audit-cli.ts` | Same guarantee extended to every declared sub-agent: an undeclared `skills/<name>/` dir with a SKILL.md (never loads), or a declared skill with no SKILL.md (loads as nothing), fails the build. |
| SIO-1352 preset workflow gate | `packages/skillflow/src/preset-workflows-gate.test.ts` | Every agent's workflows parse and dry-run. |
| SIO-1440 tier-1 OKF checks | `okf-spec-audit.ts` + `spec-audit-cli.ts` | Knowledge frontmatter degradation and orphaned knowledge files, across root and all sub-agents. |
