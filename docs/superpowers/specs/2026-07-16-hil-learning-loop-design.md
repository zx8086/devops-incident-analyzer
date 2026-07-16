# HIL learning loop — "learn from TICKET-123" — design

Date: 2026-07-16
Tickets:
- [SIO-1125](https://linear.app/siobytes/issue/SIO-1125) — HIL learning loop (parent)
- [SIO-1126](https://linear.app/siobytes/issue/SIO-1126) — Phase 1: learn lane + root-cause correction loop
- [SIO-1127](https://linear.app/siobytes/issue/SIO-1127) — Phase 2: binding corrections + heuristics + PR-gated draft runbook
- [SIO-1128](https://linear.app/siobytes/issue/SIO-1128) — Phase 3: retrieval polish + rebuild closure

Motivating case: internal ticket DEVOPS-1355. The agent diagnosed a consumer service's 30-day Confluent bootstrap disconnects as a SASL credential failure (High) and demoted DNS to Medium ("a DNS failure would produce Unknown host"). The human correction found the real cause — a missing per-VPC Route53 resolver-rule association (not transitive over the Transit Gateway; the hostname resolved to non-routable 10.1.x.x IPs, so the TCP timeout mimicked an auth failure) — plus two more corrections: the MSK findings the agent flagged Critical were vestigial config and orphaned consumer groups, and the "June onset" was the log-retention edge, not the actual start.

None of that flows back today. The loop is half-built: the knowledge graph already READS `(:Incident)-[:RESOLVED_BY]->(:Runbook)` into the aggregator prompt as "resolved by X" (`priorRootCauses`, `packages/knowledge-graph/src/reader.ts:335-374,519-539`), but the writer `linkResolution` (`packages/knowledge-graph/src/writer.ts:569-578`) has zero production callers. Root causes are machine-derived only (`recordRootCauseData` from the top satisfied correlation rule); Jira resolutions are consumed only as MTTR statistics (`findLinkedIncidents`, `getIncidentHistory`); FeedbackBar feedback dead-ends at LangSmith.

## Goal

A chat-triggered flow — the user types `learn from DEVOPS-1355` in the incident-analyzer chat — that:

1. Fetches the Jira ticket + all comments via the atlassian MCP server.
2. Matches the ticket to the KG `Incident` node (embedding KNN + human confirm).
3. LLM-distills a structured `LearningProposal` with four learning classes: corrected root cause + resolution, topology/binding corrections, transferable diagnostic heuristics, and durable memory facts — every item grounded in verbatim comment quotes.
4. Gets per-item human approval via a LangGraph interrupt.
5. Writes the approved items to the knowledge graph, agent memory, and the skill/runbook proposal pipelines.

The next similar incident then renders the human-corrected cause and "resolved by X" through the existing, untouched `graphEnrich` read path.

## Constraints carried from prior work

- **Durable agent-memory facts are immutable from the client** (`reference_agent_memory_recall_dedup`). Every fact write needs a dedup gate; re-running `learn from X` must not double the store.
- **Rebuild parity (SIO-1103).** Every KG write mirrors a durable fact whose annotation shape `packages/knowledge-graph/src/rebuild.ts` can replay. `rootCauseFromAnnotations` reconstructs `class` from the `rule_name` annotation, which forces `ruleName == class == causeClass` for human-corrected causes; provenance goes in extra annotations only.
- **Kuzu/lbug quirks.** The HNSW-indexed `Incident.embedding` column forbids bare `SET` — writes go through `setIncidentEmbedding`'s drop/set/recreate path (`writer.ts:174-193`). New Cypher stays single-MATCH/WHERE/SET. No new edge properties without CREATE + ALTER_MIGRATIONS pairs (Phase 1 = zero migrations).
- **Interrupt re-execution.** LangGraph re-executes an interrupted node from its top on resume, so compute and `interrupt()` live in separate nodes (the iac `reviewPlan`/`reviewGate` split, `packages/agent/src/iac/graph.ts:89-90`).
- **Edge-gate idiom (SIO-640).** Nodes registered always; the lane is reachable only when enabled.
- **Soft-fail writes.** Learning never breaks the turn; failures append to `partialFailures` (the `record-bindings.ts:339-345` idiom).
- **No module-scope env reads in packages/agent**; call-time reads with an injectable `env` param.
- **PII redaction** before any LLM call over ticket text and at memory persistence (`redactPiiContent` + `recordKeyDecision`'s built-in redaction — the skill-learner double guarantee).

## Architecture

New lane inside the main incident-analyzer graph. Not a separate StateGraph and not a plain API route: interrupts, resume, checkpointing, and SSE node pills all key on `agentName ∈ {incident-analyzer, elastic-iac}`, and the command arrives in the incident chat thread — a separate graph would fork the conversation onto a different thread.

```
classify --(hilLearnTicketKey && HIL_LEARNING_ENABLED)--> learnFetchTicket
learnFetchTicket --ok--> learnMatchIncident -> learnMatchGate [interrupt #1: pick incident / none]
             \--fail--> END (soft-fail status event)
learnMatchGate -> learnDistill -> learnReviewGate [interrupt #2: per-item approve/reject]
                                      \--> applyLearnings -> END
```

The lane ends at `END`, not `followUp` (follow-up suggestions are investigation-shaped; a learning turn's "next step" is in the apply summary, which is appended as a normal `AIMessage`).

### Detection

Pure regex in `packages/agent/src/learn/detect.ts` (`/^\s*learn\s+from\s+((?:[A-Z][A-Z0-9]*)-\d+)\s*$/i`), called from `classify`. `turnReset` (`classifier.ts`) clears `hilLearnTicketKey` so a prior turn's key never leaks. New replace-reducer state fields: `hilLearnTicketKey, hilTicket, hilMatchCandidates, hilTicketEmbedding, hilMatch, hilProposal, hilDecisions`.

### Ticket fetch

Direct MCP invoke (the `resolve-identifiers.ts` pattern): `getToolsForDataSource("atlassian")` -> `atlassian_getJiraIssue` with `fields:"*"`. The custom wrapper truncates `description` to 4KB whenever a field list is projected — and the agent's report IS the description — so `"*"` is required; direct invokes bypass the sub-agent result cap. A pure parser + prompt-capper in `packages/agent/src/learn/ticket.ts` handles both plain-string and ADF comment bodies (soft-fail to raw JSON text, never throw), fixture-tested with a sanitized DEVOPS-1355 payload.

Why not a new custom MCP tool: it would add a cross-package deploy dependency for a shape only one caller needs; the curated custom-tool surface protects the sub-agent LLM loop, which this call never enters.

### Incident matching

`packages/agent/src/learn/match.ts`: embed `summary + description` via the exported `getEmbedder()` (from `graph-knowledge.ts`, keeps `_setIncidentEmbedderForTesting` injection) + `truncateForEmbedding` (8192 cap); `similarIncidents(store, emb, 5)` -> top 3 candidates + a mandatory "none of these"; any incident whose summary mentions the ticket key is pinned first (`via: "ticket-mention"`). On "none", `applyLearnings` creates `Incident {id: "jira:<key>"}` via `recordIncident` + `setIncidentEmbedding` + a `kg-incident` mirror fact.

### Distiller

New `hilDistiller` LLM role (`packages/agent/src/llm.ts`: temperature 0, maxTokens 4096, 120s deadline, env-tunable via `roleToEnvSegment`). Zod `LearningProposalSchema` in `packages/agent/src/learn/schema.ts`:

- `rootCause` (nullable): `causeClass` (kebab-case), `description`, `resolution`, `invalidatedHypotheses[]` ({hypothesis, reason}), optional `runbookFilename` (existing catalog match only).
- `bindings[]` (max 10): `action: confirm|invalidate`, `service`, `datasource`, `bindingKind`, `resourceId`, `locator?`, `reason`.
- `heuristics[]` (max 3): `name`, `description`, `whenToUse`, `procedure` (matches the SIO-1015 proposal shape).
- `memoryFacts[]` (max 8): `text`.
- Every item: stable `id` + 1-3 verbatim `evidence` quotes from ticket comments.

Prompt rules: diff the agent's report (description) against later human comments; only emit items grounded in verbatim quotes; a binding's `resourceId` must appear literally in the ticket text; map the fix to a catalog runbook only if genuinely applicable. Parse with the first-JSON-block + `safeParse` idiom (skill-learner).

### Approval gates

Exact topic-shift contract. `emitHilLearningInterrupt` in `apps/web/src/lib/server/sse-pump.ts` maps interrupt payloads `hil_learning_match` / `hil_learning_review` to SSE events; the stream endpoint checks it after the topic-shift check; a new endpoint `apps/web/src/routes/api/agent/learning/resume/+server.ts` (cloned from topic-shift) accepts exactly-one-of `{match: {incidentId | null}}` or `{review: {decisions: Record<itemId, "approve"|"reject">}}`, calls `resumeAgent`, re-checks `getPendingInterrupt` for the chained gate (iac resume precedent), then `getLastAssistantText` -> message, `pruneThreadState` + `runPostTurn` + done. UI: `LearningMatchCard.svelte` + `LearningProposalCard.svelte` (PlanReviewCard styling precedent), reducer/store additions mirroring `resolveTopicShift`. Per-item edits are deferred to Phase 3 (reject + re-run is the editing story until then).

### Writers on approval (`packages/agent/src/learn/apply.ts`)

- **Root cause**: `recordRootCause(store, { id: sha256(causeClass).slice(0,16), class: causeClass, ruleName: causeClass, description, confidence: 1.0 })`. Provenance (`source:"hil"`, `ticket`) goes in the mirror fact's annotations plus a "(human-corrected via TICKET)" description suffix. The writer already deletes the prior `HAS_ROOT_CAUSE` edge — a correction replaces the machine cause. `invalidatedHypotheses` fold into the description ("Ruled out: ...") so they render through the existing reader with zero changes. Then `linkResolution(store, incidentId, [runbookFilename])` — the first production caller.
- **Bindings** (Phase 2): confirm via `recordServiceBinding(..., confidence: 1.0, discoveredBy: "human", evidence: "hil:<ticket>")` (byte-parity with the confirm-binding CLI; `BindingKindSchema` re-validation at write time). Invalidate via a new writer `invalidateBindingByHuman` (the existing `invalidateBinding` hard-filters human edges by design — correct for automatic staleness, wrong for an explicit human verdict); sets `tInvalid` + appends the reason to `evidence`.
- **Heuristics** (Phase 2): reuse the SIO-1015 proposal-fact shape (`buildSkillFactText`/`buildSkillAnnotations` with `learned_from: "ticket:<key>"`; export `proposalExists` for dedup). Promotion stays `bun run skill:promote`. Plus a PR-gated draft runbook: extend memory-pr's proposal kind with `"runbook"`, render `agents/incident-analyzer/knowledge/runbooks/<causeClass>.md` (DRAFT banner) via `learn/runbook.ts`, immediate `promoteToMemory` so the PR URL lands in the apply summary. Files in that directory auto-enter the runbook catalog on merge (manifest-loader directory scan) — the PR gate is the only control; the agent process never writes the file directly.
- **Memory facts**: KG-mirror facts with annotation shapes matching the rebuild.ts mappers exactly (`kg-root-cause`, `kg-binding`, new `kg-resolution`, `kg-binding-invalidated` — replay entries land in Phase 3), plus a narrative `kind:"hil-resolution"` fact deduped by ticket key via deterministic `searchAgentMemory`. A prior `hil-resolution` hit does not block re-learning: it sets `alreadyLearned` on the review-gate payload, and apply skips fact re-writes while still re-applying graph writes (MERGEs are idempotent).

### Config

`HIL_LEARNING_ENABLED` defaults ON — kill-switch semantics like `RESOLVE_IDENTIFIERS_ENABLED` (enabled unless explicitly `"false"`); the lane only activates on an explicit `learn from TICKET-123` command, so it cannot fire on normal traffic. Requires `KNOWLEDGE_GRAPH_ENABLED` for match/KG writes (`learnFetchTicket` early-ends the lane with a clear status message when off). Memory writes self-gate on `LIVE_MEMORY_ENABLED`/backend. Human binding writes deliberately bypass `KG_BINDINGS_WRITE_ENABLED` (the confirm-binding CLI precedent — that flag gates the automatic W8 writer only).

## Phases

1. **SIO-1126 — lane + root-cause correction loop**: detect, state, fetch + parser + fixture, match + gate, schema + distill + review gate (rootCause + memoryFacts classes), apply (human recordRootCause + linkResolution to existing catalog runbook + mirror facts), hilDistiller role, sse-pump/stream/resume endpoint, two cards, wiring test, docs.
2. **SIO-1127 — bindings + heuristics + draft runbook**: `invalidateBindingByHuman` + tests, binding class end-to-end, heuristic -> `kind:skill` proposal facts, memory-pr `"runbook"` kind + renderer + immediate PR, RESOLVED_BY to the draft filename.
3. **SIO-1128 — retrieval polish + rebuild closure**: `kg-resolution`/`kg-binding-invalidated` replay entries in rebuild.ts; optional `HAS_ROOT_CAUSE.source` + `RootCause.invalidatedHypotheses` columns via ALTER_MIGRATIONS + a "Ruled out:" line in `buildGraphContext`; widen `KG_BINDINGS_READ_DATASOURCES` default beyond `elastic,aws`; per-item edit UX.

## Risks

- Memory checkpointer: a pending interrupt dies on process restart under `AGENT_CHECKPOINTER_TYPE=memory` (same as topic-shift); the sqlite checkpointer covers restarts.
- ADF payloads: comment bodies may be Atlassian Document Format objects; the parser flattens tolerantly and never throws.
- Draft runbook is live-on-merge: the PR gate is the only control.
- Distiller hallucination: contained by the verbatim-evidence requirement, the resourceId-must-appear-literally rule, and the per-item human approval gate.

## Verification

`bun run typecheck && bun run lint && bun run test`, plus the e2e probe (env: `KNOWLEDGE_GRAPH_ENABLED=true LIVE_MEMORY_ENABLED=true LIVE_MEMORY_BACKEND=agent-memory`; HIL learning is on by default):

```bash
curl -N -X POST localhost:5173/api/agent/stream -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"learn from DEVOPS-1355"}],"threadId":"hil-e2e-1"}'
# expect hil_learning_match event with candidates
curl -N -X POST localhost:5173/api/agent/learning/resume -d '{"threadId":"hil-e2e-1","match":{"incidentId":"<picked>"}}'
# expect hil_learning_review with the proposal
curl -N -X POST localhost:5173/api/agent/learning/resume -d '{"threadId":"hil-e2e-1","review":{"decisions":{"rc-1":"approve"}}}'
# expect apply summary message, then done
# Retrieval check on a NEW thread: "<service> cannot reach Confluent bootstrap, broker id -1"
# expect graphContext (LangSmith trace / kg_prior_root_causes): corrected cause + "resolved by <file>"
```
