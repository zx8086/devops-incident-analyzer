# HANDOFF: Make "have we seen this incident before?" a reliable recall capability

- **Date:** 2026-07-01
- **Ticket(s):** to be created — proposed title "SIO-XXXX: incident recall intent + aggregator graph-usage instruction". Parent/origin: [SIO-1026](https://linear.app/siobytes/issue/SIO-1026) (RootCause node + prior-root-cause enrichment, merged) and its follow-up [SIO-1027](https://linear.app/siobytes/issue/SIO-1027).
- **Repo state:** branch `claude/xenodochial-lovelace-b5e5ba` at HEAD `e01ee7f` (the SIO-1026 work; merged to main per user). Start this work **from a fresh branch off `main`**.
- **Suggested branch:** `<user>/sio-xxxx-incident-recall-intent`
- **Team/project:** Siobytes / [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a). Commit format `SIO-XX: message`.

## TL;DR

SIO-1026 shipped the *data* for incident recall: `graphEnrich` embeds the user's query text, vector-searches prior `Incident` nodes, annotates each with its recorded root cause, and folds a `## Knowledge Graph / Similar prior incidents` block into `state.graphContext` → the aggregator prompt. **But "have we seen this before?" is not a first-class intent anywhere in the pipeline**, so recall is a side effect of keyword luck + LLM inference, with two silent failure modes:

1. **Misclassification → no graph at all.** A history question with no infra keyword (e.g. "what went wrong last month?") can be classified `simple` → routed to `responder`, which gets **zero** `graphContext`.
2. **Aggregator ignores the graph.** `graphContext` is appended to the orchestrator prompt **raw, with no header or instruction**. For a pure recall question `dataSourceResults` is empty and the prompt is written for "aggregate these datasource findings", so whether prior incidents appear in the answer is left to LLM inference.

Success = a "have we seen X before / prior incidents on Y" question **reliably** surfaces prior incidents + their root causes, regardless of exact phrasing, without wastefully fanning out to live sub-agents.

## Context — how this came to be

SIO-1026 (merged) added `RootCause`/`HAS_ROOT_CAUSE` to the knowledge graph and made `graphEnrich` annotate vector-similar incidents with their prior root cause. The user then asked: *would the current classifier/prompt actually handle a request about prior incidents?* A code trace showed the plumbing works for the happy path but there is **no recall/history intent** and the aggregator prompt never explains the graph section. This ticket closes that gap. Everything below is the trace result — it is accurate as of HEAD `e01ee7f`.

## Where the bodies are buried (verify each at the current HEAD before editing)

### 1. Classifier — no recall concept; keyword-free history questions can fall to `simple`
`packages/agent/src/classifier.ts`
- `COMPLEX_PATTERNS` (`:21-35`) is a keyword list (cluster/health/log/kafka/incident/latency/…). A history question **with** an infra word matches → `complex`. A history question **without** one ("what happened last month?", "anything recurring lately?") matches nothing here.
- `patternClassify` (`:76-88`): returns `complex` only if a COMPLEX pattern hits; `simple` only if a SIMPLE pattern hits and no COMPLEX; otherwise `null` → falls through to the LLM classifier.
- LLM fallback: prompt says *"When in doubt, classify as COMPLEX"* and the catch defaults to complex (`:199` `"LLM classification failed, defaulting to complex"`; `:187` maps text→simple/complex). So a keyword-free history question **usually** lands complex via the LLM — but not guaranteed, and there is no explicit "past/recall" signal to lean on.
- **There is no history/recall branch.** Everything is simple-vs-complex only.

### 2. Responder (the simple path) has zero graph access
`packages/agent/src/responder.ts:27-33`
```ts
const llm = createLlm("responder");
const response = await llm.invoke([{ role: "system", content: RESPONDER_PROMPT }, ...state.messages], config);
```
`RESPONDER_PROMPT` (`:11`) is generic ("answer from general knowledge"); **`state.graphContext` is never passed**. So any recall question that lands `simple` cannot see prior incidents at all.

### 3. `graphEnrich` DOES do the right search (this part works)
`packages/agent/src/graph-knowledge.ts`
- Runs on the complex path, gated only by `isKnowledgeGraphEnabled()` (`:92-93`); no "is this a live incident?" gate.
- Search key is the **user's query text**, not a live incident: `lastUserQuery(state)` (`:59-62`) → embed (`:103`) → `similarIncidents(store, embedding)` (`:104`). So a meta-question genuinely matches prior incidents.
- Each similar incident is annotated with `rootCauseForIncident` and rendered by `buildGraphContext` as `## Knowledge Graph / ### Similar prior incidents` (see `packages/knowledge-graph/src/reader.ts` `buildGraphContext` + `SimilarIncidentWithCause`).
- Output: `{ graphContext }` → consumed downstream.

### 4. Aggregator appends the graph block RAW, with no instruction
`packages/agent/src/aggregator.ts:84`
```ts
const systemPrompt = buildOrchestratorPrompt({ runbookFilter, wikiFocus, graphContext: state.graphContext });
```
`packages/agent/src/prompt-context.ts:104-117` — both return branches end with a bare `graphSection`:
```ts
const graphSection = options.graphContext?.trim() ? options.graphContext : "";
return (
  buildSystemPrompt(agent) + buildComplianceBoundary() +
  buildLiveMemorySection() + wikiSectionFor(options) + graphSection   // <- no header, no "use this to answer recall questions"
);
```
Contrast: `buildLiveMemorySection` / `wikiSectionFor` are explained; the graph block is not.

### 5. Entity extractor has no "history/recall" field
`packages/agent/src/entity-extractor.ts:17-36` — `ExtractionSchema` = `{ dataSources, timeFrom, timeTo, services, severity, toolActions }`. No intent flag. A history question is treated as a live investigation and fans out to sub-agents (wasted work).

## The fix (step-by-step)

Two independent, small changes. Do them in order; each is separately testable.

### Fix A — teach the aggregator what the graph block is for (smallest, highest leverage)
This alone fixes failure mode #2 and helps every complex recall question.

In `packages/agent/src/prompt-context.ts`, wrap `graphSection` with a one-line usage instruction instead of appending it raw. Concretely, change `:108`:
```ts
// before
const graphSection = options.graphContext?.trim() ? options.graphContext : "";
// after
const graphSection = options.graphContext?.trim()
  ? `\n\nWhen the user asks whether an incident has happened before, what prior incidents exist, or what previously resolved a similar issue, ANSWER FROM the "Similar prior incidents" entries below (each may carry a prior root cause). If the section is absent or empty, say you have no prior-incident record rather than guessing.${options.graphContext}`
  : "";
```
(Keep the existing `## Knowledge Graph` markdown from `buildGraphContext` — this just prepends the instruction. Applies to BOTH return branches since both interpolate the same `graphSection` variable, so one edit covers both.)

Note the SIO-1013 grounded-gaps discipline (memory `reference_grounded_gaps_confidence_cap`): the "say you have no record rather than guessing" clause matters — do not let the LLM fabricate prior incidents when the section is empty.

### Fix B — a recall intent so phrasing doesn't matter (larger)
Fixes failure mode #1 and avoids wasteful fan-out. Two viable shapes — **pick one in brainstorming, don't assume**:

- **B1 (cheap, classifier-only):** add recall keywords to `COMPLEX_PATTERNS` (`classifier.ts:21`) — e.g. `/\b(before|previously|prior|history|historical|recur|recurring|past|last (week|month|time)|have we (seen|had|dealt))\b/i`. Guarantees such questions go `complex` → `graphEnrich` runs. Does NOT stop the live fan-out (still queries sub-agents). Minimal, low-risk.
- **B2 (proper intent):** add an optional `recall: boolean` (or `intent: "recall" | "investigate"`) to `entity-extractor.ts` `ExtractionSchema` (`:17`), set from the extractor prompt. Then in the graph (`packages/agent/src/graph.ts`) short-circuit a recall turn past the sub-agent fan-out straight to `graphEnrich` → aggregate, so it doesn't waste live queries. Bigger blast radius (touches state + graph edges); mirrors how `detectTopicShift`/AWS-router special-case the flow.

**Recommendation:** ship **Fix A + Fix B1** first (both tiny, immediately useful), and only do B2 if the wasted fan-out is a real cost. Confirm with the user in brainstorming before building B2.

## Verification

```bash
bun run typecheck && bun run lint && bun run yaml:check
bun run --filter @devops-agent/agent test          # classifier + aggregator + graph-knowledge suites
bun run --filter @devops-agent/knowledge-graph test # (lbug teardown may SIGTRAP/133 AFTER pass -- see gotcha below)
```
Targeted unit assertions to add:
- **Fix A:** a `prompt-context` test asserting `buildOrchestratorPrompt({ graphContext: "## Knowledge Graph..." })` contains the new "ANSWER FROM ... Similar prior incidents" instruction, and that an empty `graphContext` yields no instruction.
- **Fix B1:** `classifier.test.ts` — assert "have we seen this before?" / "what were the prior incidents?" classify `complex` via `patternClassify` (no LLM call needed).
- **Fix B2 (if chosen):** graph-routing test that a `recall` turn reaches `graphEnrich`/`aggregate` without dispatching sub-agents.

Manual probe (needs `KNOWLEDGE_GRAPH_ENABLED=true` + `lbug` installed, which is ABSENT locally/CI — see gotchas): seed a couple of `Incident`+`RootCause` rows, then ask "have we seen kafka lag before?" and confirm the answer cites the prior incident + its root cause. Without lbug, validate via the InMemoryGraphStore-backed unit tests instead.

## Files to modify

| File | Change | Fix |
|---|---|---|
| `packages/agent/src/prompt-context.ts` (`:108`) | wrap `graphSection` with a recall-usage instruction | A |
| `packages/agent/src/prompt-context.test.ts` (or nearest) | assert instruction present/absent | A |
| `packages/agent/src/classifier.ts` (`:21` COMPLEX_PATTERNS) | add recall keyword regex | B1 |
| `packages/agent/src/classifier.test.ts` | assert recall phrasings → complex | B1 |
| `packages/agent/src/entity-extractor.ts` (`:17` schema + prompt) | optional `recall`/`intent` field | B2 only |
| `packages/agent/src/graph.ts` | recall short-circuit past fan-out | B2 only |
| `packages/agent/src/state.ts` | new intent channel if B2 | B2 only |

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| LLM fabricates prior incidents when graph empty | Med | Fix A's "say you have no record rather than guessing" clause; follows SIO-1013 grounded-gaps |
| Recall keyword regex over-fires (marks normal turns complex) | Low | Keywords are specific ("prior", "have we seen"); complex is already the safe default so a false-complex is cheap |
| B2 state-channel touches many graph edges | Med | Prefer A+B1 first; only do B2 with explicit user sign-off |
| Graph disabled/`lbug` absent → `graphContext` empty | Certain in CI | Feature no-ops gracefully; Fix A handles the empty case; tests use InMemoryGraphStore |

## Out of scope

- LLM-callable `kg_*` tools for incident-analyzer (rejected in SIO-1026/1027 — the fan-out can't route a graph sub-agent; incident-analyzer uses the graph as enrichment, see memory `reference_incident_kg_enrichment_not_fanout`). Do NOT reintroduce a knowledge-graph sub-agent.
- Changing how `graphEnrich` searches (it already searches correctly).
- Memory-tier / Couchbase Agent Memory changes.

## Related code references (already-correct patterns to mirror)

- `packages/agent/src/graph-knowledge.ts:92-122` — `graphEnrich` (the working search + root-cause annotation).
- `packages/knowledge-graph/src/reader.ts` `buildGraphContext` / `rootCauseForIncident` / `priorRootCauses` — render + read (SIO-1026).
- `packages/agent/src/prompt-context.ts:64-99` — `buildLiveMemorySection`/`wikiSectionFor` are the pattern for an *explained* prompt section (Fix A should look like these).
- `packages/agent/src/graph.ts:114-153` — `detectTopicShift` + `awsEstateRouter` are precedents for special-casing the flow (pattern for B2).

## Memory references

- `reference_incident_kg_enrichment_not_fanout` — why incident-analyzer reaches the graph via `graphEnrich` enrichment, NOT the supervisor fan-out (the entity extractor only routes the 7 `DATA_SOURCE_IDS`). Critical: do not try to add a graph sub-agent.
- `reference_grounded_gaps_confidence_cap` — the "don't fabricate when ungrounded" discipline that Fix A's empty-graph clause follows.
- `reference_lbug_cypher_and_teardown_gotchas` — `lbug` absent locally/CI; `bun test <file>` can exit 133 at teardown AFTER assertions pass; validate via the package script or InMemoryGraphStore, and use `bun test <file> -t "<name>"` to see a real binder error.
- `reference_fresh_worktree_no_workspace_symlinks` — a fresh worktree needs `bun install` (+ possibly `ln -sfn` the `@devops-agent/*` links under `apps/web/node_modules`) or web tests throw "Export named X not found".
- `reference_main_preexisting_test_lint_failures` — main ships some pre-existing red (e.g. an `ingest-pipeline-edit.test.ts` lint violation as of this window); stash-and-rerun to separate yours from main's; don't fix unrelated failures (scope creep).
