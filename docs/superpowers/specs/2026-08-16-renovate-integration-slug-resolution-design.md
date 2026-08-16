# Renovate integration slug resolution — design spec

## Context

Reported by the user (screenshots + "How did we miss Custom Logs UDP?"): asking the elastic-iac agent "In the ap-cld deployment, upgrade the 'Custom UDP Logs' integration" returned "No pending Renovate update found for 'Custom UDP Logs' on 'ap-cld'," even though the GitLab Dependency Dashboard had a genuinely pending entry (`chore(deps): [ap-cld] udp to v2.5.1`, marker `renovate/ap-cld-udp`).

Root cause, confirmed by direct code read (`packages/agent/src/iac/nodes.ts`) and independently re-verified by a research agent:

1. **`extractRenovateTarget`** (`nodes.ts:224-245`) extracts `{deployment, integration}` from free-form user text via an LLM call. Its prompt asks for "the named integration package alias" with examples that are already-correct Renovate/EPM slugs (`prometheus`, `cisco_ftd`, `system`) and gives zero guidance that Kibana Fleet's UI shows a different, human-readable **display name** ("Custom UDP Logs") for the same package (**slug** `udp`). Free-form input naming the display name is extracted close to verbatim.
2. **`filterDashboardMatches`** (`nodes.ts:266-285`) does a deterministic, case-insensitive **substring** match of `target.integration` against the Renovate dashboard's `marker` text (e.g. `renovate/ap-cld-udp`). `"custom udp logs"` is not a substring of `"ap-cld-udp"`, so it correctly returns zero candidates — triggering the accurate-but-unhelpful "No pending Renovate update found" message.

This function's own comment explicitly states its substring looseness is intentional and warns against "fixing" it into stricter token matching — any fix must not touch its matching semantics. The fix instead needs to happen upstream: resolve the user's phrasing to the real package slug *before* `filterDashboardMatches` ever runs.

Confirmed via repo-wide search: no display-name-to-slug mapping table, Fleet EPM lookup, or fuzzy-matching logic exists anywhere in the repo today.

## What already exists

`enrichRenovateTarget` (`nodes.ts:532-`, reached only *after* a dashboard match already succeeded) already calls Kibana Fleet's package list endpoint:

```
GET {kibanaUrl}/api/fleet/epm/packages?withPackagePoliciesCount=true
Authorization: ApiKey <apiKey>
kbn-xsrf: true
```

using `resolveKibanaConfig(deployment)` (`nodes.ts:418-425`, derives the Kibana URL from the deployment's existing `ELASTIC_<DEPLOYMENT>_URL`/`_API_KEY` env vars via `.es.` → `.kb.` hostname substitution) and matches `items[].name === target.integration` — i.e. it already assumes `target.integration` is a correct slug by the time it runs. This call, its auth, its config resolution, and its response-shape parsing are all reused unchanged by this spec; only a new call site earlier in the flow is added.

**Verified against Elastic's Kibana Fleet API docs** (`operation-get-fleet-epm-packages`) and the Kibana source (`x-pack/platform/plugins/shared/fleet/common/types/models/epm.ts`, `PackageListItem`/`RegistrySearchResult`): every item in this list response carries both `name` (slug, e.g. `udp`) and **`title`** (display name, e.g. `"Custom UDP Logs"`) as plain top-level string fields — not nested, not detail-endpoint-only. This is the ground truth this design resolves against.

## Design

### New node: `resolveIntegrationSlug`

Inserted between `extractRenovateTarget` and `resolveRenovateMarker`:

```
extractRenovateTarget → resolveIntegrationSlug → resolveRenovateMarker → {enrichRenovateTarget → renovateTriggerGate | teardown}
```

**Behavior** (best-effort, never blocks — same philosophy as `enrichRenovateTarget`):

1. If `state.renovateTarget` is null (extraction already blocked), return `{}` immediately — nothing to resolve.
2. Resolve Kibana config via the existing `resolveKibanaConfig(target.deployment)`. If null (no deployment config), return `{}` unchanged — falls through to today's behavior.
3. Call `GET /api/fleet/epm/packages?withPackagePoliciesCount=true` (the same call and shape `enrichRenovateTarget` already makes — no new endpoint, no new auth pattern). On any non-2xx or thrown error, log a warning and return `{}` unchanged.
4. Search `items` in this order, stopping at the first match:
   - **Already a slug**: some `item.name` case-insensitively equals `target.integration` → no-op, return `{}` (covers "udp", "prometheus", and every currently-working case; avoids a needless overwrite).
   - **Display-name exact match**: some `item.title` case-insensitively equals `target.integration` → resolve. Return `{ renovateTarget: { ...target, integration: item.name } }`.
5. If neither matches, return `{}` unchanged — `target.integration` flows into `resolveRenovateMarker` exactly as extracted today, preserving current behavior for phrasing this node can't resolve.

No substring/fuzzy matching against `title` — deliberately exact-only (case-insensitive). The dashboard-marker substring looseness already lives in `filterDashboardMatches`; duplicating fuzziness into this Kibana lookup risks resolving to the wrong package when multiple integration titles share a common word. This was an explicit design choice, confirmed with the user: the intended chain is **user text → Kibana title/name exact lookup → resolved slug → existing Renovate-marker substring match**, with exactly one fuzzy-matching stage (the existing one), not two.

### Why here, not elsewhere

- **Not in `filterDashboardMatches`**: that function's matching semantics are explicitly marked don't-touch.
- **Not a better LLM prompt alone**: guessy, can't cover Elastic's full integration catalog, and the catalog changes over time — Kibana's live package list is ground truth and self-updating.
- **Not merged into `enrichRenovateTarget`**: that node runs *after* `resolveRenovateMarker`, only reached once a dashboard match already succeeded — too late to help resolve the slug that dashboard matching itself depends on. This is a separate call site, not a refactor of the existing one; the two calls are not deduplicated/cached across nodes (acceptable — same as how `enrichRenovateTarget` and `fetchAffectedPolicyNames` already run as two independent Kibana calls per turn).

### Interface

```typescript
export async function resolveIntegrationSlug(state: IacStateType): Promise<Partial<IacStateType>>
```

- **Consumes**: `state.renovateTarget: { deployment: string; integration: string } | null` (set by `extractRenovateTarget`).
- **Produces**: `Partial<IacStateType>` — either `{}` (no change) or `{ renovateTarget: { deployment, integration: <resolved slug> } }`. No new state fields; reuses the existing `renovateTarget` annotation (`state.ts:790`, reducer `last`).

### Graph wiring (`graph.ts`)

- Add `.addNode("resolveIntegrationSlug", resolveIntegrationSlug)`.
- Change the existing `extractRenovateTarget` conditional edge (`graph.ts:333-336`, currently `s.blockedReason ? END : "resolveRenovateMarker"`) to route to `"resolveIntegrationSlug"` instead of `"resolveRenovateMarker"` on the non-blocked branch.
- Add `.addEdge("resolveIntegrationSlug", "resolveRenovateMarker")` — unconditional, since the node never blocks.

## What this does NOT do

- Does not change `filterDashboardMatches`'s matching semantics (still case-insensitive substring against the marker).
- Does not change `enrichRenovateTarget` — it keeps its own independent packages-list call unchanged (not deduplicated with this node's call).
- Does not add fuzzy/substring matching against Kibana `title` — exact match only, by design (see above).
- Does not change `extractRenovateTarget`'s LLM prompt — extraction stays as-is; resolution happens as a distinct, deterministic step afterward.
- Does not attempt to resolve `deployment` names (e.g. deployment aliases/nicknames) — this spec is scoped to the integration-name gap only, which is what was reported.

## Testing

- Unit tests for `resolveIntegrationSlug` (new, colocated in `renovate-integration.test.ts` alongside `enrichRenovateTarget`'s existing mocked-fetch tests, same `fetch` mocking pattern):
  - Already-a-slug input (`integration: "udp"`, packages list contains `{name: "udp", title: "Custom UDP Logs"}`) → returns `{}` unchanged.
  - Display-name input (`integration: "Custom UDP Logs"`, same packages list) → returns `{ renovateTarget: { ...target, integration: "udp" } }`.
  - Case-insensitive title match (`integration: "custom udp logs"`) → resolves the same way.
  - No match in packages list → returns `{}` unchanged.
  - `renovateTarget` is null → returns `{}` immediately, no fetch attempted.
  - `resolveKibanaConfig` returns null (no deployment env config) → returns `{}` unchanged, no fetch attempted.
  - Kibana call throws / returns non-2xx → returns `{}` unchanged (soft-fail, matches `enrichRenovateTarget`'s established pattern).
- Existing `resolveRenovateMarker` and `filterDashboardMatches` test suites are unaffected — no signature or behavior change there.
- Live verification once implemented: re-run the exact reported query ("In the ap-cld deployment, upgrade the 'Custom UDP Logs' integration") against the real ap-cld deployment and confirm it now resolves to the pending `udp` marker and reaches the approval gate.
