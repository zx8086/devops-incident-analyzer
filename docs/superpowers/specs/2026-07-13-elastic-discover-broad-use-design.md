# Elastic sub-agent: collapse to discover -> broad -> use

**Date:** 2026-07-13
**Ticket:** SIO-1090 (to be created)
**Supersedes the runtime behaviour of:** SIO-1029, SIO-1084 (elastic portions), SIO-1085, SIO-1086 (index/field guidance), SIO-1089
**Branch:** `claude/afs-season-code-data-gap-9b5ded`

## TL;DR

The elastic sub-agent finds a chronic error's data only when the LLM simultaneously guesses the right index, the right text field, and a window that contains the data. When it misses on any axis it gets an empty result, does not trust it, and permutes queries until a loop guard stops it -- reporting "no data" while the data is present. Four layers (`resolveIdentifiers` injection, focus block, SOUL procedure, loop guard) all encode "APM error logs / `error.exception.message` / incident-bounded window" and then add machinery to survive the empties that assumption produces.

Live probe (eu-b2b, 2026-07-13, MCP :9080) refutes the assumption: the incident message `"Unable to fetch AFS season code"` lives **overwhelmingly in `message` in the generic application logs (`.ds-logs-aws_fargate_eu_oit.prd-*`), ~104k+ docs**, and only marginally in `error.exception.message` in APM error logs (**303 docs**). The mandated target is the minority store; the field holding the majority of the data is one the SOUL explicitly forbids (`message`/`body.text`).

Fix: replace the multi-step, index/field-pinned procedure with **discover -> broad -> use**. Discover which service names AND index families carry the service (an agg the agent already runs); run ONE broad `multi_match` phrase query across the candidate text fields over `logs-*,logs-apm.*` with a wide default window; use the hits. Strip the loop guard to exact-duplicate detection + a hard call-count backstop.

## Evidence (live, validated 2026-07-13)

Source of truth: elastic MCP on `:9080`, deployment `eu-b2b`. All counts `track_total_hits: true`.

- **Two runs, same query logic, only the window differs** (LangSmith, threads `6a156cb4...` and `d56e90b3...`):
  - Run 1 (worked): `service.name=prana-order-service`, window `now-7d`, index `logs-apm.error-*` -> **34 hits**.
  - Run 2 (failed): same names, window `now-24h` then a 1-hour incident slice -> **0 hits x ~20**, permuted across 6 name variants x 2 windows, then loop-guard stop -> report said "no data".
- **Why 24h/1h is legitimately empty:** Run 1's own `by_day` agg shows `latest_occurrence: 2026-07-11T05:40:23Z` -- the error stopped firing ~2 days before the incident ran. A 24h window on 2026-07-13 correctly contains zero.
- **The message lives in TWO index families, not one** (probe: `multi_match` phrase over `[message, body.text, error.exception.message, error.message]`, no window, `_index` terms agg):
  - `.ds-logs-aws_fargate_eu_oit.prd-*` (generic app logs): tens of thousands of docs.
  - `.ds-logs-apm.error-default-*` (APM error logs): tens of thousands of docs.
- **Field breakdown, no window** (per-field `match_phrase`):
  - `message`: 10,000+ (display cap; real count ~104k+) -- the generic app-log field the SOUL FORBIDS.
  - `error.exception.message`: 303 -- the APM field the SOUL MANDATES.
  - `body.text`: 0. `error.message`: 0.

Conclusion: the current pin sends the agent at the field holding ~0.3% of the signal and forbids the field holding the rest. No window-widening reaches a field the query never names.

## Current state (where the bodies are buried)

- `agents/incident-analyzer/agents/elastic-agent/SOUL.md:16-129` -- the STEP 1 -> 1.5 -> 2 -> 3 procedure. Line 18: "Application errors from OTel services live in `logs-apm.error-*`". Line 22: "never use `body.text`/`message.text`". STEP 2 keeps the absolute incident window with no widen path. STEP 1.5 widens only `logs-apm.error-*` / `error.exception.message`.
- `packages/agent/src/sub-agent-focus-block.ts:90-96` -- injects, per turn: "Query APM errors in index `logs-apm.error-*` ... `match_phrase` on `error.exception.message` ... WIDEN the @timestamp window ... BEFORE running discovery". Hard-pins index + field.
- `packages/agent/src/sub-agent-loop-guard.ts` -- the widen one-shot grant (`widenRetryAllowed`), best-answer latch (`bestResult`/`latchedStopMessage`), widen-window message (`LOOP_GUARD_WIDEN_WINDOW_MESSAGE`), post-discovery grant (`postDiscoveryRequeryAllowed`), discovery-aware gating (`discoveryRan`). All exist to survive narrow-query thrash.
- `packages/agent/src/resolve-identifiers.ts` (elastic probe) -- correctly resolves `service.name` from `logs-*,logs-apm.*`; its output is then narrowed to the error-logs pin by the focus block.

## Design: discover -> broad -> use

Three phases. No "is it present? -> now confirm the error -> now widen -> now discover" ladder. No per-name permutation. No second run to recover from a self-inflicted empty.

### Phase 1 -- Discover (names AND index families)
One aggregation the agent already runs, extended by one sub-agg:
```json
{ "deployment": "<deployment>", "index": "logs-*,logs-apm.*", "size": 0,
  "query": { "wildcard": { "service.name": "*<anchor-token>*" } },
  "aggs": {
    "by_service": { "terms": { "field": "service.name", "size": 100 } },
    "by_index":   { "terms": { "field": "_index", "size": 50 } } } }
```
Returns the real `service.name`(s) and which index families carry the anchor. Load-bearing and bounded; runs once.

### Phase 2 -- Broad search (one query)
For the resolved service name(s), ONE query across all candidate text fields over both index families, wide by default:
```json
{ "deployment": "<deployment>", "index": "logs-*,logs-apm.*", "size": 5,
  "track_total_hits": true,
  "query": { "bool": {
    "must": [ { "multi_match": {
        "query": "<cited-error>", "type": "phrase",
        "fields": [ "message", "error.exception.message", "body.text" ] } } ],
    "filter": [
      { "terms": { "service.name": [ "<resolved-name>", "..." ] } },
      { "range": { "@timestamp": { "gte": "now-30d" } } } ] } },
  "sort": [ { "@timestamp": "desc" } ] }
```
- Wide by default (`now-30d`, no `lte`) so a chronic/lagging error is caught on the first pass. Decision: window is wide by default; the incident window is applied only when reporting, not as a pre-filter.
- `multi_match` phrase over the three candidate fields means the query does not depend on knowing in advance whether the message is an APM exception (`error.exception.message`) or a plain log line (`message`).
- `terms` on the resolved names searches all resolved variants in one query -- no per-name permutation.

### Phase 3 -- Use it
Report directly from the hits: which `_index` and field matched, exact count, latest `@timestamp`, sample messages. If the caller needs incident-window scoping, note how many of the hits fall inside the incident window vs the wider window -- do not re-query. Done.

If Phase 2 returns zero even at `now-30d` AND discovery in Phase 1 surfaced no matching service, THEN report absent -- this is the only path to an "absent" conclusion.

## Changes by file

| File | Change |
|---|---|
| `agents/incident-analyzer/agents/elastic-agent/SOUL.md` | Replace STEP 1->1.5->2->3 (lines ~16-129) with the three-phase discover->broad->use. Remove "errors live in `logs-apm.error-*`" and the `message`/`body.text` prohibition. Keep cluster-health/node/connectivity/healthy-state sections verbatim. |
| `packages/agent/src/sub-agent-focus-block.ts` | Replace the elastic block at lines 90-96 with broad-field guidance: "search `message`, `error.exception.message`, `body.text` across `logs-*,logs-apm.*`; resolved names are candidates; window wide by default." Keep the resolved-service-name injection (lines 84-85). |
| `packages/agent/src/sub-agent-loop-guard.ts` | Strip to exact-duplicate stop (`seenSignatures`) + hard `MAX_UNPRODUCTIVE_SEARCHES` backstop. Remove `widenRetryAllowed`, `bestResult`/`latchedStopMessage`/`LOOP_GUARD_LATCHED_STOP_LEAD`, `LOOP_GUARD_WIDEN_WINDOW_MESSAGE`, `postDiscoveryRequeryAllowed`, `discoveryRan` gating, `timeWindowWidened`. Keep `isDiscoveryCall` only if still needed to avoid stopping the one discovery agg; otherwise remove. `stopMessageFor` collapses to duplicate-stop / hard-cap message. |
| `packages/agent/src/sub-agent-loop-guard.test.ts` | Rewrite to cover the reduced surface: duplicate stop, hard-cap stop, discovery agg not stopped. Delete latch/widen/post-discovery tests. |
| `packages/agent/src/resolve-identifiers.ts` | No behaviour change to the probe. Confirm its elastic output (service names) still flows to the focus block unchanged. |

## Loop guard: what stays, what goes (decision: strip to duplicate-stop + hard cap)

STAYS:
- Exact-duplicate detection (`seenSignatures`, `toolCallSignature`, `reserveSignature`) -- cheap, correct, prevents an identical-query loop.
- `MAX_UNPRODUCTIVE_SEARCHES` hard cap -- guarantees termination well under recursionLimit 40 regardless of LLM behaviour.
- Not stopping the single discovery agg (so Phase 1 always runs).
- AWS `aws_logs_start_query` guarding is UNTOUCHED (separate failure mode, separate ticket lineage).

GOES:
- `widenRetryAllowed` / `LOOP_GUARD_WIDEN_WINDOW_MESSAGE` -- compensated for narrow windows; Phase 2 is wide by default.
- `bestResult` / `latchedStopMessage` / `LOOP_GUARD_LATCHED_STOP_LEAD` -- the trailing-empty-amnesia fix; with one broad query there is no trail of empties to latch against.
- `postDiscoveryRequeryAllowed` -- compensated for the discovery->requery ladder; the ladder is gone.
- `discoveryRan` soft-stop gating -- the soft stop it gated is gone.

Rationale: every removed piece exists to recover from empties caused by the narrow index/field/window pin. Remove the pin (broad query) and there is nothing to recover from; the duplicate-stop + hard cap are sufficient termination guarantees.

## Verification

Live (MCP :9080, eu-b2b):
1. Phase 1 agg for anchor `order` returns `service.name` buckets incl. an order-service-family name AND `by_index` shows both `logs-apm.error-*` and `logs-aws_fargate_eu_oit.prd-*`.
2. Phase 2 broad query for the resolved name(s), `now-30d`, `multi_match` over the three fields, returns the ~104k `message` + 303 `error.exception.message` docs (i.e. non-zero, matching the live probe).
3. Replay the failing incident through `/api/agent/stream` (thread reset) and confirm the elastic datasource now returns hits and the report cites the AFS message with count + latest timestamp, instead of "no data".

Automated: `bun run typecheck && bun run lint && bun run test` (full suite -- loop-guard tests are rewritten, not partially run).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Broad `multi_match` over 3 fields + `logs-*,logs-apm.*` is slower than a pinned single-index query | Medium | `size:5` + `track_total_hits:true` is one round trip; the live probe ran in ~18s for a 100M-index no-window agg, and the scoped phrase query is far cheaper. Acceptable for an incident tool. |
| Removing the latch reintroduces trailing-empty amnesia if the LLM still issues multiple queries | Low | With one broad query the trail does not exist; the duplicate-stop + hard cap bound any residual permutation. If the LLM still wanders, the report reflects the broad-query hit which is the first result observed. |
| `body.text` field mapping absent in some indices | Low | `multi_match` tolerates missing fields (no error); a field with no mapping simply contributes no hits. |
| Another incident's message genuinely lives only in APM errors | Low | The `multi_match` includes `error.exception.message`, so APM-only messages are still matched. |

## Out of scope

- AWS `aws_logs_start_query` loop guarding and year-drift (`correctYearDrift`) -- separate, working, untouched.
- `resolveIdentifiers` probe internals for non-elastic datasources (couchbase/aws/kafka/etc.).
- The confidence-cap / gaps-section logic in the aggregator.
- Header injection (SIO-1086) -- verified top-level and correct; not this bug.

## Related code references (patterns to follow / integrate with)

- `packages/agent/src/sub-agent-instrumentation.ts:102-129` -- where `shouldShortCircuit` / `reserveSignature` / `recordResult` are called; the reduced guard must keep this call-site contract.
- `packages/mcp-server-elastic/src/tools/core/search.ts:210-220,413` -- the tool forwards the query body verbatim and renders the 43-byte empty string; no server change needed.
- `packages/agent/src/graph.ts:164-165` -- resolveIdentifiers node edging (unchanged).

## Memory references

- `reference_elastic_empty_is_narrow_time_window` -- the narrow-window mechanism this spec generalizes (now: also wrong-index/wrong-field).
- `reference_sio1085_query_examples_and_malformed_syntax` -- the copy-paste-query pattern the SOUL uses; being replaced.
- `reference_resolve_identifiers_node_and_discovery_guard` -- the resolveIdentifiers node whose output is kept.
- `reference_apm_otel_service_name_and_index_mapping` -- "zero docs" false-negative on `logs-apm.app.*`; same class of bug.
- `feedback_validate_every_claim_against_source` -- why every count in this spec is a live probe.
