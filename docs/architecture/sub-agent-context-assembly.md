# Sub-Agent Context Assembly

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-09-30 (SIO-1897)

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

## Tools bound outside the 25-tool belt

Two tools are added to a sub-agent's loop after action selection, so they never compete for a belt slot and never appear in an action map. Both read only what THIS run already fetched; neither can reach the network or another run's evidence.

| Tool | Bound when | What it does |
|---|---|---|
| `search_evidence` (SIO-1688) | `EVIDENCE_INDEX_ENABLED` is not `false`/`0` (default ON) and the per-result cap is active | Full-text search over the pre-truncation tool results of this run. |
| `run_js_on_evidence` (SIO-1776) | `EVIDENCE_EXEC_ENABLED` is not `false`/`0` (default **ON**, kill-switch; SIO-1775) | Runs a model-authored JavaScript function body in a sandbox over the full captured results: counts, group-bys, filters, joins across results. |

Unless `EVIDENCE_EXEC_ENABLED` is `false`/`0`, every bound tool's **model-facing** schema also gains an optional `_transform` string. A call that carries one runs the real tool unchanged (the parameter is stripped first, so the loop-guard signature and the MCP call are identical to a call without it), captures the full result exactly as before, and returns to the model only what the transform derived, suffixed with the evidence id. A transform that throws, times out or returns nothing costs nothing: the model gets the tool's normal output plus the reason. The typed-finding extractors, the persisted state and `search_evidence` always see the full result, which is why this sits at the agent's instrumentation boundary (`sub-agent-instrumentation.ts`) rather than inside the MCP servers.

The sandbox is QuickJS in WebAssembly (`packages/shared/src/sandbox-exec.ts`): no `process`, `require`, `fetch`, filesystem, environment, timers or imports exist in the guest. Its constraints, and why this reverses an earlier decision, are in section 13 of `docs/superpowers/specs/2026-09-10-context-mode-concepts-feasibility.md`. The flag shipped opt-in in SIO-1776 and was flipped to default ON in SIO-1775 after a live Bedrock run in which the model used all three recovery paths unprompted; section 15 of the same spec has the evidence.

**What gets indexed (SIO-1775).** The index is a per-run, in-memory SQLite FTS5 table, built only when `SUBAGENT_TOOL_RESULT_CAP_BYTES` is active and closed when the run ends. A result is indexed at full fidelity when it is larger than `min(cap, EVIDENCE_INDEX_MIN_BYTES)`, where `EVIDENCE_INDEX_MIN_BYTES` is 8192 (`sub-agent-instrumentation.ts`): anything over 8 KB, not only what the cap cuts, because the context budget can later elide a result the model once received whole and its elision marker points here. Smaller results are cheap to re-read and are not indexed; the marker for one of those names `run_js_on_evidence` alone. Bounds per call: 400 rows of at most 4096 bytes, over at most 4 MiB of one result (`evidence-index.ts`).

**Works under Node too (SIO-1772).** `evidence-index.ts` opens its database through the shared dual-driver opener (`openSqlite`, `packages/shared/src/sqlite-open.ts`) instead of importing `bun:sqlite`. The direct import threw under `vite dev` (a Node host), so the index was silently unavailable there and every truncation logged `indexedRows: 0`.

**Evidence table of contents (SIO-1687).** The turn-to-turn counterpart lives outside the sub-agent: `pruneThreadState` resets `dataSourceResults` after every turn, so before the reset `buildEvidenceToc()` (`packages/agent/src/evidence-toc.ts`) records provenance only (which datasource ran which tools, how much came back, what failed; capped at 2000 characters, 6 tool names per datasource) and it is prepended to the next turn's recall block. A follow-up can then tell pruned evidence from absent evidence. Kill-switch: `EVIDENCE_TOC_ENABLED` (default ON). It reaches the orchestrator prompt, never a sub-agent prompt.

## In-loop context controls

What bounds a sub-agent's context once the loop is running. Byte caps read their default when unset, empty, invalid or negative; boolean flags are kill-switches that default ON.

| Variable | Code default | Controls |
|---|---|---|
| `SUBAGENT_TOOL_RESULT_CAP_BYTES` | `131072` (`DEFAULT_TOOL_RESULT_CAP_BYTES`, shared with the AWS MCP cap); `0` disables | Per-result cap on what re-enters the loop, JSON-aware truncation (`sub-agent-truncate-tool-output.ts`). |
| `SUBAGENT_CONTEXT_BUDGET_BYTES` | `400000`; `0` disables | Cumulative budget over all tool results in the loop (SIO-1250). Newest results are kept whole; older ones have their content swapped for an elision marker. Messages are never removed, so tool-call pairing survives. A backstop against overflow, not a context-reduction knob. |
| `SUBAGENT_STATE_TOOL_OUTPUT_CAP_BYTES` | `65536`; `0` disables | Cap on the persisted `toolOutputs[].rawJson` (SIO-1043), independent of the model-facing cap. Typed-finding tools are exempt. |
| `SUBAGENT_TRUNCATION_SYNTHESIS_ENABLED` | ON (`false`/`0` disables) | One extra non-tool LLM call that writes the report when the loop hit its recursion limit or ended without narrating (SIO-1260), grounded in the full pre-cap capture. |
| `SUBAGENT_SYNTHESIS_EVIDENCE_BYTES` | `48000`; `0` and negatives fall back to the default (not a disable) | Evidence digest budget for that synthesis call. |
| `EVIDENCE_INDEX_ENABLED` | ON (`false`/`0` disables) | `search_evidence` and the index behind it. |
| `EVIDENCE_EXEC_ENABLED` | ON (`false`/`0` disables) | `run_js_on_evidence` and the `_transform` parameter. |
| `AGENT_PROMPT_CACHE_ENABLED` | ON (only the literal `false` disables) | Bedrock cache points, system prompt and rolling history. |

**Rolling prompt-cache points (SIO-1773).** The system-prompt cache point (SIO-1040) covers only the turn-invariant prefix, while a sub-agent's cost is its tool-result history, which a ReAct loop re-sends in full every turn. `withRollingCachePoints()` (`packages/agent/src/prompt-cache.ts`) therefore tags two messages on every model call: the newest one, and the one that closed the previous round (just before the latest `AIMessage`), which is exactly where the last turn's cache write landed. With the system point that uses 3 of Bedrock's 4 cache points. Only `ToolMessage` and `HumanMessage` are tagged. It runs last in the `preModelHook`, after any elision and after the final-turn directive, so the points sit on exactly what is sent, and it returns new instances through `llmInputMessages` so canonical `messages` stay byte-identical for the extractors and the raw capture.

## Loop guards and forced write-up

The recursion limit bounds LLM turns; these guards stop a loop that is spending those turns on calls that cannot add evidence. All of them live at the instrumentation boundary (`sub-agent-instrumentation.ts`, `sub-agent-loop-guard.ts`) and the `preModelHook` in `sub-agent.ts`.

**Per-call stops.** Every tool call is checked before it runs. `elasticsearch_search` and `aws_logs_start_query` have bespoke rulesets; every other tool gets the generic guard (SIO-1232): an exact duplicate signature is refused, a tool that has come back unproductive `MAX_UNPRODUCTIVE_PER_TOOL` (3) times is refused, and `MAX_UNPRODUCTIVE_PER_RUN` (8) is the run-wide backstop for a loop that rotates tool names instead of arguments. `aws_logs_get_query_results` and `aws_logs_describe_log_groups` are exempt from the generic rules, and the two ECS enumeration tools are exempt from the counter-driven caps. A refused call returns a stop message to the model in place of a result.

**The `subagent.loop_guard_stop` log (SIO-1791).** Each stop logs `dataSourceId`, `deploymentId`, `toolName`, `iteration`, three counters and a `reason`:

| Field | Meaning |
|---|---|
| `unproductiveSearches` | The `elasticsearch_search` counter only. It is 0 on every generic stop. |
| `unproductiveForTool` | Unproductive results for the stopped tool. |
| `totalUnproductive` | Unproductive results across the run, the input to the run-wide backstop. |
| `reason` | `duplicate-call`, `unproductive-streak`, `run-backstop` (the run-wide cap fired while the stopped tool was itself under its per-tool cap), or `aws_service_absent`. |

**Forced write-up (SIO-1779).** Stops are issued one call at a time and nothing used to count them, so a sub-agent could keep issuing refused calls until the recursion-limit reservation fired. `shouldForceFinalTurn()` now reads the message history: once every tool result of the last `BLOCKED_ROUNDS_BEFORE_FORCE` (3) rounds is a refusal, the hook appends the final-turn directive and logs `subagent.final_turn_forced` with `reason: "blocked-rounds"`. A refusal is a loop-guard stop (recognised by the `loopGuardStop` marker in `additional_kwargs`, never by message wording) or LangGraph's anchored `Tool "X" not found` error for an unbound tool. One real result anywhere in the window resets the count, so a sparse but productive datasource is never cut short.

**AWS absence proof.** For the aws sub-agent the guard also keeps a per-estate ECS enumeration ledger (SIO-1268). When a complete, error-free enumeration of the estate matches no focus service, the focus-service hunt in that estate stops, logged once as `subagent.aws_service_absent_early_exit`, and the result carries `serviceAbsent: true`. `AWS_ABSENCE_EARLY_EXIT_ENABLED` defaults ON (`false`/`0` disables, read at call time); off, the detector never latches.

- **Duplicate stops no longer destroy the proof (SIO-1783).** A stopped ECS list call used to latch the ledger as failed. After the ECS tools were exempted from the counter caps, only an exact duplicate or the absence block itself can stop them, and neither loses a page, so the latch is gone: a model that emitted the same list call five times in one turn had been permanently voiding a proof its first call earned. When the proof does not hold, the run logs `subagent.aws_absence_not_proven` with `blockedBy`.
- **Consumers skip proven-absent estates (SIO-1777).** `estatesFromState()` (`packages/agent/src/action-tools/pi-verifier.ts`) subtracts estates whose result carries `serviceAbsent`, so no `verify-with-pi` card is proposed and `fetchFleetInbox` reads no inbox for an estate the report itself ruled out.

## Build-time gates over this assembly

| Gate | Where | Guards |
|---|---|---|
| SIO-1228/1234 tool-promise canary | `skill-tool-coverage.test.ts` | Every tool-like name in prompt prose — skills AND SOUL/RULES/DUTIES/sharedContext via `extractPromptToolNames` — exists in the datasource's action map; no cross-datasource tool names; per-agent budget ratchet. |
| SIO-1257 non-interactive prose | `skill-tool-coverage.test.ts` | Sub-agent prose never defers to a human; the preamble reaches every sub-agent prompt. |
| SIO-1347 skill spec gate | `skill-spec-compliance.test.ts` | Every SKILL.md satisfies the agentskills.io frontmatter spec. |
| SIO-1281 root skill-declaration drift | `index.test.ts` | Root incident-analyzer + elastic-iac `skills/` dirs match their `agent.yaml skills:` allowlists. |
| SIO-1444 tree-wide skill-declaration drift | `okf-spec-audit.ts` (`findSkillDeclarationDrift`, `findMissingDeclaredSubAgents`) + `okf-spec-audit.test.ts` + `spec-audit-cli.ts` | Same guarantee extended to every declared sub-agent: an undeclared `skills/<name>/` dir with a SKILL.md (never loads), or a declared skill with no SKILL.md (loads as nothing), fails the build. Also audits the walk's own completeness: a declared sub-agent whose `agent.yaml` is missing silently vanishes from `subAgents` (and would dispatch with the ROOT prompt), so declarations are checked against disk, not against the loaded map. |
| SIO-1352 preset workflow gate | `packages/skillflow/src/preset-workflows-gate.test.ts` | Every agent's workflows parse and dry-run. |
| SIO-1440 tier-1 OKF checks | `okf-spec-audit.ts` + `spec-audit-cli.ts` | Knowledge frontmatter degradation and orphaned knowledge files, across root and all sub-agents. |
