# Renovate trigger card enrichment — design

## Context

The `renovate-integration-update` intent (SIO-1471, merged in [PR #663](https://github.com/zx8086/devops-incident-analyzer/pull/663)) shows a `renovate_trigger_choice` approval card before triggering an on-demand Renovate run. Today the card only carries the raw GitLab Dependency Dashboard checklist line (e.g. `chore(deps): [eu-onboarding] filestream to v2.5.0`) — the target version, but nothing about what version is currently installed, what changed, or what's affected by the upgrade.

The user asked whether the card can show more: specifically the currently-installed version, a changelog, and which Fleet agent policies use the integration (mirroring the Kibana Fleet UI's own upgrade dialog, which shows exactly this).

## What's available (verified live this session)

**Currently-installed version + affected agent policies** — both come from one Kibana Fleet endpoint:
- `GET /api/fleet/epm/packages?withPackagePoliciesCount=true` (Kibana API, documented at [elastic.co/docs/api/doc/kibana](https://www.elastic.co/docs/api/doc/kibana/operation/operation-get-fleet-epm-packages))
- Each item's `installationInfo.version` is the currently-installed version (distinct from the package's latest/available version).
- `withPackagePoliciesCount=true` returns the count of agent policies with that package attached, without a second call.
- Requires `integrations-read` (or `fleet-setup`/`fleet-all`) Kibana privilege via a Kibana-scoped API key.
- **No existing credential reaches this.** The repo's `ELASTIC_<DEPLOYMENT>_URL`/`_API_KEY` pairs (in `mcp-server-elastic`) point at Elasticsearch endpoints (`*.es.*` hostnames), not Kibana (`*.kb.*`). Live-verified: even the Elastic-Cloud-admin `EC_API_KEY` returns 401 when called directly against a deployment's Kibana URL — Cloud-admin keys don't carry Kibana app-level auth. A new, separate Kibana API key per deployment is required (created in Kibana's own Stack Management > API keys, or Cloud SSO — an operational step, not something this plan provisions).

**Changelog** — does NOT need Kibana or the Elastic Package Registry (EPR) at all:
- `elastic/integrations` on GitHub carries one `packages/<name>/changelog.yml` per integration package, newest-version-first, shape: `- version: "X.Y.Z" \n changes: [{description, type, link}]`.
- Live-verified for both `system` and `filestream` (real integrations) and `elastic_agent` (also a real, separate integration package — distinct from the Elastic Agent *binary*, which is what the Fleet-upgrade sub-flow already tracks).
- Fetchable via `gh api repos/elastic/integrations/contents/packages/<name>/changelog.yml` — the `gh` CLI is already authenticated in this environment; no new credential needed.
- EPR itself (`epr.elastic.co/package/<name>/<version>/`) has no `changelog` field — only `readme` (a doc path) and `release` (ga/beta/experimental). Confirmed live; not useful for this.

## Design

### New node: `enrichRenovateTarget`

Inserted between `resolveRenovateMarker` and `renovateTriggerGate`, gated the same way `renovateTriggerGate` already is — only reached when `hasSingleRenovateMatch` resolved exactly one marker (mirrors the existing `resolveRenovateMarker -> {renovateTriggerGate | teardown}` conditional edge; this node sits inside that same "single match" branch, before the gate node, not as a new fork).

```
resolveRenovateMarker --[hasSingleRenovateMatch]--> enrichRenovateTarget --> renovateTriggerGate
                       --[else]--> teardown
```

Rationale for a new node over folding into `resolveRenovateMarker` (per user decision): keeps dashboard discovery/matching (GitLab-only, already tested) separate from the new Kibana/GitHub calls, so each is independently testable and the enrichment can degrade to a no-op without touching the matching logic.

**Responsibilities:**
1. Parse `{deployment, integration}` from `state.renovateTarget` (already resolved) and the target version from `state.renovateMarker.marker`'s dashboard line (already resolved — reuse the existing "to vX.Y.Z" suffix, parsed with a new small pure helper, `parseRenovateTargetVersion(line: string): string | null`).
2. Best-effort Kibana lookup: resolve `KIBANA_<DEPLOYMENT>_URL` / `KIBANA_<DEPLOYMENT>_API_KEY` from env (same `deployment.toUpperCase().replace(/-/g, "_")` convention `mcp-server-elastic`'s loader already uses — read inline in the node, per this file's established "read inside the node, not module scope" discipline, e.g. `renovateProjectId()`). If either is unset, or the deployment doesn't have a mapping yet, skip Kibana enrichment entirely (not an error) — the config gap is expected during rollout (SIO note: keys are provisioned deployment-by-deployment).
3. If Kibana config resolves: call `GET {kibanaUrl}/api/fleet/epm/packages/{integration}?withPackagePoliciesCount=true` with `Authorization: ApiKey <key>` (matching the Fleet API's own documented auth header format, distinct from `mcp-server-elastic`'s Elasticsearch `ApiKey` usage but same scheme name). Parse `installationInfo.version` (installed version, `undefined` if never installed on this deployment) and `policy_count`/equivalent policy-count field (exact field name TBD against a live response during implementation — the Kibana docs page was truncated on this session's fetch; implementer must re-verify the exact response field name live before wiring the parser, not guess from the truncated docs excerpt above).
4. Best-effort changelog lookup: `gh api repos/elastic/integrations/contents/packages/{integration}/changelog.yml` (reuse the existing `callTool`/external-process pattern this file already uses for other shell-outs — check `nodes.ts` for an existing `gh api` or GitHub-REST helper before adding a new one; if none exists, add a minimal one scoped to this one read-only call). Decode base64 content, parse YAML, filter to entries where `installationInfo.version < entry.version <= targetVersion` (semver compare; a small pure helper, `filterChangelogRange(entries, fromVersion, toVersion)`), newest-first (already the source order). If `installationInfo.version` is unknown (Kibana lookup skipped/failed), fall back to showing only the target version's own entry (can't compute a range without a starting point) — matches the "only the target version" option the user did NOT pick as primary, used here strictly as the degraded fallback, not the default.
5. All of the above wrapped in a single try/catch per call (Kibana call, changelog call) — each fails independently and silently degrades; this node NEVER sets `blockedReason` and never prevents `renovateTriggerGate` from being reached. Log failures at `warn`, matching this file's existing best-effort-enrichment logging convention (e.g. `graphEnrichIac`).

**New state fields** (`packages/agent/src/iac/state.ts`, alongside the existing `renovate*` fields):
```ts
renovateInstalledVersion: Annotation<string | null>({ reducer: last, default: () => null }),
renovateTargetVersion: Annotation<string | null>({ reducer: last, default: () => null }),
renovatePolicyCount: Annotation<number | null>({ reducer: last, default: () => null }),
renovateChangelog: Annotation<Array<{ version: string; changes: Array<{ description: string; type: string; link?: string }> }>>({
  reducer: last,
  default: () => [],
}),
```
Add all four to `TURN_START_RESET` (the SIO-1471 lesson from PR #663 round 1 — a field left out of `TURN_START_RESET` leaks stale data across turns; this must not repeat that bug).

### Card changes: `RenovateTriggerChoiceCard.svelte`

Extend `RenovateTriggerChoice` (agent-reducer.ts) with the four new optional fields (mirroring how `marker`/`line` are already carried), threaded through `sse-pump.ts`'s `emitIacInterrupt` the same way the existing fields are.

Layout, informed by `FleetUpgradeChoiceCard`'s existing stat-tile pattern and the PR #665 trim (no raw marker/line duplication):

```
Trigger Renovate update
{prompt.message}                              [existing prose line — unchanged]

┌─────────────┬─────────────┬──────────────────┐
│ Installed    │ Target      │ Affected policies │   [only rendered if at least
│ 2.8.0        │ 2.9.4       │ 24                │    one value is non-null —
└─────────────┴─────────────┴──────────────────┘    best-effort, may be absent]

▾ Changelog (2.8.1 → 2.9.4, 6 releases)            [collapsed <details>, matches
  2.9.4 — Add system.cpu.cores to fields...          this repo's existing collapse
  2.9.3 — ...                                        pattern, e.g. the Kibana
  ...                                                 changelog dialog itself]

[Trigger update]  [Decline]
Runs via the schedule-triggered Renovate job (branches/MRs only); apply stays manual.
```

- Stat tiles render only when Kibana enrichment succeeded (best-effort — degrades cleanly to today's card if `renovateInstalledVersion`/`renovatePolicyCount` are both null).
- Changelog section renders only when `renovateChangelog.length > 0`; collapsed by default (`<details>`, native, no new JS) since a full version range can be long (per user's "all entries in range" decision) — matches this repo's Tailwind-only styling constraint (no custom `<style>` blocks).
- No new interaction (still just Trigger/Decline) — this is read-only context, not a new decision surface.

### Config (new, both required per-deployment for Kibana enrichment)

```
KIBANA_<DEPLOYMENT>_URL=https://<id>.kb.<region>.<cloud>.io
KIBANA_<DEPLOYMENT>_API_KEY=<kibana-scoped API key, integrations-read privilege>
```
Per user decision: hardcoded pair, mirroring `ELASTIC_<DEPLOYMENT>_URL`/`_API_KEY` exactly — not resolved dynamically via `EC_API_KEY`, despite that being technically possible (verified live this session), to keep the credential model consistent with the existing convention and avoid a second Cloud-API round-trip per trigger.

**Provisioning is an explicit prerequisite, not part of this plan's code**: no Kibana API key currently exists for any deployment. The plan implements enrichment as best-effort so it ships correctly with zero keys configured (today's card, unchanged) and each deployment gains the richer card only once its key is added — no code changes needed as keys roll out.

## What this does NOT do

- Does not add a Kibana Fleet MCP tool to any MCP server — the Kibana call lives inline in the new `enrichRenovateTarget` node (this file's own `callGitlabProxyTool`/direct-`fetch` precedent already establishes that not every external call needs a dedicated MCP tool; `gitlab_get_merge_commit_apply_result` and friends are the counter-example where a *multi-hop* call justified a tool — this is a single GET, matching `renovateProjectId()`'s "small mirror read, done inline" precedent instead).
- Does not change `triggerRenovateUpdate`/`watchRenovateMr` — enrichment is entirely pre-trigger, read-only, and has no bearing on the actual trigger mechanism.
- Does not attempt to reconcile "IaC-declared version" (in `integrations.json`, already readable via `gitlab_get_file_content`) against the live Kibana `installationInfo.version` — these could differ (the same repo-vs-live gap SIO-1196 already documents for stack versions) but reconciling them is out of scope; the card shows the live Kibana value only, since that's what the user asked to see ("current/installed").
- Does not paginate or filter Kibana's package list beyond the single `{integration}` package requested — no need to list all packages.

## Verification

- `bun test packages/agent/src/iac/renovate-integration.test.ts` — new pure-helper tests for `parseRenovateTargetVersion`, `filterChangelogRange`, and the enrichment node's best-effort degradation (Kibana unset, Kibana errors, changelog 404s — each independently, and both together).
- `bun run typecheck && bun run lint` from repo root.
- Manual/live probe once implemented: with `KIBANA_EU_ONBOARDING_URL`/`_API_KEY` set (once provisioned), trigger the eu-onboarding elastic_agent flow again and confirm the card shows real installed/target/policy-count/changelog data; then unset the key and confirm the card falls back to today's plain version cleanly.

## Open items for implementation time (not blocking this spec)

- Exact Kibana response field name for policy count (docs page truncated this session — verify live against a real `GET .../epm/packages/{pkg}?withPackagePoliciesCount=true` call before writing the parser).
- Whether an existing `gh api`/GitHub-REST helper already exists in `packages/agent` to reuse for the changelog fetch, or a minimal new one is needed — implementer should grep first.
