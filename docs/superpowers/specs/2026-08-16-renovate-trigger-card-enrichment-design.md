# Renovate trigger card enrichment — design

## Context

The `renovate-integration-update` intent (SIO-1471, merged in [PR #663](https://github.com/zx8086/devops-incident-analyzer/pull/663)) shows a `renovate_trigger_choice` approval card before triggering an on-demand Renovate run. Today the card only carries the raw GitLab Dependency Dashboard checklist line (e.g. `chore(deps): [eu-onboarding] filestream to v2.5.0`) — the target version, but nothing about what version is currently installed, what changed, or what's affected by the upgrade.

The user asked whether the card can show more: specifically the currently-installed version, a changelog, and which Fleet agent policies use the integration (mirroring the Kibana Fleet UI's own upgrade dialog, which shows exactly this).

## What's available (verified live this session)

**Currently-installed version + affected agent policies** — both come from one Kibana Fleet endpoint, and the existing Elasticsearch credentials reach it directly:
- `GET /api/fleet/epm/packages/{pkgName}?withPackagePoliciesCount=true` (Kibana API). Live-verified against 9 of the repo's 10 configured deployments (`eu-onboarding`, `eu-cld`, `ap-cld`, `eu-b2b`, `gl-cld-reporting`, `eu-cld-monitor`, `ap-cld-monitor`, `us-cld-monitor`, `us-cld` — every deployment except `gl-testing`), spanning three different Elastic Cloud domain suffixes: `.cloud.es.io`, `.elastic-cloud.com`, `.found.io`.
- Exact response shape, confirmed live (not from truncated docs): top-level `version` is the package's *latest available* version; `installationInfo.version` is the *currently-installed* version (e.g. live-observed `eu-onboarding`: installed `2.8.0`, available `2.9.4`); `installationInfo.previous_version` is a bonus field (the version installed before the current one); `status` is `"installed"`/`"not_installed"`; and the policy count is `packagePoliciesInfo.count` (an object, not a bare field — resolves this spec's earlier "TBD").
- **The existing `ELASTIC_<DEPLOYMENT>_API_KEY` values (already configured for all 10 deployments, used today by `mcp-server-elastic` against Elasticsearch) authenticate successfully against Kibana too** — live-verified with `Authorization: ApiKey <same key>` + `kbn-xsrf: true` header, HTTP 200 on every deployment tested. **No new Kibana-specific credential is needed.** (This corrects the spec's original assumption, based on one failed test against the wrong key: `EC_API_KEY`, the Elastic-Cloud-*admin* key, does return 401 against Kibana — that finding was correct — but the *deployment-scoped* `ELASTIC_<DEPLOYMENT>_API_KEY` is a different, more privileged credential that does carry Kibana app-level auth.)
- **The Kibana URL is mechanically derivable from the existing `ELASTIC_<DEPLOYMENT>_URL`**: Elastic Cloud's Elasticsearch and Kibana endpoints for the same deployment differ only in one hostname label — `<deployment>.es.<region>.<cloud-domain>` (Elasticsearch) vs. `<deployment>.kb.<region>.<cloud-domain>` (Kibana). A single `.replace(".es.", ".kb.")` on the existing URL produces the correct, live-verified Kibana URL for every deployment tested — no new URL config needed either.

**Net result: zero new credentials or config.** Both the Kibana URL and the Kibana auth key are derived from the `ELASTIC_<DEPLOYMENT>_URL`/`_API_KEY` pairs this repo already has for all 10 deployments. This eliminates the "provisioning is an explicit prerequisite" blocker the original version of this spec assumed.

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
1. Parse `{deployment, integration}` from `state.renovateTarget` (already resolved).
2. Resolve the deployment's existing Elasticsearch config: `ELASTIC_<DEPLOYMENT>_URL` / `ELASTIC_<DEPLOYMENT>_API_KEY` from env, same `deployment.toUpperCase().replace(/-/g, "_")` convention `mcp-server-elastic`'s loader already uses (read inline in the node, per this file's established "read inside the node, not module scope" discipline, e.g. `renovateProjectId()`). Derive the Kibana URL with `url.replace(".es.", ".kb.")` on the hostname (live-verified against 9 deployments this session — see "What's available" above). If `ELASTIC_<DEPLOYMENT>_URL` is unset for this deployment (a deployment not in `ELASTIC_DEPLOYMENTS`), or the derived URL doesn't contain `.es.` to replace (an unexpected hostname shape), skip Kibana enrichment entirely (not an error) — best-effort, matches this repo's existing enrichment-node discipline.
3. Call `GET {kibanaUrl}/api/fleet/epm/packages/{integration}?withPackagePoliciesCount=true` with `Authorization: ApiKey {ELASTIC_<DEPLOYMENT>_API_KEY}` and `kbn-xsrf: true` (Kibana requires this header on API calls; omitting it was not an issue in this session's live tests but the header is Kibana's documented convention and should be sent regardless). Parse `item.version` (latest/target), `item.installationInfo?.version` (installed, `undefined` if never installed), and `item.packagePoliciesInfo?.count` (affected-policy count) — all three field names confirmed live this session against a real response, not guessed from docs.
4. Best-effort changelog lookup: `gh api repos/elastic/integrations/contents/packages/{integration}/changelog.yml` (reuse the existing `callTool`/external-process pattern this file already uses for other shell-outs — check `nodes.ts` for an existing `gh api` or GitHub-REST helper before adding a new one; if none exists, add a minimal one scoped to this one read-only call). Decode base64 content, parse YAML, filter to entries where `installedVersion < entry.version <= targetVersion` (semver compare; a small pure helper, `filterChangelogRange(entries, fromVersion, toVersion)`), newest-first (already the source order, confirmed live for both `system` and `filestream`). If `installedVersion` is unknown (Kibana lookup skipped/failed/package never installed), fall back to showing only the target version's own entry (can't compute a range without a starting point) — matches the "only the target version" option the user did NOT pick as primary, used here strictly as the degraded fallback, not the default.
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

### Config: none new

No new environment variables. The existing `ELASTIC_<DEPLOYMENT>_URL` / `ELASTIC_<DEPLOYMENT>_API_KEY` pairs (already set for all 10 deployments in `ELASTIC_DEPLOYMENTS`) are reused directly — the Kibana URL is derived (`.es.` → `.kb.`) and the same API key authenticates against both Elasticsearch and Kibana. Live-verified against 9 of the 10 configured deployments this session; the 10th (`gl-testing`) was not tested live but follows the identical URL/auth pattern already confirmed on every other deployment, so no reason to expect it to differ.

This removes the credential-provisioning blocker the original version of this spec assumed — enrichment can ship working for every currently-configured deployment on day one, with no operational prerequisite.

## What this does NOT do

- Does not add a Kibana Fleet MCP tool to any MCP server — the Kibana call lives inline in the new `enrichRenovateTarget` node (this file's own `callGitlabProxyTool`/direct-`fetch` precedent already establishes that not every external call needs a dedicated MCP tool; `gitlab_get_merge_commit_apply_result` and friends are the counter-example where a *multi-hop* call justified a tool — this is a single GET, matching `renovateProjectId()`'s "small mirror read, done inline" precedent instead).
- Does not change `triggerRenovateUpdate`/`watchRenovateMr` — enrichment is entirely pre-trigger, read-only, and has no bearing on the actual trigger mechanism.
- Does not attempt to reconcile "IaC-declared version" (in `integrations.json`, already readable via `gitlab_get_file_content`) against the live Kibana `installationInfo.version` — these could differ (the same repo-vs-live gap SIO-1196 already documents for stack versions) but reconciling them is out of scope; the card shows the live Kibana value only, since that's what the user asked to see ("current/installed").
- Does not paginate or filter Kibana's package list beyond the single `{integration}` package requested — no need to list all packages.

## Verification

- `bun test packages/agent/src/iac/renovate-integration.test.ts` — new pure-helper tests for `filterChangelogRange` and the enrichment node's best-effort degradation (deployment not in `ELASTIC_DEPLOYMENTS`, Kibana call errors, changelog 404s — each independently, and both together).
- `bun run typecheck && bun run lint` from repo root.
- Manual/live probe once implemented: trigger the eu-onboarding `elastic_agent` flow again and confirm the card shows real installed (`2.8.0`)/target (`2.9.4`)/policy-count (`0` for eu-onboarding, `64` for eu-cld — live-observed this session) /changelog data; separately test a deployment with a malformed or absent `ELASTIC_<DEPLOYMENT>_URL` and confirm the card falls back to today's plain version cleanly.

## Open items for implementation time (not blocking this spec)

- Whether an existing `gh api`/GitHub-REST helper already exists in `packages/agent` to reuse for the changelog fetch, or a minimal new one is needed — implementer should grep first.
- Whether to send `kbn-xsrf: true` on the Kibana call (Kibana's documented convention for API calls) even though this session's live tests succeeded without needing to set it explicitly beyond what curl sends by default — implementer should include it regardless, since Kibana's own docs require it for non-GET methods and some GETs; cheap to include, no reason to omit.
