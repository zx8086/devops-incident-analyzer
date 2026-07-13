# resolveIdentifiers: Canonical Identifier Resolution

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-07-13

`resolveIdentifiers` is a deterministic, LLM-free pipeline node that runs **once before the
sub-agent fan-out**. It turns the incident's loosely-named service (e.g. `order-service`) into the
**canonical identifiers that actually exist** in each in-scope datasource — the real Elastic
`service.name`, the CloudWatch log group, the Kafka topic/consumer group, the Couchbase scope map,
the Konnect control plane, and the GitLab numeric project id — and writes them to
`state.resolvedIdentifiers`. (Atlassian is deliberately not probed; see below.) The sub-agent focus
block then injects them so each
specialist queries the right handle on its first call instead of guessing a prefixed form.

- **Source:** `packages/agent/src/resolve-identifiers.ts`
- **Parsers:** `packages/agent/src/resolve-identifiers-parsers.ts`
- **Output type:** `ResolvedIdentifiers` in `packages/shared/src/agent-state.ts`
- **Renderer (consumer):** `buildResolvedBlock()` in `packages/agent/src/sub-agent-focus-block.ts`
- **Introduced:** SIO-1084; extended by SIO-1086/1087/1088 (elastic/couchbase), SIO-1095 (probe timeout)

---

## Why it exists

The incident's service token is frequently **not** the store's real identifier: `order-service`
lives in Elastic as `pvh-services-orders`, in CloudWatch as `/ecs/fargate/<estate>-orders-log-group`,
in Kafka as `orders-service-prd`. Without a resolution step each sub-agent either guesses a prefixed
name (which 404s / returns empty) or runs an expensive discovery loop of its own. `resolveIdentifiers`
does that discovery **once, cheaply, in parallel**, and hands the answers to every sub-agent.

Design invariants:

- **No LLM calls.** Every probe is a plain MCP tool invocation + a pure parser. Deterministic.
- **Enumerate-then-match, never guess.** Each datasource has a cheap "where to look" enumerator; the
  results are filtered to the focus with `matchesFocus()` (token overlap + normalized substring), which
  bridges plural/singular and prefix drift. It never fabricates a name it did not observe.
- **Non-fatal and best-effort.** Probes race a per-probe timeout and are wrapped in `safeProbe`; any
  failure (timeout, unreachable MCP, parse miss) simply **omits that datasource's block** and the graph
  proceeds exactly as if the node were disabled.
- **Gated OFF by default.** `RESOLVE_IDENTIFIERS_ENABLED` must be `true`/`1`. When disabled the node is a
  pure no-op returning `{}`.

---

## Execution model

```text
resolveIdentifiers(state)
  guard: RESOLVE_IDENTIFIERS_ENABLED?  -> no, return {}
  guard: focus.services present?       -> no, return { resolvedIdentifiers: undefined }  (clears stale)
  inScope = computeTargetSources(state)      // UI selection > entity-extracted > all
  if elastic in scope: warmElasticDeployments(state)   // SIO-1086, OFF the probe budget
  probes = [ each in-scope datasource -> safeProbe(id, probeX) ]   // all in PARALLEL
  settled = await Promise.allSettled(probes)
  merge non-empty results + { resolvedForTurn, resolvedForServices }
  return { resolvedIdentifiers: merged }  (or undefined if nothing resolved)
```

Key mechanics:

- **Scope selection** — `computeTargetSources()` mirrors the supervisor: UI selection wins, else the
  entity-extracted datasource set, else all. Over-probing a datasource the supervisor later drops is
  harmless.
- **Per-probe timeout** — `probeTimeoutMs()` reads `RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS`
  (positive integer within `[1, 2147483647]`), default **8000ms** (`DEFAULT_PROBE_TIMEOUT_MS`). All
  probes share this single wall-clock budget, so datasources that fan out across deployments/estates
  probe those **in parallel** (never a sequential loop, which would compound latency and time out the
  whole probe). Prior default was 4000ms; raised in SIO-1095 after atlassian/elastic probes timed out
  under normal proxy latency and dropped their grounding.
- **Elastic warm-up (SIO-1086)** — the elastic probe carries a mandatory `x-elastic-deployment`
  header, and `@langchain/mcp-adapters` forks a brand-new MCP session (full initialize handshake) on the
  first invoke with a given header set. `warmElasticDeployments()` opens that session with a
  `size:0, terminate_after:1` `match_all` **before** the timed probe, so the uncancellable cold connect
  happens off-budget (`ELASTIC_WARMUP_TIMEOUT_MS = 8000`) and the timed agg pays only query cost.
- **Staleness stamps** — the merged result carries `resolvedForTurn` (`state.messages.length`) and
  `resolvedForServices` (the focus snapshot). The focus-block renderer only injects a block when
  `resolvedForServices` still set-equals the current `focus.services`, so a prior-turn resolution against
  a different service set is never shown.

---

## Per-datasource probes

Each probe: (1) invokes one or two cheap enumeration tools, (2) parses the payload with a dedicated
parser, (3) filters to the focus, (4) returns a typed block or `{}`. `matchesFocus()` is the filter
unless noted.

### Elastic — `probeElastic` → `elastic: { serviceNames }`

- **Tool:** `elasticsearch_search` over `logs-*,logs-apm.*`, per target deployment (parallel).
- **Query:** `size:0` aggregation `by_service = terms(service.name, size:200)`, **pre-filtered** to
  `*<anchor-token>*` wildcards (`anchorWildcards`, one `wildcard` clause per tokenized focus term,
  capped at 8). SIO-1086: filtering *before* aggregating makes the agg exhaustive for every matching
  name regardless of document volume — a plain top-50 terms agg ranks by volume and drops low-volume
  services like `prana-order-service`.
- **Parser:** `parseElasticServiceAgg` → bucket keys. Candidates run through `pickServiceCandidates`
  (matchesFocus, with a longest-token substring fallback for sub-4-char names).
- **Output:** every real `service.name` matching the focus (verified live to surface
  `prana-order-service` + sibling `*order*` services the top-50 dropped).

### Couchbase — `probeCouchbase` → `couchbase: { scopes, indexInfo? }`

- **Tools:** `capella_get_scopes_and_collections` **and** `capella_get_system_indexes` together
  (`Promise.allSettled`, so an index-probe failure never blocks the scope map).
- **Parsers:** `parseCouchbaseScopeTree` → `scopes` (scope → collection names, **entire map, never
  filtered** — enumerating what exists is the fix); `parseCouchbaseSystemIndexes` → `indexInfo`
  (scope → collection → `{ hasPrimary, secondaryKeyFields }`).
- **Purpose (SIO-1087/1088):** the index info lets the focus block tag each collection
  `[PRIMARY index - SELECT * ok]` vs `[SECONDARY ONLY - lead WHERE on: <fields>]`, so the agent stops
  mistaking a `SELECT *` "no index available" failure for missing data and instead queries a WHERE
  leading on the index's first key.
- **Drift guard:** if the raw payload plainly contained index rows (`keyspace_id`/`scope_id`) but the
  parser extracted zero, that's shape drift — `indexInfo` is omitted (tags suppressed) rather than
  mislabeling every collection `[NO USABLE INDEX]`.
- **Note:** the only probe that does **not** filter by focus — the whole scope map is injected.

### AWS — `probeAws` → `aws: { logGroups }`

- **Precondition:** requires `state.awsTargetEstates` (AWS tools throw outside the `withAwsEstate` ALS
  scope); with no target estate the probe skips cleanly.
- **Tool:** `aws_logs_describe_log_groups` with `logGroupNamePattern = longestToken(focus)`, per estate
  (parallel, each inside `withAwsEstate`).
- **Parser:** `parseAwsLogGroups`; results filtered by `matchesFocus`.
- **Deliberately log-group-only:** ECS-service enumeration is **not** probed here — `aws_ecs_list_services`
  needs a `cluster` arg (a prior list-clusters hop), too heavy for a cheap pre-fan-out probe. The
  aws-agent RULES.md drives the ECS → `awslogs-group` derivation on the sub-agent side. (`ecsServices`
  exists in the type but is not populated by this node.)

### Kafka — `probeKafka` → `kafka: { topics, consumerGroups }`

- **Tools:** `kafka_list_topics` (`limit:500`) and `kafka_list_consumer_groups`, each try/caught
  independently.
- **Parsers:** `parseKafkaTopics`, `parseKafkaConsumerGroups`; both filtered by `matchesFocus`.
- **Gotcha:** does **not** pass a `filter` arg — the server compiles it as a raw `RegExp` and a
  non-regex token throws MCP `-32603`. Enumerate unfiltered, match client-side.

### Konnect — `probeKonnect` → `konnect: { controlPlaneId, controlPlaneName, serviceIds? }`

- **Tools:** `konnect_list_control_planes` (`filterName = longestToken`, `pageSize:10`), then
  `konnect_list_services` for the chosen control plane.
- **Parsers:** `parseKonnectControlPlanes`, `parseKonnectServices`.
- **Selection:** the control plane whose name matches the focus, else the first returned; then its
  services filtered by `matchesFocus`, lifting their `serviceId`s.

### GitLab — `probeGitlab` → `gitlab: { projectId, pathWithNamespace }`

- **Tool:** `gitlab_search` with `scope:"projects", search:longestToken`.
- **Parser:** `parseGitlabProjects`.
- **Selection:** the row matching the focus on `pathWithNamespace`/`name`, else the first; lifts the
  **numeric** `projectId` (guessing the path 404s — the numeric id is the reliable handle).

### Atlassian — not probed (SIO-1096)

There is **no atlassian probe**. The enumerate-then-name-match model that works for the other
datasources fundamentally does not fit Atlassian: **Jira projects are named by team/org (DSD, BP,
PANDP, B2BS), never by service**, so matching a project key/name against `order-service` resolves
nothing — the earlier `probeAtlassian` filtered every real project out and always returned `{}`.
And the answer never needs a project key anyway: the atlassian sub-agent searches **all** visible
projects by incident domain terms (`text ~ "AFS season code"` etc., per its SOUL), which returns the
right tickets in one call regardless of which project they live in. Removing the probe deletes dead
work and frees a hot-path probe slot.

---

## Output shape

`ResolvedIdentifiers` (`packages/shared/src/agent-state.ts`, `ResolvedIdentifiersSchema`):

```ts
{
  resolvedForTurn: number,          // state.messages.length (staleness stamp)
  resolvedForServices: string[],    // focus.services snapshot (staleness stamp)
  elastic?:    { serviceNames: string[] },
  couchbase?:  { scopes: Record<scope, collection[]>,
                 indexInfo?: Record<scope, Record<collection, { hasPrimary, secondaryKeyFields }>> },
  aws?:        { logGroups: string[], ecsServices?: string[] },
  kafka?:      { topics: string[], consumerGroups: string[] },
  konnect?:    { controlPlaneId?, controlPlaneName?, serviceIds? },
  gitlab?:     { projectId?, pathWithNamespace? },
  // no `atlassian` key -- atlassian is not probed (SIO-1096); the sub-agent searches by domain terms.
}
```

Every datasource key is **optional** — present only when its probe resolved something. A datasource is
omitted on timeout, unreachable MCP, empty enumeration, or a focus that matched nothing.

---

## How sub-agents consume it

`buildResolvedBlock()` in `sub-agent-focus-block.ts` renders a `RESOLVED IDENTIFIERS (candidates to
verify, probed this turn)` section into the datasource's focus block, but **only** when the staleness
stamp still matches the current focus. It renders per-datasource lines — e.g. the elastic block also
carries the SIO-1090 broad-query recipe, and the couchbase block carries the `[SECONDARY ONLY - lead
WHERE on: …]` tags. The agent is told these are *candidates to verify*, not gospel.

---

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `RESOLVE_IDENTIFIERS_ENABLED` | unset (off) | `true`/`1` enables the node; otherwise it is a pure no-op |
| `RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS` (SIO-1095) | `8000` | Per-probe wall-clock budget; positive integer in `[1, 2147483647]`, else the default. Before SIO-1095 the budget was a hardcoded 4000ms with no override. |

---

## Failure modes and observability

- **Probe timeout** → `resolveIdentifiers probe failed; omitting this datasource` (warn), datasource
  block omitted. If you see this repeatedly for a healthy MCP, raise
  `RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS`.
- **Per-deployment / per-estate failure** → warned individually; partial results from the other
  deployments/estates are still kept.
- **Couchbase index shape drift** → `couchbase index probe returned rows but parser extracted none`
  (warn), index tags suppressed (scope map still injected).
- **Nothing resolved** → `resolvedIdentifiers` is `undefined`; sub-agents run without the block, exactly
  as when the node is disabled.
- **Success** → `resolveIdentifiers produced candidates` (info) lists the resolved datasource keys.

---

## Related

- [agent-pipeline.md](agent-pipeline.md) — where this node sits in the graph (between `awsEstateRouter`
  and `detectTopicShift`).
- `sub-agent-focus-block.ts` — the renderer that injects these identifiers into each sub-agent prompt.
