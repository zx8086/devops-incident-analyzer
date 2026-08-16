# Renovate trigger card: affected-policy names + changelog cap — design

## Context

The `renovate_trigger_choice` approval card (enriched with KG/memory recall in PR #667) shows an "affected policies" stat tile with a bare count (e.g. "14") and an unbounded changelog `<details>` block that can list dozens of releases. The user asked, while reviewing the live card:

> "Like the Changelog, in a collapsed way, can we list the affected policies, so someone can click the arrow to see the affected policies. Also can we limit the changelog entries? maybe by count or version (major / minor)."

Two independent, small UI/data changes on the same card:

1. **Affected policies**: show the actual policy *names*, not just a count, in a collapsed section matching the Changelog section's own pattern.
2. **Changelog cap**: cap the number of changelog entries shown, by count (confirmed: N=10).

## What already exists (reusable as-is)

- **The `<details>` collapsed-section pattern** is already established twice on this exact card (`RenovateTriggerChoiceCard.svelte`: the KG "Recent changes" panel, the memory "Prior triggers" panel, and the existing Changelog section) — new sections follow the identical Tailwind classes/structure.
- **The 6-layer threading pattern** (state → interrupt payload → `StreamEventSchema` → `sse-pump.ts` → reducer → card) is proven three times over (enrichment fields in PR #666, KG/memory recall in PR #667) — this spec is a fourth application of the same pattern, not a new architecture.
- **`enrichRenovateTarget`'s existing Kibana call** (`nodes.ts:492`, `GET /api/fleet/epm/packages?withPackagePoliciesCount=true`) already resolves `kibanaConfig` and produces `policyCount` — the new policy-names call reuses the same `kibanaConfig`, runs as a sibling fetch, and does NOT replace the existing count call (the count already renders correctly in the stat tile and must survive even if the new names-fetch fails independently).
- **`filterChangelogRange`** (`nodes.ts:651-662`, pure, unit-tested) stays completely unchanged — the cap is a separate post-step, not a modification to its range-filtering contract.

## Design

### 1. Affected-policy names

**Verified against Elastic's official Kibana Fleet API OpenAPI spec** (`https://www.elastic.co/docs/api/doc/kibana/v9/operation/operation-get-fleet-package-policies`): no simpler alternative exists — `/api/fleet/epm/packages/{pkgName}` and its `/stats` sibling return metadata/counts only, never policy names. A second Fleet API call is unavoidable.

```
GET {kibanaConfig.url}/api/fleet/package_policies?kuery=ingest-package-policies.package.name:"${target.integration}"
Headers: Authorization: ApiKey ${kibanaConfig.apiKey}
```
(No `kbn-xsrf` needed — confirmed via the OpenAPI spec that header is declared only on the sibling `POST` operation, not `GET`.)

Response shape (confirmed via spec): `{items: [{name: string, package: {name, version}, ...}], total, page, perPage}`. Map `items[].name` to a `string[]`.

New function in `nodes.ts`, colocated with `enrichRenovateTarget` (after `fetchRenovateChangelog`, before `enrichRenovateTarget` itself — matching the existing convention of small I/O helpers living just above their caller):

```ts
// Kibana Fleet package-policies list, filtered by integration package name via kuery. No simpler
// alternative exists -- /api/fleet/epm/packages/{pkgName} and its /stats sibling return package
// metadata/counts only, never individual policy names (verified against the Fleet OpenAPI spec).
// Soft-fails to [] on any error/non-2xx -- the existing policyCount stat tile (from the sibling
// packages-list call) must still render even if this second call fails independently.
async function fetchAffectedPolicyNames(
	kibanaConfig: { url: string; apiKey: string },
	integration: string,
): Promise<string[]> {
	try {
		const kuery = `ingest-package-policies.package.name:"${integration}"`;
		const res = await fetch(`${kibanaConfig.url}/api/fleet/package_policies?kuery=${encodeURIComponent(kuery)}`, {
			headers: { Authorization: `ApiKey ${kibanaConfig.apiKey}` },
			signal: AbortSignal.timeout(8_000),
		});
		if (!res.ok) return [];
		const body = (await res.json()) as { items?: unknown };
		const items = Array.isArray(body.items) ? body.items : [];
		return items
			.filter((item): item is { name: string } => typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string")
			.map((item) => item.name);
	} catch {
		return [];
	}
}
```

**Wiring — exact decision, not a choice for the implementer:** called inside `enrichRenovateTarget`'s existing `if (kibanaConfig) { ... }` block (`nodes.ts:487-535`), as a plain sequential `await` immediately AFTER that block's existing `try/catch` closes (i.e. as its own statement, not nested inside the existing `try`, and not folded into the later `Promise.all` at `nodes.ts:537-548`). Rationale: the later `Promise.all` covers calls that don't depend on Kibana (changelog fetch, KG recall, memory recall) and already runs concurrently with the whole `if (kibanaConfig)` block via the outer function's control flow; nesting a Kibana-dependent call inside that `Promise.all` would need `kibanaConfig` threaded an extra hop into the IIFE for zero concurrency benefit, since it can only run after `kibanaConfig` is resolved anyway. A second sequential Kibana call (after the first `fetch`, not concurrent with it) is the simplest correct placement and matches this function's existing style of one Kibana operation following another inside the same guard.

```ts
// Declared at the top of enrichRenovateTarget, alongside the existing
// `let policyCount: number | null = null;`:
let affectedPolicies: string[] = [];

const kibanaConfig = resolveKibanaConfig(target.deployment);
if (kibanaConfig) {
	try {
		// ...existing fetch + parsing for policyCount/installedVersion, completely unchanged...
	} catch (error) {
		// ...existing catch block, completely unchanged...
	}
	// NEW: one more statement, still inside this same `if (kibanaConfig)` block (so no second
	// null-check is needed — kibanaConfig is already non-null here), AFTER the try/catch closes:
	affectedPolicies = await fetchAffectedPolicyNames(kibanaConfig, target.integration);
}
```

New state field: `renovateAffectedPolicies: string[]` (default `[]`, NOT `null` — an empty array already means "none found/fetch failed", matching `renovateChangelog`'s own `[]` default rather than the `null`-ish pattern used for scalar Kibana fields).

### 2. Changelog cap (N=10)

Added as a thin post-step in `enrichRenovateTarget`'s existing `Promise.all` IIFE (`nodes.ts:538-545`) — `filterChangelogRange` itself is untouched:

```ts
const CHANGELOG_DISPLAY_CAP = 10;

// inside the async IIFE, after filterChangelogRange:
(async () => {
	if (!resolvedTargetVersion) return [];
	const filtered = filterChangelogRange(await fetchRenovateChangelog(target.integration), installedVersion, resolvedTargetVersion);
	return filtered.slice(0, CHANGELOG_DISPLAY_CAP);
})(),
```

The card needs to know the PRE-cap total to render an honest "+N more releases" note — so `enrichRenovateTarget` returns a new field `renovateChangelogTotal: number` (the pre-cap `filtered.length`) alongside the (now capped) `renovateChangelog`. Both computed in the same IIFE by returning a tuple/object internally, or by capturing `filtered.length` in a variable declared outside the IIFE before the `Promise.all` (simpler — avoids restructuring the `Promise.all`'s return shape). Chosen approach: capture via a mutable outer-scope variable, matching this function's existing pattern of `let policyCount`/`let installedVersion` mutated inside blocks before the final `return`:

```ts
let changelogTotal = 0;
// ...
const [changelog, renovateRecentChanges, renovatePriorTriggers] = await Promise.all([
	(async () => {
		if (!resolvedTargetVersion) return [];
		const filtered = filterChangelogRange(await fetchRenovateChangelog(target.integration), installedVersion, resolvedTargetVersion);
		changelogTotal = filtered.length;
		return filtered.slice(0, CHANGELOG_DISPLAY_CAP);
	})(),
	recallDeploymentKgChanges(target.deployment),
	recallPriorRenovateTriggers(target.deployment, marker.marker),
]);
```

New state field: `renovateChangelogTotal: number` (default `0`).

### `enrichRenovateTarget`'s full new return shape

Combining both changes, the function's final `return` (currently `nodes.ts:550-557`) gains 2 new keys, unchanged otherwise:

```ts
return {
	renovateInstalledVersion: installedVersion,
	renovateTargetVersion: resolvedTargetVersion,
	renovatePolicyCount: policyCount,
	renovateChangelog: changelog,
	renovateRecentChanges,
	renovatePriorTriggers,
	renovateAffectedPolicies: affectedPolicies,
	renovateChangelogTotal: changelogTotal,
};
```

### State fields (2 new, alongside the existing `renovate*` fields in `state.ts`)

```ts
renovateAffectedPolicies: Annotation<string[]>({ reducer: last, default: () => [] }),
renovateChangelogTotal: Annotation<number>({ reducer: last, default: () => 0 }),
```
Both added to `TURN_START_RESET` (`nodes.ts:1566-1568`) in the same commit — this is the FOURTH time this exact lesson applies to this sub-flow; do not omit it.

### Interrupt payload (`renovateTriggerGate`, `nodes.ts:666-682`)

```ts
affectedPolicies: state.renovateAffectedPolicies,
changelogTotal: state.renovateChangelogTotal,
```

### SSE schema (`packages/shared/src/agent-state.ts:1250-1268`)

```ts
affectedPolicies: z.array(z.string()).optional(),
changelogTotal: z.number().optional(),
```

### `sse-pump.ts`

**Type literal** (`sse-pump.ts:746-754`): add `affectedPolicies?: unknown;` and `changelogTotal?: unknown;` — both genuinely new, no reuse conflict with any existing field name.

**Emit branch** (`sse-pump.ts:900-915`): add, following the existing `changelog`'s non-empty-array guard pattern:
```ts
...(Array.isArray(obj.affectedPolicies) && obj.affectedPolicies.length > 0 && { affectedPolicies: obj.affectedPolicies }),
...(typeof obj.changelogTotal === "number" && obj.changelogTotal > 0 && { changelogTotal: obj.changelogTotal }),
```

### Reducer (`RenovateTriggerChoice` interface, `agent-reducer.ts:307-325` + reducer case)

```ts
affectedPolicies?: string[];
changelogTotal?: number;
```
Reducer case: `affectedPolicies: event.affectedPolicies, changelogTotal: event.changelogTotal`.

### Card (`RenovateTriggerChoiceCard.svelte`)

**Affected policies** — new collapsed `<details>` section, placed after the Changelog `<details>` block (`svelte:82-101`) since it's a secondary drill-down like the changelog, not primary context like the KG/memory panels:

```svelte
{#if prompt.affectedPolicies && prompt.affectedPolicies.length > 0}
  <details class="mt-2">
    <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">
      Affected policies ({prompt.policyCount ?? prompt.affectedPolicies.length})
    </summary>
    <ul class="mt-1 ml-3 list-disc space-y-0.5 text-xs text-tommy-navy/70">
      {#each prompt.affectedPolicies as name (name)}
        <li>{name}</li>
      {/each}
    </ul>
  </details>
{/if}
```
Summary count uses `prompt.policyCount` (the original, always-reliable count from the existing call) with a fallback to the names array's own length — so the count stays accurate even in the edge case where the names-fetch returns a different count than the count-fetch (e.g. a policy created between the two calls).

**Changelog cap display** — extend the existing summary text (`svelte:84-86`) to show the pre-cap total and a truncation note:

```svelte
{#if changelogCount > 0}
  <details class="mt-2">
    <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">
      Changelog ({prompt.installedVersion ?? "?"} &rarr; {prompt.targetVersion ?? "?"}, {changelogCount} of {prompt.changelogTotal ?? changelogCount} release{(prompt.changelogTotal ?? changelogCount) === 1 ? "" : "s"})
    </summary>
    <ul class="mt-1 space-y-1.5 text-xs">
      {#each prompt.changelog ?? [] as entry (entry.version)}
        ...unchanged...
      {/each}
      {#if prompt.changelogTotal && prompt.changelogTotal > changelogCount}
        <li class="text-tommy-navy/50 italic">+{prompt.changelogTotal - changelogCount} more release{prompt.changelogTotal - changelogCount === 1 ? "" : "s"} (see the full changelog on GitHub)</li>
      {/if}
    </ul>
  </details>
{/if}
```
When `changelogTotal` is absent or equal to `changelogCount` (no truncation happened — either the SSE field never arrived, an older payload, or genuinely ≤10 releases), the summary reads identically to today ("10 of 10 releases") and the "+N more" line never renders — degrades cleanly.

## What this does NOT do

- Does not change the existing `policyCount` stat tile or its underlying `packagePoliciesInfo.count` fetch — that call and field are untouched, still the primary count source.
- Does not change `filterChangelogRange`'s signature, behavior, or existing tests — the cap is purely additive, applied to its output.
- Does not add pagination/expand-for-more UI for either list — a flat cap (10 releases) and a flat list (all matched policy names, uncapped — `policyCount` is rarely large enough to need its own cap, and Fleet's own `perPage` default of 20 combined with the `kuery` filter keeps this bounded in practice).
- Does not touch the KG/memory recall panels (`recentChanges`/`priorTriggers`) from PR #667 — unrelated, unaffected.

## Verification

- `bun test packages/agent/src/iac/renovate-integration.test.ts` — new tests for `fetchAffectedPolicyNames` (mocked `fetch`, mirroring the existing Kibana-call test style already in this file) and for the changelog cap (assert `renovateChangelog.length <= 10` and `renovateChangelogTotal` reflects the pre-cap count when >10 entries exist).
- `bun run typecheck && bun run lint` from repo root.
- Manual/live probe: trigger a renovate update for an integration known to have >10 changelog releases (the live screenshot that prompted this spec showed a `system` integration update with a long, unbounded changelog list — a good candidate to re-test against) and confirm the card shows exactly 10 entries plus an accurate "+N more releases" note; expand the new "Affected policies" section and confirm it lists real policy names, not just a count.
