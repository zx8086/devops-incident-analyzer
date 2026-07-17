# HIL learning Phase 3 — rebuild closure + per-item review edits — design

Date: 2026-07-17
Tickets:
- [SIO-1125](https://linear.app/siobytes/issue/SIO-1125) — HIL learning loop (parent epic)
- [SIO-1128](https://linear.app/siobytes/issue/SIO-1128) — Phase 3: retrieval polish + rebuild closure

Prior phases (all merged to `main`): SIO-1126 (Phase 1 lane), SIO-1127 (Phase 2 bindings/heuristics/runbook), plus the follow-ups SIO-1130/1131/1132/1134/1135/1133. Phase 1/2 design: `docs/superpowers/specs/2026-07-16-hil-learning-loop-design.md`.

## Goal

Close the last rebuild-from-facts gap and give the human real editing power at the review gate.

Two deliverables (the ticket's other three items are out of scope — see below):

1. **`kg-resolution` replay** — the `RESOLVED_BY` edge (the "resolved by X" read path) is written at learn-apply time and mirrored to a durable `kg-resolution` fact, but that fact has no replay mapper, so a rebuild-from-facts silently drops every resolution edge. Add the mapper + replay entry.
2. **Per-item review edits (text-only)** — the review card is approve/reject only today; the editing story is "reject + re-run". Add inline editing of the prose fields so a human can correct the distiller's wording before applying, and have the human-edited text be what lands in the graph and durable facts.

## Scope decisions (from brainstorming)

- **In:** `kg-resolution` replay; per-item edit UX restricted to **text-only** prose fields.
- **Out (explicit):**
  - `KG_BINDINGS_READ_DATASOURCES` default widening — not selected; an operator sets the env in the meantime.
  - `kg-binding-invalidated` replay — **already shipped** in SIO-1127 (`rebuild.ts:214`).
  - Structured `HAS_ROOT_CAUSE.source` + `RootCause.invalidatedHypotheses` columns + a "Ruled out:" reader line — dropped. `composeRootCauseDescription` (`apply.ts:58-66`) already folds "Ruled out: …" into the `description` string, which renders correctly through the existing reader; the ticket flags the columns as "only if description-folding proves too lossy", and it isn't.

## Constraints carried from prior work

- **Rebuild parity (SIO-1103).** Every KG write mirrors a durable fact whose annotation shape `rebuild.ts` can replay. Replay ORDER matters: a resolution edge needs its Incident first.
- **Grounding invariants must not be breakable by an edit.** A binding's `resourceId` "must appear literally in the ticket text" (`hil-learning.ts` `BindingCorrectionSchema`, enforced by `verifyProposalEvidence`); `causeClass`/heuristic `name` carry kebab regexes; `bindingKind` is re-validated against `BindingKindSchema` at write time (`apply.ts`). The edit design **sidesteps all of these** by making only invariant-free prose fields editable — no re-validation needed.
- **Interrupt re-execution.** LangGraph re-executes an interrupted node from its top on resume; compute and `interrupt()` already live in separate nodes (`learnDistill` / `learnReviewGate`). Edits ride the existing resume value, so nothing new re-executes.
- **Soft-fail writes.** Learning never breaks the turn.
- **First editable-review pattern.** No card in the codebase binds a `textarea`/`contenteditable` to a reviewed item today (iac plan-review and this card are display-only). This introduces the pattern; keep it small and local.

---

## Part 1 — `kg-resolution` replay

The fact written today (`apply.ts:206-215`):

```ts
recordKeyDecision({
  requestId: state.requestId,
  decision: `Incident ${match.incidentId} resolved by runbook ${rc.runbookFilename} (via ${ticketKey})`,
  annotations: { kind: "kg-resolution", incident_id: match.incidentId, runbook: rc.runbookFilename, ticket: ticketKey },
});
```

### Change: `packages/knowledge-graph/src/rebuild.ts`

Add a mapper + adapter mirroring the existing `ticketLinkFromAnnotations` / `applyTicketLink` pair:

```ts
export interface ResolutionRecord {
  incidentId: string;
  runbook: string;
}

export function resolutionFromAnnotations(a: AnnotationMap): ResolutionRecord | null {
  if (!a.incident_id || !a.runbook) return null;
  return { incidentId: a.incident_id, runbook: a.runbook };
}

async function applyResolution(store: GraphStore, rec: ResolutionRecord): Promise<void> {
  await linkResolution(store, rec.incidentId, [rec.runbook]);
}
```

Add `linkResolution` to the `./writer.ts` import. Insert the replay entry **after `kg-incident`** (the only ordering constraint: `linkResolution` does `MATCH (i:Incident {id})`, so the Incident must already exist). It is independent of `kg-root-cause` (RESOLVED_BY targets a Runbook, not a RootCause); placing it after `kg-incident-ticket` and before `kg-root-cause` keeps the ordered block readable:

```ts
await replayKind(store, "kg-incident", incidentFromAnnotations, recordIncident, opts.dryRun);
await replayKind(store, "kg-incident-ticket", ticketLinkFromAnnotations, applyTicketLink, opts.dryRun);
await replayKind(store, "kg-resolution", resolutionFromAnnotations, applyResolution, opts.dryRun);   // NEW
await replayKind(store, "kg-root-cause", rootCauseFromAnnotations, recordRootCause, opts.dryRun);
await replayKind(store, "kg-binding", bindingFromAnnotations, recordServiceBinding, opts.dryRun);
await replayKind(store, "kg-binding-invalidated", invalidatedBindingFromAnnotations, applyInvalidatedBinding, opts.dryRun);
```

Update `printGaps()` so the "NOT rebuilt" list no longer implies RESOLVED_BY is graph-only (it currently lists only Incident embeddings + Finding/CORRELATES_WITH, so this is a comment refresh acknowledging resolutions are now rebuilt).

### Tests

- `rebuild.test.ts`: `resolutionFromAnnotations` unit — full fact maps to `{incidentId, runbook}`; missing `incident_id` or `runbook` → null.
- `ladybug.integration.test.ts` (real engine): record an incident, map a `kg-resolution` annotation through `resolutionFromAnnotations`, `applyResolution` it, then assert a direct `MATCH (i:Incident)-[:RESOLVED_BY]->(r:Runbook) RETURN count(*)` reads the edge back — the round-trip the in-memory fake cannot exercise.

---

## Part 2 — Per-item review edits (text-only)

The edited content threads UP the mirror of how `proposal` threads DOWN. Six seams.

### The contract — `packages/shared/src/hil-learning.ts`

Add a type **separate** from `HilDecisions` (approve/reject is untouched). Edits are keyed by item id → the whitelisted text fields:

```ts
// SIO-1128: per-item text edits from the review card, keyed by item id. Only the
// invariant-free prose fields are editable (grounded/structured fields stay read-only),
// so an edit can never break resourceId grounding, causeClass/name regexes, or bindingKind.
export type HilItemEdits = Record<string, Record<string, string>>;

// The set of editable field names per item kind. The card AND apply use this whitelist,
// so an out-of-whitelist key from a hand-crafted payload is ignored, not applied.
export const HIL_EDITABLE_FIELDS = {
  rootCause: ["description", "resolution"],
  binding: ["reason"],
  heuristic: ["description", "whenToUse", "procedure"],
  memoryFact: ["text"],
} as const;
```

A Zod schema `HilItemEditsSchema = z.record(z.string(), z.record(z.string(), z.string()))` for the resume endpoint.

### The merge — a pure function (new `packages/agent/src/learn/edits.ts`)

```ts
// Merge whitelisted text edits over the distiller's proposal, per item id. Only fields in
// HIL_EDITABLE_FIELDS for that item's kind are applied; anything else is ignored. Returns a
// new proposal (no mutation). Empty/whitespace edits fall back to the original (a blank
// textarea must not erase a field).
export function applyEdits(proposal: LearningProposal, edits: HilItemEdits): LearningProposal
```

Unit-testable with zero graph. This is the single override point.

### Card — `apps/web/src/lib/components/LearningProposalCard.svelte`

- A local `let edits = $state<Record<string, Record<string, string>>>({})`, seeded lazily from the distiller values.
- Each editable prose field renders as a `<textarea>` (Tailwind-only, matching brand palette) bound through a small helper `editValue(id, field)` / `setEdit(id, field, v)` that writes into `edits`. Non-editable fields (causeClass, resourceId, bindingKind, datasource, name, evidence) stay static text.
- An item is "edited" only when the value differs from the original (trim-compared); unchanged fields are omitted from the emitted map, so the payload stays minimal.
- `onApply` widens: `onApply: (decisions: HilDecisions, edits: HilItemEdits) => void`. Both Apply buttons pass `edits` (Reject-all passes `{}` — nothing is applied so edits are moot).
- Rejected items: their edits are dropped from the emitted map (a rejected item is never written).

### Store — `apps/web/src/lib/stores/agent.svelte.ts`

```ts
function resolveHilReview(decisions: HilDecisions, edits: HilItemEdits) {
  if (!hilLearningReview) return;
  return resumeHilLearning({ review: { decisions, edits } }, hilLearningReview.threadId);
}
```

Widen the `resumeHilLearning` payload type's `review` to `{ decisions; edits? }`. Update the mount in `+page.svelte` to pass both args.

### Resume endpoint — `apps/web/src/routes/api/agent/learning/resume/+server.ts`

Extend `ResumeRequestSchema.review`:

```ts
review: z.object({
  decisions: z.record(z.string(), z.enum(["approve", "reject"])),
  edits: HilItemEditsSchema.optional(),
}).optional(),
```

Thread into the resume value (the gate-binding guard is unaffected — this stays the `hil_learning_review` variant):

```ts
{ decisions: body.review?.decisions ?? {}, edits: body.review?.edits ?? {} }
```

### Gate — `packages/agent/src/learn/distill.ts` `learnReviewGate`

The resume value type widens to `{ decisions: HilDecisions; edits?: HilItemEdits }`. Write both back:

```ts
return { hilDecisions: decision?.decisions ?? {}, hilEdits: decision?.edits ?? {} };
```

Add a new replace-reducer state field `hilEdits: HilItemEdits` in `state.ts` (default `{}`), and clear it in `turnReset` alongside the other `hil*` fields.

### Apply — `packages/agent/src/learn/apply.ts`

After the destructure (`:125-129`), build the effective proposal once and use it everywhere the current code uses `proposal`:

```ts
const proposal = state.hilEdits && Object.keys(state.hilEdits).length > 0
  ? applyEdits(state.hilProposal, state.hilEdits)
  : state.hilProposal;
```

No write site changes — every rootCause/binding/heuristic/memoryFact write already reads off `proposal`, so the human-edited text flows into both the graph writes and the mirror facts automatically. Because only invariant-free fields are editable, the existing write-time validations (`BindingKindSchema`, `causeClass` hashing, grounding) are untouched.

### Tests

- `edits.test.ts`: `applyEdits` — a whitelisted field is overridden; a non-whitelisted key (e.g. `resourceId`, `causeClass`) is ignored; a blank/whitespace edit falls back to the original; an empty edits map returns the proposal unchanged (identity).
- `apply.test.ts`: with `hilEdits` set, the mirror fact / graph write carries the edited text (e.g. an edited `memoryFact.text` is the recorded decision text; an edited rootCause `description` reaches `recordRootCause`).
- `distill.test.ts` (or ticket.test): `learnReviewGate` writes `hilEdits` from the resume value.
- Resume endpoint test: `review.edits` is accepted and threaded; a malformed edits shape is rejected by the schema.
- Card: the store-level `resolveHilReview(decisions, edits)` path is the testable seam (Svelte runes components aren't unit-testable here); assert it POSTs `review.edits`.

---

## Data flow (edit path, mirror of the proposal path)

```text
distiller -> hilProposal (state) --interrupt--> SSE hil_learning_review --> card (proposal shown)
card (user edits prose) --onApply(decisions, edits)--> store.resolveHilReview
  --> POST /learning/resume {review:{decisions, edits}} --> resumeValue
  --> learnReviewGate reads {decisions, edits} --> writes hilDecisions + hilEdits
  --> applyLearnings: proposal = applyEdits(hilProposal, hilEdits) --> graph writes + mirror facts carry edited text
```

## Files to modify

| File | Change |
|---|---|
| `packages/knowledge-graph/src/rebuild.ts` | `resolutionFromAnnotations` + `applyResolution` + replay entry + printGaps refresh |
| `packages/knowledge-graph/src/rebuild.test.ts` | mapper unit tests |
| `packages/knowledge-graph/src/ladybug.integration.test.ts` | real-engine resolution replay |
| `packages/shared/src/hil-learning.ts` | `HilItemEdits` type + `HIL_EDITABLE_FIELDS` + `HilItemEditsSchema` |
| `packages/agent/src/learn/edits.ts` (new) | `applyEdits` pure merge |
| `packages/agent/src/learn/edits.test.ts` (new) | merge unit tests |
| `packages/agent/src/learn/distill.ts` | `learnReviewGate` reads `edits`, writes `hilEdits` |
| `packages/agent/src/learn/apply.ts` | `proposal = applyEdits(...)` after destructure |
| `packages/agent/src/state.ts` | `hilEdits` state field + `turnReset` clear |
| `apps/web/src/routes/api/agent/learning/resume/+server.ts` | `review.edits` schema + resumeValue thread |
| `apps/web/src/lib/stores/agent.svelte.ts` | `resolveHilReview(decisions, edits)` + payload type |
| `apps/web/src/lib/components/LearningProposalCard.svelte` | textarea inputs + `onApply` widening |
| `apps/web/src/routes/+page.svelte` | pass `edits` from the card |
| web mocks (if any new agent-barrel export) | update per the union-superset rule |

## Verification

```bash
bun run typecheck && bun run lint && bun run test
cd packages/knowledge-graph && bun test src/ladybug.integration.test.ts   # real-engine resolution replay
```

Manual e2e (`KNOWLEDGE_GRAPH_ENABLED=true LIVE_MEMORY_ENABLED=true LIVE_MEMORY_BACKEND=agent-memory`):

```bash
# learn from a ticket, reach the review gate, edit a memory fact's text, approve, apply
curl -N -X POST localhost:5173/api/agent/learning/resume \
  -d '{"threadId":"hil-e2e","review":{"decisions":{"fact-1":"approve"},"edits":{"fact-1":{"text":"the human-edited fact text"}}}}'
# expect the apply summary; verify the recorded fact carries the edited text (agent-memory / KG reader)
# Rebuild closure: knowledge-graph:rebuild --dry-run and confirm kg-resolution -> N replayed
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| An edit erases a field (blank textarea) | Medium | `applyEdits` falls back to the original on empty/whitespace |
| Out-of-whitelist edit key from a hand-crafted payload mutates a grounded field | Low | `applyEdits` applies ONLY `HIL_EDITABLE_FIELDS` keys; everything else ignored |
| Edited text reintroduces PII | Low | `recordKeyDecision` redacts on write (unchanged); memory facts already pass through it |
| Svelte card not unit-testable | Certain | test the store seam (`resolveHilReview`) + `applyEdits`; the card is thin glue |
| New agent-barrel export breaks web mock cache | Certain if added | `applyEdits` lives in agent-internal path (apply.ts imports it); only add to web mocks if a web route imports it (it doesn't) |

## Out of scope
`KG_BINDINGS_READ_DATASOURCES` widening; structured root-cause columns; any change to grounded/structured field editability; re-running the distiller verifier on edits.

## Memory references
`reference_hil_learning_lane_sio1126`, `reference_hil_phase2_writers_and_runbook_gate`, `reference_incident_ticketkey_null_breaks_uncurated_filter`, `reference_web_store_runes_not_unit_testable`, `reference_web_client_no_shared_barrel_value_imports`, `feedback_repo_is_public_sanitize_before_commit`
