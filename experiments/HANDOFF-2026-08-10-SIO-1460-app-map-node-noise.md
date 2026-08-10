# HANDOFF: Application map renders too many nodes (dependency noise + blind truncation)

- **Date**: 2026-08-10
- **Ticket**: SIO-1460 -- https://linear.app/siobytes/issue/SIO-1460/application-map-too-many-nodes-focus-scope-collapse-dependency (Backlog; move to In Progress when starting)
- **Parent feature**: SIO-1457 -- https://linear.app/siobytes/issue/SIO-1457/application-map-service-topology-dependencies-card-sibling-of-sio-1204 (merged as PR #644, commit `0a7899d6`; a11y follow-up SIO-1459 merged as PR #646, commit `bafeca04`)
- **Repo state**: `main` @ `6fda85e8`
- **Suggested branch**: `claude/app-map-node-noise-sio1460` (off main; CodeRabbit auto-reviews normally since the base is main)

## TL;DR

The first live incident run (313.8s turn, 6 datasources) produced an ApplicationTopologyCard with **150 nodes / 185 links, truncated at the MAX_NODES cap** -- an unreadable hairball. The real services (martech-contact, martech-voucher, martech-stock, martech-order, martech-marketing-consent, corrected-delivery-dates-service, ...) are buried under high-cardinality purple `dependency` nodes: dozens of per-locale storefront hosts (`www.calvinklein.<tld>:443` for what looks like every country site), per-queue AMQP destinations (`AMQP 1.0/ddm.contact.sync...`, `AMQP 1.0/ddm.voucher...`), and in-process vert.x event-bus addresses (`vert.x/contact`, `vert.x/nominowcontact`, ...). Success = the card renders a readable, focus-relevant graph well under the cap on the same estate, with bus/in-process pseudo-dependencies gone, host families collapsed, and truncation (when it still happens) dropping the LEAST relevant nodes instead of whatever happened to be inserted last.

## Context -- how this ticket came to be

SIO-1457 (spec: `docs/superpowers/specs/2026-08-08-application-topology-design.md`, PR #644) added the per-incident application map: `buildApplicationTopology` parses the elastic APM destination aggregation (`by_source` on `service.name` x `by_destination` on `span.destination.service.resource`) plus kafka consumer-group outputs. Two v1 decisions interact badly on a real estate:

1. **"Non-matching nodes still render"** -- focus scoping only sets the KG-anchor `service` field; it never filters the map. The deterministic baseline aggregation is estate-wide (100 sources x 50 destinations = up to 5000 pairs), so every instrumented service and every destination it calls lands on the card.
2. **Every distinct destination resource string is its own `dep:` node** -- `span.destination.service.resource` is high-cardinality in this estate: per-locale hosts, per-queue AMQP addresses, vert.x in-process addresses. Only kafka-shaped destinations are skipped.

Combined with first-N truncation, the map hits the cap and may even drop the focus services themselves.

## Where the bodies are buried

All in `packages/agent/src/application-topology.ts` unless noted (line numbers verified on `6fda85e8`):

**Caps** (`:23-24`):
```ts
export const MAX_NODES = 150;
export const MAX_EDGES = 300;
```

**Only kafka is skipped; AMQP/vert.x pass through** (`:182-187`):
```ts
// span.destination.service.resource values pointing at the message bus (e.g.
// "kafka", "kafka/orders") are skipped: Kafka edges come from the kafka
// datasource's consumer-group tools, and a producer-side guess from APM would
// conflict with the deliberate PRODUCES_TO absence (no system of record).
function isKafkaDestination(resource: string): boolean {
	return /^kafka(\/|$)/i.test(resource.trim());
}
```

**Destination classification -- every non-service resource becomes its own dependency node, no normalization** (`:214-249`, the load-bearing loop):
```ts
const sourceNames = new Set(dest.data.by_source.buckets.map((b) => b.key));
for (const src of dest.data.by_source.buckets) {
	const srcId = serviceNodeId(src.key);
	upsertNode(acc, { id: srcId, kind: "service", name: src.key,
		service: matchesFocus(src.key, focus) ? src.key : undefined });
	for (const d of src.by_destination.buckets) {
		const resource = d.key.trim();
		if (resource.length === 0 || isKafkaDestination(resource)) continue;
		const detail = edgeDetail(d.avg_duration?.value, d.error_count?.doc_count, d.doc_count);
		if (sourceNames.has(resource) || (focus.length > 0 && matchesFocus(resource, focus))) {
			// ... service node + calls edge
		} else {
			const dstId = dependencyNodeId(resource);
			upsertNode(acc, { id: dstId, kind: "dependency", name: resource });
			addEdge(acc, { from: srcId, to: dstId, kind: "calls", detail });
		}
	}
}
```

**Blind first-N truncation -- Map insertion order, no relevance** (`:323-341`):
```ts
function capTopology(acc: Accumulator, turn: number): ApplicationTopology | undefined {
	if (acc.nodes.size === 0) return undefined;
	let truncated = false;
	let nodes = Array.from(acc.nodes.values());
	if (nodes.length > MAX_NODES) {
		nodes = nodes.slice(0, MAX_NODES);   // <-- insertion order, focus services can be dropped
		truncated = true;
	}
	...
}
```

**Estate-wide aggregation sizes** -- `packages/agent/src/app-map-baseline.ts:38-39` (`MAX_SOURCE_SERVICES = 100`, `MAX_DESTINATIONS_PER_SERVICE = 50`) feeding `destinationAggregationArgs` (`:57-73`).

**Chart labels every dependency node** -- `apps/web/src/lib/app-chart.ts:39-44` (`LABELED_KINDS` includes `"dependency"`), which is why the hairball is also a label storm.

Note: `edgeDetail` already carries `d.doc_count` (call volume) into the edge label, but the VOLUME is not retained on nodes/edges as data -- ranking (step 4) needs it, so capture it during the parse.

## The fix (step-by-step)

All builder changes are in `packages/agent/src/application-topology.ts` and stay pure (called twice per turn; no I/O). Keep `mergeApplicationTopologyOverlay` untouched -- overlay edges reference `svc:`/`cg:`/`topic:`/`aws:` ids which are unaffected by dependency grouping.

**Step 1 -- extend the bus skip to AMQP and vert.x.** Replace `isKafkaDestination` (`:182-187`) with:

```ts
// Message-bus and in-process destinations are skipped: kafka edges come from the
// kafka datasource (and producer-side guesses conflict with the PRODUCES_TO
// non-goal -- the same rationale covers AMQP queue destinations), and vert.x
// addresses are an IN-PROCESS event bus, not a network dependency at all.
// SIO-1460: observed live as "AMQP 1.0/ddm.contact.sync..." and "vert.x/contact".
function isBusDestination(resource: string): boolean {
	return /^(kafka(\/|$)|amqp(\s|\/|$)|vert\.x\/)/i.test(resource.trim());
}
```

and update the call site at `:225`. Decision point flagged: skipping AMQP loses RabbitMQ visibility entirely (unlike kafka there is no other datasource observing it). If that visibility matters, collapse instead of skip -- one `dep:amqp-bus` node (or per-queue-family) -- but the recommendation is SKIP for v1: the queue names shown live are per-entity sync queues that say nothing an incident responder acts on from this card.

**Step 2 -- collapse host-family dependencies.** Before `dependencyNodeId(resource)` in the else-branch (`:243-245`), normalize host-shaped resources:

```ts
// "www.calvinklein.de:443" / "www.calvinklein.fr:443" / ... are ONE logical
// storefront dependency. Host-shaped resources (hostname[:port]) group by their
// registrable-domain approximation (label before the public suffix); everything
// else (postgresql, redis, elasticsearch) passes through unchanged.
function dependencyFamily(resource: string): { id: string; name: string } {
	const m = resource.match(/^([a-z0-9.-]+\.[a-z]{2,})(:\d+)?$/i);
	if (!m?.[1]) return { id: dependencyNodeId(resource), name: resource };
	const labels = m[1].toLowerCase().split(".");
	// Approximate registrable domain: last two labels, three when the pair is a
	// two-part public suffix (co.uk / com.au style).
	const take = /^(co|com|org|net|ac|gov)$/.test(labels.at(-2) ?? "") ? 3 : 2;
	const family = labels.slice(-take).join(".");
	return { id: dependencyNodeId(family), name: family };
}
```

Use `family.id`/`family.name` for the node; on repeat sightings the node already merges (upsertNode). To surface the collapse, count members: extend the local accumulator with a `Map<string, Set<string>>` of family -> raw hosts, and after the parse loop rewrite grouped node names to `"<family> (<n> hosts)"` when n > 1. The `dep:` id changes for grouped hosts are safe: dependency nodes are never written to the KG (`deriveApplicationTopology` strips only `svc:`/`cg:`/`topic:` -- `packages/agent/src/application-topology-kg.ts:30-40`) and the overlay never mints `dep:` ids.

**Step 3 -- focus-scope retention.** New pure post-filter between the parse loops and `capTopology` (call it inside `buildApplicationTopology` at `:345-360`):

```ts
// SIO-1460: when the turn HAS a focus and it matched anything, keep only the
// focus-matched services plus their 1-hop neighborhood. An empty match set
// collapses to show-all (the SIO-1030 empty-collapse contract) -- scoping to
// nothing must never blank a card that has real data.
function scopeToFocus(acc: Accumulator): void {
	const anchored = new Set(
		Array.from(acc.nodes.values()).filter((n) => n.kind === "service" && n.service).map((n) => n.id),
	);
	if (anchored.size === 0) return;
	const keep = new Set(anchored);
	for (const e of acc.edges.values()) {
		if (anchored.has(e.from)) keep.add(e.to);
		if (anchored.has(e.to)) keep.add(e.from);
	}
	for (const id of acc.nodes.keys()) if (!keep.has(id)) acc.nodes.delete(id);
	for (const [k, e] of acc.edges.entries()) {
		if (!keep.has(e.from) || !keep.has(e.to)) acc.edges.delete(k);
	}
}
```

CAUTION: `matchesFocus` with empty focus returns true (SIO-1030), so on unfocused turns every service is `service`-anchored and `scopeToFocus` keeps everything service-adjacent -- verify that is acceptable, or gate the call on `focusServices.length > 0` for clarity. Also decide whether kafka `cg:`/`topic:` nodes should always survive scoping (recommend yes when the cg name focus-matches; they already carry `service` when matched -- but topics/cgs are NOT `kind === "service"`, so extend `anchored` to any node with `service` set).

**Step 4 -- ranked truncation.** In `capTopology` (`:323-341`), sort before slicing instead of taking insertion order. Compute degree from `acc.edges` and rank: (a) `service` field set (focus anchor), (b) `kind === "service"`, (c) degree descending. Keep the existing dangling-edge filter and `truncated` flag. Add the same ranking inside `mergeApplicationTopologyOverlay`'s cap path (it reuses `capTopology`, so one fix covers both).

**Step 5 (optional, cheap) -- shrink the baseline aggregation.** `app-map-baseline.ts:38-39`: drop to `MAX_SOURCE_SERVICES = 50`, `MAX_DESTINATIONS_PER_SERVICE = 25` -- the card and prompt use far less than 100x50, and the KG derive caps at 50 edges anyway. Purely a payload/latency saving; keep if contested.

**Step 6 (optional) -- delabel dependency nodes at rest.** If the card is still dense after steps 1-4, remove `"dependency"` from `LABELED_KINDS` in `apps/web/src/lib/app-chart.ts:39-44` (hover/emphasis still shows names; the SIO-1459 text view lists them all regardless).

**Tests to update/add** (`packages/agent/src/application-topology.test.ts`):
- `DESTINATION_AGG_JSON` fixture: add `AMQP 1.0/ddm.contact.sync`, `vert.x/contact`, and 3+ `www.calvinklein.<tld>:443` destinations -- assert bus destinations are skipped and the storefront family collapses to ONE `dep:calvinklein.com` node named with the host count.
- The existing "kafka-bus destinations are skipped" test extends to the new patterns.
- New ranked-truncation test: over-cap fixture where a focus-anchored service is inserted LAST -- assert it survives and an unanchored dependency is dropped.
- New scope test: focused fixture keeps the 1-hop neighborhood and drops disconnected services; empty-focus fixture keeps everything.
- `app-chart.test.ts` only if step 6 is taken (label expectation flips).
- Check `summarizeApplicationTopologyForPrompt` expectations -- grouped dependency names change the `[dependency]` lines.

## Verification

```bash
bun run typecheck && bun run lint && bun test --cwd packages/agent --isolate && bun test --cwd apps/web --isolate
```

Expected: all green (agent suite was 4049 pass, web 277 pass at SIO-1459 merge; counts grow with the new tests).

Live probe (the real acceptance test -- unit fixtures cannot reproduce the estate cardinality):
1. Start the web app from a worktree per `reference_worktree_web_server_replay_env` (env quirks documented there), run the SAME incident query that produced the screenshot (martech/CRM-flavored incident hitting elastic+kafka).
2. Expect: card well under 150 nodes, no `Truncated to the first ... nodes` footer, zero `vert.x/*` nodes, zero `AMQP 1.0/*` nodes (or one bus node if collapse was chosen), one `calvinklein.com (N hosts)` node instead of dozens, all martech-* services present and labeled.
3. Toggle check: `APP_MAP_BASELINE_ENABLED=false` still renders whatever the ReAct loop fetched; KG writes unchanged (`KG_APP_MAP_WRITE_ENABLED=false` suppresses).
4. KILL every service you start and prove ports free: `lsof -nP -iTCP:5173 -sTCP:LISTEN` empty.

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/application-topology.ts` | isBusDestination (step 1), dependencyFamily + family counts (step 2), scopeToFocus (step 3), ranked capTopology (step 4) |
| `packages/agent/src/application-topology.test.ts` | fixtures + new tests per above |
| `packages/agent/src/app-map-baseline.ts` | optional agg-size reduction (step 5) |
| `packages/agent/src/app-map-baseline.test.ts` | only if step 5 changes asserted sizes |
| `apps/web/src/lib/app-chart.ts` (+ test) | optional dependency delabeling (step 6) |
| `docs/superpowers/specs/2026-08-08-application-topology-design.md` | append an SIO-1460 addendum describing scoping/grouping semantics |

## Workflow

- Branch off `main`; Linear SIO-1460 Backlog -> In Progress when starting; never set Done manually (the PR link auto-transitions on merge).
- PR ready-for-review (never draft), base `main` -- CodeRabbit auto-reviews normally here (the stacked-PR skip from SIO-1459 does not apply). Triage per the SHA-scoped completion check in CLAUDE.md.
- Commit template:

```bash
git commit -m "$(cat <<'EOF'
SIO-1460: <what changed>

<why -- one short paragraph>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Registrable-domain approximation groups wrong (`co.uk`-style suffixes beyond the small allowlist) | Medium | Approximation is display-only (never persisted); worst case two families merge -- acceptable; extend the suffix list if seen live |
| AMQP skip loses the only RabbitMQ visibility | Medium | Flagged as an explicit decision point in step 1; collapse-to-one-node is the fallback |
| Focus-scope hides a cross-service edge the responder needed | Low-Medium | 1-hop neighborhood retention; show-all on empty focus; the SIO-1459 text view still lists everything retained |
| Ranked truncation changes prompt-summary line ordering | Low | `summarizeApplicationTopologyForPrompt` iterates edges, not the node slice -- verify its tests |
| `scopeToFocus` on empty-focus turns (matchesFocus([]) === true anchors everything) | Medium | Gate on `focusServices.length > 0` and test both paths -- see `reference_focus_match_empty_collapse` |

## Out of scope

- Konnect route edges / `apiRoute` node kind (blocked on SIO-1439).
- Producer-side Kafka/AMQP edges (`PRODUCES_TO` non-goal stands).
- A standing estate-wide map viewer outside chat.
- Changing KG write semantics (`deriveApplicationTopology` untouched; dep nodes are never persisted).
- Network map (`network-topology.ts`) -- its universe is naturally bounded; no symmetric change needed.

## Related code references (correct patterns to reuse)

- `packages/agent/src/network-topology.ts:573-612` -- sibling builder's capTopology-equivalent (same slice-and-flag idiom being upgraded here).
- `packages/shared/src/focus-match.ts:78-96` -- matchesFocus semantics incl. the empty-focus-matches-all contract and MIN_TOKEN_LENGTH fuzzy rules.
- `packages/agent/src/extract-findings.ts` (SIO-1030 logCard) -- the scoped-vs-show-all + `droppedAll` diagnostic convention; add an equivalent log line when scopeToFocus drops nodes so over-scoping is visible in dev logs.
- `packages/agent/src/application-topology-kg.ts:30-40` -- proof that `dep:` ids never reach the KG (grouping is persistence-safe).

## Memory references

- `reference_sio1457_application_map_feature` -- feature seams, id-prefix contract, elastic string-payload gotcha, mock-pollution trap for sse-pump imports.
- `reference_focus_match_empty_collapse` -- the matchesFocus([]) === true hazard central to step 3.
- `reference_worktree_web_server_replay_env` -- how to run the web app from a worktree for the live probe.
- `feedback_handoff_docs_main_branch` / `feedback_no_direct_push_to_main` -- handovers commit to main directly; code goes through PR.
