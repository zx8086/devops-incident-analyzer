# Renovate follow-up guard + deployment-wide history — design spec

## Context

Reported by the user via 3 screenshots + GitLab MR evidence: after SIO-1474 fixed display-name resolution (confirmed working — "upgrade the 'Custom UDP Logs' integration" correctly triggers `renovate/ap-cld-udp`), a follow-up "Please check again" (asked because `triggerRenovateUpdate` said no MR had appeared yet) returned "No pending Renovate update found for '...' on '...'" — even though the real MR ([!526](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/526)) had already merged into `main` by then.

Two independently confirmed, distinct gaps in `packages/agent/src/iac/`:

### Finding 1: no follow-up guard for a pending Renovate trigger

Root cause, confirmed via live logs, a LangSmith trace, and direct code trace:

1. `triggerRenovateUpdate`'s "no MR yet" branch (`nodes.ts:966`) ends the turn with a plain message, not an interrupt — the next user message starts a **fresh turn**.
2. `TURN_START_RESET` (`nodes.ts:1692`) correctly nulls `renovateTarget`/`renovateMarker` every turn (verified working as designed in SIO-1474's own review).
3. **The classifier has no deterministic guard for "check on my Renovate trigger."** Confirmed live: `classified IaC intent ... "intent":"renovate-integration-update","query":"Please check again"`. It falls through to the same intent as a *fresh* upgrade request.
4. That routes to `extractRenovateTarget`, whose LLM call has nothing to extract from "Please check again" and emits a placeholder value (reproduced exactly: `deployment: "...", integration: "..."`) that is non-empty and so passes the `!deployment || !integration` guard (`nodes.ts:212`).
5. `resolveRenovateMarker` correctly finds zero dashboard matches for `"..."` and reports the accurate-but-wrong "no pending update" message.

**This exact class of bug was already solved once**, for the Fleet-upgrade lane, via SIO-928 (`nodes.ts:1575-1586`): a deterministic pre-LLM guard —

```ts
if (state.fleetApplyPipelineId != null && looksLikeFleetStatusCheck(query)) {
    return { intent: "pipeline-status" };
}
```

— force-routes status-check phrasing to the right node before the classifier LLM ever runs, keyed on a **durable, cross-turn state field** (`fleetApplyPipelineId`, deliberately excluded from `TURN_START_RESET`, set when a Fleet apply dispatches, cleared when it resolves). The Renovate lane never got the equivalent field or guard — `renovateMarker`/`renovateTriggerAtIso` are both turn-scoped, so nothing survives to tell `classifyIacIntent` "a trigger just fired, watch for it."

### Finding 2: no deployment-wide Renovate history (KG or memory)

The user's separate, correct observation: ap-cld has had prior Renovate integration updates before (for other packages, not `udp`), and expected those to be visible/recalled. Confirmed via code trace (independently verified by a research agent):

1. **The KG never records a Renovate trigger at all.** `lane-knowledge.ts`'s own header comment states KG writes cover only 3 non-gitops lanes — drift-reconcile, fleet-upgrade, synthetics-push. `priorChangesForDeployment` (`packages/knowledge-graph/src/reader.ts:461-484`) queries `ElasticDeployment-[:CHANGED_BY]->ConfigChange`, and no `ConfigChange.workflow` value is ever `"renovate"` — a grep for "renovate" across the whole `knowledge-graph` package returns zero hits.
2. **Agent Memory does write a `renovate-trigger` fact** (`teardownIac`, `nodes.ts:11371`, only when `state.renovateMrUrl` is set — i.e. only after an MR is found) with both `deployment` and `marker` annotations. But the only reader, `recallPriorRenovateTriggers` (`nodes.ts:12270`), **requires an exact marker match** — a deliberate prior design decision (`nodes.ts:12253-12259`) to keep the *approval-gate card's* "we've triggered this before" panel scoped to the one integration being discussed, not polluted with unrelated ones.
3. **No deployment-only ("any integration") recall path exists.** The sibling Fleet-upgrade lane already has this exact pattern — `recallPriorFleetUpgrades` (`nodes.ts:12213`) is deployment-only, no version filter — proving the shape exists in this codebase and was simply never applied to Renovate.

## What already exists (do not touch)

- `resolveIntegrationSlug` (SIO-1474) and its position in the graph — unrelated to both findings, unchanged.
- `filterDashboardMatches`'s marker-substring matching — unchanged.
- `recallPriorRenovateTriggers`'s existing marker-scoped call inside `enrichRenovateTarget` (`nodes.ts:684`) — stays as-is, still feeding the approval-gate card's "this exact integration" panel. This spec **adds** a second, deployment-wide recall alongside it; it does not replace or broaden the existing marker-scoped one (avoids regressing the card's focused framing, which was itself a deliberate design choice).
- `recordLaneConfigChange` (`lane-knowledge.ts:55`) and its `LaneChangeInput`/`ChangeOutcome` types — reused unchanged, following the exact fleet-upgrade call shape (`nodes.ts:12749-12756`).
- `looksLikeFleetStatusCheck` / `looksLikeChangeRequest` — unchanged; a new, Renovate-specific predicate is added alongside them, not merged into them (different trigger phrasing, different guard state).

## Design

### Fix 1: durable in-flight marker + deterministic follow-up guard

**New durable state field** `renovateInFlightMarker: { deployment: string; marker: string } | null` (mirrors `fleetApplyPipelineId`'s shape/lifecycle exactly):

- **Set** by `triggerRenovateUpdate` (`nodes.ts:895`) alongside its existing `renovateTriggerAtIso` return, whenever the trigger call succeeds (tick + play both succeeded) — regardless of whether `watchRenovateMr`'s subsequent poll finds the MR immediately or not, since the field's job is "there is an outstanding trigger a user might ask about," not "the poll timed out."
- **Cleared** (`null`) by `watchRenovateMr` once it finds the MR (`nodes.ts:952-957`, the success branch) — a resolved trigger needs no further re-checking, mirroring `checkFleetApplyStatus` clearing `fleetApplyPipelineId` on a terminal fleet-upgrade result.
- **NOT included in `TURN_START_RESET`** — this is the entire point; it must survive across turns the same way `fleetApplyPipelineId` does.

**New deterministic classifier guard**, mirroring SIO-928's shape exactly, added to `classifyIacIntent` alongside the existing `fleetApplyPipelineId` guard (`nodes.ts:1580-1586`):

```ts
if (state.renovateInFlightMarker != null && looksLikeRenovateStatusCheck(query)) {
    return { intent: "renovate-integration-update" /* or a distinct value, see below */ };
}
```

**New pure predicate** `looksLikeRenovateStatusCheck(text: string): boolean`, colocated with `looksLikeFleetStatusCheck` (`nodes.ts:1409`), reusing the same `STATUS_CUES` list (or a shared subset — "check again", "check on it", "any update", "status" etc. apply identically to a pending Renovate MR) plus the same "a version number disqualifies this as a status check" guard.

**Routing decision** (per the "re-poll for the MR directly" answer): the guard routes straight to `watchRenovateMr`, not back through `extractRenovateTarget`/`resolveIntegrationSlug`/`resolveRenovateMarker`. This requires:

- A new graph edge/entry point: `classifyIacIntent`'s intent-fan-out router (`graph.ts:106-123`) needs a way to reach `watchRenovateMr` directly, bypassing the extract/resolve/enrich/gate chain entirely (the trigger already happened — there is nothing left to extract, resolve, or re-approve).
- The cleanest mechanism, matching how `pipeline-status` already reaches `watchPipeline` directly (`graph.ts:119-120`): add a new intent value, checked before existing branches. **Reusing the literal `"renovate-integration-update"` intent value is not viable** — the existing fan-out for that intent always starts at `extractRenovateTarget` (`graph.ts:113-114`), which would re-run extraction pointlessly. This spec introduces a new intent value `"renovate-status-check"`, routed straight to `watchRenovateMr`, keeping the existing `"renovate-integration-update"` intent's meaning and routing completely unchanged (no risk of regressing SIO-1474's fresh-trigger path).
- `watchRenovateMr`'s existing signature already takes what it needs from `state.renovateMarker` (`nodes.ts:937`) — but that field is turn-scoped and will be `null` on this new turn. `watchRenovateMr` needs a small adjustment: fall back to `state.renovateInFlightMarker` when `state.renovateMarker` is null (a re-check turn), keeping today's first-turn behavior (where `renovateMarker` is freshly set) unchanged. `state.renovateTriggerAtIso` (also read by `watchRenovateMr`, line 947) has the same turn-scoping problem and needs the identical treatment — carried onto `renovateInFlightMarker` as a third field (`triggerAtIso`) rather than a second durable field, since the two values are always set/cleared together.

Revised field shape: `renovateInFlightMarker: { deployment: string; marker: string; line: string; triggerAtIso: string } | null` — `line` is included because `watchRenovateMr`'s eventual "opened the MR" success message and the KG/memory writes (Fix 2) both want the human-readable dashboard line text (`chore(deps): [ap-cld] udp to v2.5.1`), not just the raw marker slug.

### Fix 2: KG write + deployment-wide recall for Renovate history

**KG write**, added to `triggerRenovateUpdate`, immediately after its trigger call succeeds (right before its existing `return { renovateTriggerAtIso: triggerAtIso }` at `nodes.ts:895`) — following the exact fleet-upgrade call shape (`nodes.ts:12749-12756`), which likewise writes once at dispatch time, not on each subsequent poll:

```ts
await recordLaneConfigChange({
    id: state.requestId,
    deployment: target.deployment,
    workflow: "renovate",
    outcome: "proposed",
    summary: `renovate ${target.deployment} -> ${marker.marker}`,
    threadId: state.threadId || undefined,
});
```

**Single write site, not one per poll**: exactly one `ConfigChange` per logical trigger, written once the tick+play succeed — not repeated on every `watchRenovateMr` re-check (this spec's Fix 1 can now cause multiple re-check turns for the same trigger; without a single write site those turns would each try to write again). `mrUrl` is omitted here since it isn't known yet at trigger time; `watchRenovateMr`'s eventual `renovateMrUrl` result is available to a human reading the assistant's own message and to the marker-scoped Agent Memory fact (`teardownIac`, `nodes.ts:11371`, unchanged) — extending the KG write to update the `ConfigChange` with the MR url once found is explicitly out of scope for this spec (see below).

**Outcome mapping**: a Renovate trigger's terminal states are narrower than gitops/fleet-upgrade's `proposed | applied | rejected | failed`. This flow never applies (a human always merges the Renovate MR outside the agent) and never explicitly fails at the tick/play stage (both failure branches in `triggerRenovateUpdate` already return early via `blockedReason`, which skips the write entirely — matching `recordLaneConfigChange`'s own `outcome === null`-skips convention). So the only outcome this lane ever writes is `"proposed"` — a change has been proposed via the ticked dashboard checkbox + played schedule. `"applied"`/`"rejected"`/`"failed"` are never used by this lane, matching how fleet-upgrade already leaves `"rejected"` unused for its own reasons.

**New recall function** `recallPriorRenovateTriggersForDeployment(deployment: string): Promise<string>`, mirroring `recallPriorFleetUpgrades` exactly (`nodes.ts:12213-12228`):

```ts
export async function recallPriorRenovateTriggersForDeployment(deployment: string): Promise<string> {
    if (selectedBackend() !== "agent-memory" || !deployment) return "";
    try {
        const hits = await searchAgentMemory("elastic-iac", "", { deployment, kind: "renovate-trigger" }, 8, {
            deterministic: true,
        });
        return renderRenovateLearnings(hits);
    } catch (error) {
        log.warn(/* ... */);
        return "";
    }
}
```

Reuses the existing `renderRenovateLearnings` (`nodes.ts:12297`) unchanged — same rendering, same dedup-by-`mr_url` behavior; a deployment-wide query just returns more/different hits than the marker-scoped one.

**Wiring** (per the "automatic, same as `recallDeploymentKgChanges`" answer): added to `enrichRenovateTarget`'s existing `Promise.all` (`nodes.ts:672-685`) as a fourth parallel call, alongside the existing marker-scoped `recallPriorRenovateTriggers`. Both recalls run; the card gets two distinct pieces of context — "have we triggered *this* integration before" (existing, unchanged) and "what other Renovate triggers has this *deployment* had" (new). Needs one new state field, `renovateDeploymentHistory: string` (default `""`), threaded through the same 6 layers SIO-1473/SIO-1472 already established for `renovateRecentChanges`/`renovatePriorTriggers` (state → `TURN_START_RESET` → interrupt payload → SSE schema → sse-pump/agent-reducer → `RenovateTriggerChoiceCard.svelte`), rendered as its own collapsed section on the card (same `<details>` pattern SIO-1473 used for affected policies), separate from the existing "prior triggers" panel so the two don't visually merge into one ambiguous list.

## What this does NOT do

- Does not touch the marker-scoped `recallPriorRenovateTriggers`'s existing filter or its card panel — it stays exactly as-is, a second panel is added alongside it.
- Does not add a KG write for the *fresh-trigger* path retroactively (historical triggers before this ships have no KG record and will not be backfilled) — only new triggers going forward get recorded.
- Does not update the `ConfigChange` node with the MR url once `watchRenovateMr` finds it — the KG record for a Renovate trigger is written once, at trigger time, with `mrUrl` omitted. The MR url still reaches the user (assistant message) and Agent Memory (`teardownIac`'s existing marker-scoped fact) unchanged; only the KG's `ConfigChange.mrUrl` field stays empty for this lane. Retrofitting that is a separate, later enhancement if the "recent changes" panel's missing MR link turns out to matter in practice.
- Does not change `resolveIntegrationSlug`, `filterDashboardMatches`, or `extractRenovateTarget`'s prompt (SIO-1474's territory, unrelated).
- Does not add a KG write on every re-check poll — exactly one write per trigger, at the point the trigger itself succeeds.
- Does not attempt to write a `"rejected"` or `"failed"` outcome for a Renovate trigger — the lane has no such terminal state today, and inventing one is out of scope.

## Testing

- Unit tests for `looksLikeRenovateStatusCheck` (same shape as existing `looksLikeFleetStatusCheck` tests): status-check phrasing with `renovateInFlightMarker` set routes to the new intent; a version-number query never matches; a fresh "upgrade X" request is unaffected.
- Unit tests for the new `classifyIacIntent` guard: `renovateInFlightMarker` null → guard never fires (existing LLM-classification path unchanged); set + status-check phrasing → new intent; set + a clearly-new upgrade request (names a different integration) → existing LLM path still wins (guard must not swallow legitimate new requests).
- Unit tests for `watchRenovateMr`'s fallback to `renovateInFlightMarker` when `renovateMarker` is null, and confirmation it still clears `renovateInFlightMarker` on success.
- Unit tests for `recallPriorRenovateTriggersForDeployment` (mirrors `recallPriorFleetUpgrades`'s existing test suite: soft-fail on non-agent-memory backend, soft-fail on search error, correct filter shape).
- Unit test confirming `recordLaneConfigChange` is called exactly once per successful trigger (not per re-check poll) with `workflow: "renovate"`.
- Live verification once implemented: repeat the originally reported repro (trigger a fresh integration on ap-cld, say "check again" before the MR appears) and confirm the second turn re-polls instead of re-extracting; separately, confirm a *new* trigger for a *different* integration on ap-cld surfaces the deployment-history panel showing the `udp` trigger (or whichever fired first) once one exists.
