# SIO-1445 spike: per-domain graphContext slice in sub-agent dispatch payloads

Research note. No code changes. See [SIO-1445](https://linear.app/siobytes/issue/SIO-1445/spike-evaluate-per-domain-graphcontext-slice-in-sub-agent-dispatch).

## Question

`graphEnrich`'s output (`state.graphContext`) is consumed only by the single-completion
aggregator today. Would sub-agents benefit from a narrow, per-domain, read-only slice of
it injected into their dispatch payloads?

## 1. What `graphContext` actually is

A single rendered markdown **string**, not structured data (`packages/agent/src/state.ts:186-189`):

```ts
graphContext: Annotation<string>({
	reducer: (_, next) => next,
	default: () => "",
}),
```

Populated by `graphEnrich` (`packages/agent/src/graph-knowledge.ts:168-303`, wired
`recordEntities -> graphEnrich -> awsEstateRouter`, `graph.ts:210-212`), from three
sources, each individually capped:

- **Service dependencies**: `priorRelationshipsForServices` -> `ServiceDependency[]`
  (`{from, to}` -- direct `DEPENDS_ON` neighbours only, `knowledge-graph/src/reader.ts:20-43`).
- **Similar prior incidents**: `nearest = (await similarIncidents(store, embedding, 12,
  state.requestId)).filter(inc => inc.ticketKey.length > 0).slice(0, 3)`
  (`graph-knowledge.ts:219-221`) -- vector search over 12 candidates, curated-only
  (must carry a ticketKey), hard-capped to 3, each annotated with a root cause and up
  to 3 resolving runbooks (`MAX_RESOLVED_BY_RENDERED = 3`, `reader.ts:659`).
- **Network context**: one line per affected service, `NETWORK_CONTEXT_MAX_LINES = 5`
  (`graph-knowledge.ts:41`).

None of these types carry a datasource/domain key. `ServiceDependency` is `{from, to}`;
`SimilarIncident`/`SimilarIncidentWithCause` (`reader.ts:268-276,652-655`) have no
`datasource` field. **A per-domain slice does not exist today and cannot be produced by
filtering existing fields -- it requires new tagging logic upstream** (deciding which
dep/incident is "relevant" to which of the 7 sub-agents' domains), not a subset
operation on structured data that already carries the key.

## 2. Realistic size

Every input is hard-capped at generation time (3 incidents, 5 network lines, 3 runbooks/
incident). A real fixture entry (`graph-knowledge.test.ts`) renders as roughly:

```
- [high] kafka lag outage (id inc1) -- prior root cause: consumer lag > 10K -- resolved by rb-1.md, rb-2.md, rb-3.md
```

~100-200 chars/entry. Worst case (3 incidents + a handful of dep lines + 5 network
lines) is a bounded string in the **low hundreds to low thousands of characters** --
not large in isolation.

## 3. How it's consumed today (the aggregator)

Inlined **verbatim, uncapped-at-consumption, unfiltered** -- capping happens only at
generation inside `graphEnrich`, never again downstream:

```ts
// aggregator.ts:215-223
const promptParts = buildOrchestratorPromptParts({
	runbookFilter, wikiFocus,
	graphContext: state.graphContext,
	...
});
```
```ts
// graph-section.ts:15-18
export function buildGraphSection(graphContext: string | undefined): string {
	if (!graphContext?.trim()) return "";
	return `\n\n---\n\n## Prior-Incident Recall\n...${graphContext}`;
}
```

This happens **once per incident** -- the aggregator runs one LLM call per turn.

## 4. The dispatch payload already carries it -- unread

This is the load-bearing finding of this spike. The supervisor's fan-out spreads the
**entire state object** into every `Send`, not a curated slice:

```ts
// supervisor.ts:106-114
return validSources.map(
	(dataSourceId) =>
		new Send("queryDataSource", {
			...state,
			...skippedState,
			currentDataSource: dataSourceId,
			dataSourceResults: [],
		}),
);
```

`graphContext` is on `state`, so it is **already present on every sub-agent's dispatch
payload today** -- it costs nothing extra to transit. `sub-agent.ts` (`queryDataSource`,
`runSubAgent`) never references `state.graphContext` anywhere; it is dead weight on the
wire, not a missing field. **The real question this spike answers is not "should we add
a payload field" but "should we start reading a field that already arrives for free."**

## 5. The actual injection point, and why the cost is NOT "7x"

`runSubAgent` already has the exact precedent shape for exactly this kind of
per-turn addition -- `state.correlationFetchDirective`, appended to a `volatileBlock`:

```ts
// sub-agent.ts:1451-1456
const volatileBlock = state.correlationFetchDirective
	? `${focusBlock}\n\n${state.correlationFetchDirective}`
	: focusBlock;
```

That block becomes part of the **system prompt**, via `buildCachedSystemMessage`:

```ts
// sub-agent.ts:1541-1544
const systemPrompt = buildCachedSystemMessage(
	baseSystemPrompt,
	`${volatileBlock}\n\n${buildBoundToolsBlock(tools)}`,
);
```

The comment at `sub-agent.ts:1536-1538` is the critical constraint: "up to 40 ReAct
iterations... share the Bedrock cache prefix... the per-turn investigation focus stays
volatile (**uncached**)." A `graphContext` slice injected here rides the **volatile**
half of the prompt -- outside the Bedrock cache-stable prefix.

**This means the cost multiplier is NOT 7 (one per dispatched sub-agent) -- it is 7 x
LLM-turns-per-sub-agent**, because the volatile block is re-sent, uncached, on every
`createReactAgent` loop iteration within a single sub-agent's turn, not just once at
dispatch. Real recursion limits (`sub-agent.ts:337-372`, `CYCLE_SUPER_STEPS = 3`):

| Datasource | recursionLimit | ~LLM turns/incident |
|---|---|---|
| elastic | (measured) 13 iterations, 12 tool steps | ~13 |
| aws | 60 | ~20 |
| couchbase | 45 | ~15 |
| gitlab | 60 (raised from 36, SIO measured 12 turns typical) | ~12-20 |
| default (kafka/konnect/atlassian) | 45 | ~15 |

## 6. Token-cost estimate

No tokenizer dependency in this repo (`grep -rl tiktoken` empty; no
`countTokens`/`estimateTokens` utility). Reusing the existing chars/token heuristic
comment in `packages/shared/src/embedding-truncate.ts:7-9` (~4.7 chars/token English
prose, ~3 chars/token token-dense content -- this slice is closer to prose):

- Slice size: ~500-1500 chars worst case (bounded, per section 2) -> **~110-320 tokens**
  at 4.7 chars/token.
- Per-sub-agent-turn cost (uncached, every iteration): 110-320 tokens x ~13-20 turns =
  **~1,400-6,400 tokens per sub-agent per incident**.
- Across up to 7 dispatched sub-agents (not all 7 fire every incident -- `validSources`
  is usually a subset): **worst case ~10K-45K additional uncached input tokens per
  incident** if all 7 fire and each runs near its recursion ceiling. Typical case
  (2-4 sub-agents dispatched, mid-single-digit turn counts before an answer) is
  meaningfully lower, plausibly **1K-8K tokens**.
- This is a **prompt-cache-defeating** cost specifically -- unlike the stable base
  prompt (cached once per 5-min TTL per SIO-1040), every one of these tokens is billed
  at full uncached rate on every iteration it's present.

Latency: no direct precedent to model against without a live trace; the token delta
above is the dominant proxy (each iteration's input-token count affects both cost and
latency roughly linearly at this scale).

## 7. Go/no-go recommendation: **No-go as specified; narrower version worth a second look**

**Against, as scoped (a full per-turn `graphContext` slice on every ReAct iteration):**
- The cost is not "one extra field on a dispatch" -- it's a recurring uncached tax
  multiplied by iteration count, landing in the same 1K-45K token range per incident
  as significant existing prompt sections, for content (3 similar incidents, capped
  dependency list) that is background color, not something a sub-agent needs to
  re-consult on every single tool-call cycle.
- No sub-agent code path reads `state.graphContext` today, and no per-domain structure
  exists to slice by -- "per-domain" would need new tagging logic built from scratch,
  which is a real implementation cost this spike hasn't scoped.
- The value case (e.g. "gitlab-agent skips re-deriving a prior-MR correlation it could
  read from the KG instead") is plausible but unverified -- no measured instance in
  this repo's traces of a sub-agent actually re-deriving something `graphContext`
  already knew. Worth checking against real incident-replay eval traces before funding
  more than a spike.

**Narrower alternative worth a follow-up spike, not this one:** inject the slice **once,
into the volatile block only on the FIRST LLM turn** (mirroring how `focusBlock` already
works, but explicitly excluded from the block on later iterations rather than resent
every turn) -- this collapses the "x turns" multiplier back down to "x1 per sub-agent,"
making the cost closer to the ~110-320 tokens/sub-agent estimated in section 6, not the
1.4K-6.4K per-sub-agent figure. That is a materially different, much cheaper proposal
and deserves its own ticket if pursued, since it changes the injection mechanism (would
need a "first turn only" flag threaded through `runSubAgent`'s message-building path,
which doesn't exist today) rather than reusing the existing `volatileBlock` pattern
as-is.

## If a follow-up ticket is filed

It should scope:
1. The "first-turn-only" injection mechanism (new state, not reuse of `volatileBlock`
   verbatim, since that block is resent every iteration by design today).
2. New per-domain tagging on `ServiceDependency`/`SimilarIncident` (schema change in
   `packages/knowledge-graph/src/reader.ts`), or an alternative: don't slice per-domain
   at all, inject the same global 3-incident summary to every dispatched sub-agent
   (simpler, but doesn't satisfy the "per-domain" framing of the original question).
3. A SIO-640-style edge-gate / feature flag so this stays opt-in and measurable in
   production before becoming unconditional, per this repo's established pattern for
   every prior KG-adjacent addition (SIO-850, SIO-1026, SIO-1100).
