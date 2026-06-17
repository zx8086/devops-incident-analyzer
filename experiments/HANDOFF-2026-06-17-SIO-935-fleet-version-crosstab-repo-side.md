# HANDOFF -- SIO-935 Fleet upgrade version_crosstab: elastic-iac REPO-SIDE deliverable

- **Date:** 2026-06-17
- **Ticket:** [SIO-935](https://linear.app/siobytes/issue/SIO-935) (follow-up to [SIO-934](https://linear.app/siobytes/issue/SIO-934) PR #230; builds on the [SIO-913](https://linear.app/siobytes/issue/SIO-913) contract)
- **Target repo:** `observability-elastic-iac` -- gitlab.com `pvhcorp/dhco/observability/observability-elastic-iac` (id 82850717). Local checkout: `~/Documents/Claude/Projects/Elastic Infrastructure Management IaC/`
- **This doc covers ONLY the elastic-iac repo changes.** The agent-side (this monorepo) is delivered on commit `f02c7c1` (branch `claude/bold-williamson-8c4c6b`) and already parses the new field tolerantly.
- **Suggested branch (in elastic-iac):** `feature/sio-935-fleet-version-crosstab`

## TL;DR

The fleet-upgrade preview card shows an opaque skip breakdown ("196 other / 4 wolfi_container / 601 unknown") because `fleet-upgrade-report.json`'s `upgradeable_crosstab` is built PURELY from Fleet's `upgradeable:false` boolean (Wolfi/container detection via `os.name`) -- it never queries agent VERSION, and the default selector is `status:online` (no version filter). So "how many are already on 9.4.2" is computed NOWHERE: those agents fall into the `unknown`/`other` reason buckets, and even the "upgradeable" count can include agents already on target that `bulk_upgrade` no-ops.

Fix (one repo-side change): add a pre-flight VERSION partition to `scripts/fleet-bulk-upgrade.sh` and emit a new OPTIONAL `version_crosstab` block in `fleet-upgrade-report.json`. The agent already reads it tolerantly (absent -> undefined), so this is additive and back-compatible -- no schema version bump, no agent redeploy required after the MR lands.

Success = a preview pipeline emits `version_crosstab` and the agent card renders "N already on 9.4.2 (no action) / M will upgrade / K not Fleet-upgradeable".

## Context -- how this came to be

A user ran "Upgrade all the upgradable fleet elastic agent to 9.4.2 for the us-cld deployment". The preview returned `6 upgradeable / 801 not_upgradeable / 807 resolved` with the breakdown above. The operator could not tell how many of the 807 were already current vs genuinely outdated, and "unknown" (601) was meaningless (it is just `os.name` not matching the Wolfi heuristic). SIO-935 adds the version partition. The agent-side parser, Zod schema, reducer, gate, summary, and card were updated on `f02c7c1`; this handoff is the matching repo-side work.

## THE CONTRACT -- additive `version_crosstab` (fleet-upgrade-report/v1, UNCHANGED schema string)

Keep `schema: "fleet-upgrade-report/v1"`. Add ONE new OPTIONAL top-level object alongside `upgradeable_crosstab`. snake_case in the artifact; the agent maps to camelCase (same idiom as `upgradeable_crosstab`). Null/absent in apply mode or when not computed -- the agent treats absence as `undefined`, NEVER a false all-zero block.

```json
  "version_crosstab": {
    "already_on_target": 196,   // resolved agents whose version == target_version (bulk_upgrade no-ops them)
    "outdated": 611,            // resolved agents strictly below target_version (the genuine backlog)
    "version_unknown": 0,       // resolved agents whose version could not be read
    "upgradeable_outdated": 6,  // Fleet-upgradeable AND below target == what THIS flow actually moves
    "version_field": "local_metadata.elastic.agent.version"  // self-documenting: which field was queried
  }
```

Invariants (assert in the repo-side smoke test):
- `already_on_target + outdated + version_unknown == resolved_count`
- `upgradeable_outdated <= upgradeable_crosstab.upgradeable`

## Where the bodies are buried (current repo state, file:line)

### `scripts/fleet-bulk-upgrade.sh` -- the existing pre-flight is upgradeable:false ONLY
Per the SIO-913 handoff (`experiments/HANDOFF-2026-06-16-SIO-913-fleet-upgrade-repo-side.md`, line 124): "The `upgradeable_crosstab` needs a pre-flight `/api/fleet/agents?kuery=<sel> and upgradeable:false` count (and a `by_reason` from `os.name` Wolfi detection)." That pre-flight runs before the preview stop (script ~427-432). The new VERSION queries go in the same place. The script already has `$SELECTOR`, `$VERSION`, `$COUNT` (== resolved_count), and a Kibana/Fleet auth header in scope.

### `emit_report()` jq (SIO-913 handoff lines 104-122)
Builds the JSON from the variables the script computes. Add `--argjson vxtab` + `version_crosstab:$vxtab`.

## The fix (step-by-step)

### 1. `scripts/fleet-bulk-upgrade.sh` -- add the version pre-flight (before the preview stop)
Resolve the version field first. On current Fleet, `local_metadata.elastic.agent.version` is the queryable agent-version field; if a target deployment's Fleet exposes `agent.version` instead, fall back and set `version_field` accordingly. Then (URL-encode the kuery as the existing queries do):

```bash
VERSION_FIELD="local_metadata.elastic.agent.version"
fleet_total() {  # $1 = kuery; echoes .total
  curl -fsS -H "$KBN_AUTH" "$KIBANA_URL/api/fleet/agents?kuery=$(url_encode "$1")&perPage=0" | jq -r '.total // 0'
}
ALREADY_ON_TARGET=$(fleet_total "${SELECTOR} and ${VERSION_FIELD}:\"${VERSION}\"")
OUTDATED=$(fleet_total "${SELECTOR} and NOT ${VERSION_FIELD}:\"${VERSION}\"")
UPGRADEABLE_OUTDATED=$(fleet_total "${SELECTOR} and upgradeable:true and NOT ${VERSION_FIELD}:\"${VERSION}\"")
# version_unknown: resolved minus the two version-classified buckets (clamp >=0). An agent with no
# readable version is counted by NOT-target in OUTDATED, so compute explicitly to keep the partition honest:
VERSION_UNKNOWN=$(fleet_total "${SELECTOR} and NOT ${VERSION_FIELD}:*")
# Re-derive OUTDATED to EXCLUDE the unknowns so already+outdated+unknown == resolved:
OUTDATED=$(( OUTDATED - VERSION_UNKNOWN )); [ "$OUTDATED" -lt 0 ] && OUTDATED=0

VERSION_CROSSTAB_JSON=$(jq -n \
  --argjson aot "$ALREADY_ON_TARGET" --argjson out "$OUTDATED" \
  --argjson vunk "$VERSION_UNKNOWN" --argjson upo "$UPGRADEABLE_OUTDATED" \
  --arg vfield "$VERSION_FIELD" \
  '{ already_on_target:$aot, outdated:$out, version_unknown:$vunk, upgradeable_outdated:$upo, version_field:$vfield }')
```

Note on `version_unknown`: the first `OUTDATED` query (`NOT version:"X"`) also matches agents with no version at all, so subtract `VERSION_UNKNOWN` from it to keep the three buckets a true partition of `resolved_count`. Verify against a live deployment that the partition sums correctly (Fleet's `NOT field:*` semantics for missing fields).

### 2. `emit_report()` jq -- include the block (preview mode; null elsewhere)
```bash
  --argjson vxtab "${VERSION_CROSSTAB_JSON:-null}" \
  # ... in the object literal:
  '{ schema:"fleet-upgrade-report/v1", ..., upgradeable_crosstab:$xtab,
     version_crosstab:$vxtab, action_id:..., ... }'
```
Only compute `VERSION_CROSSTAB_JSON` in preview mode (or when `$MODE == preview`); leave it `null` for apply so the apply report is unchanged.

### 3. `.gitlab-ci.yml` -- no job change
The same `fleet-upgrade-preview-on-demand` job and `fleet-upgrade-report.json` artifact carry the new field. The change adds ~3 curl round-trips to the preview; the existing `DRIFT_POLL_*` 300s budget + per-server `defaultToolTimeout` (memory `reference_driftcheck_main_pipeline_permission`) already covers the cold-runner round trip.

## Verification (repo side)
1. Dry-run JSON mode against a sandbox (gl-testing, 3 GB):
   `bash scripts/fleet-bulk-upgrade.sh --deployment=gl-testing --version=9.4.2 --preview-only --report-file /tmp/r.json && jq . /tmp/r.json`
   Assert: `version_crosstab` present; `.version_crosstab | (.already_on_target + .outdated + .version_unknown) == (.. .resolved_count)` -- i.e. partition sums to `resolved_count`; `version_crosstab.upgradeable_outdated <= upgradeable_crosstab.upgradeable`; zero writes; exit 0.
2. Trigger the preview pipeline via the GitLab API with `FLEET_UPGRADE_PREVIEW=true, DEPLOYMENT=gl-testing, VERSION=9.4.2`; download `fleet-upgrade-report.json` and confirm the contract shape + invariants.
3. In the agent UI (once the MR lands), the fleet card shows "N already on 9.4.2 (no action) / M will upgrade / K not Fleet-upgradeable" and the by_reason catch-all reads "other OS / not detected". Approve is disabled iff `upgradeable_outdated == 0`. (Before the MR lands, the card gracefully shows today's 3 stats -- the agent parser tolerates the missing block.)
4. **Do NOT run a live apply** without explicit operator sign-off.

## Risks and edge cases
| Risk | Likelihood | Mitigation |
|---|---|---|
| `version_unknown` double-counts into `outdated` (Fleet `NOT field:*` semantics) | Med | Subtract VERSION_UNKNOWN from OUTDATED (step 1); the smoke test asserts the partition sums to resolved_count |
| Version field differs per Fleet (`local_metadata.elastic.agent.version` vs `agent.version`) | Low-Med | `version_field` echoes what was queried; fall back + document if a deployment 0s out unexpectedly |
| Extra curl round-trips exceed the runner/tool timeout | Low | Within the existing 300s drift budget; 3 lightweight `perPage=0` count queries |
| Old CI (no version_crosstab) after agent PR merges | Expected | Agent parser returns undefined -> card shows today's 3 stats; this is the intended back-compat window |

## Out of scope (this ticket)
- The tracing-pills fix (Part A of SIO-935) -- agent-side only, already on `f02c7c1`.
- Splitting `upgradeable_crosstab.upgradeable` itself into current/outdated -- the new `upgradeable_outdated` already gives the actionable number; leave the existing field as-is for back-compat.
- Container/Wolfi image-tag bumps ([SIO-919](https://linear.app/siobytes/issue/SIO-919)).

## Memory references
`reference_fleet_upgrade_pills_and_version_crosstab` (this work), `reference_driftcheck_main_pipeline_permission` (runner tags + cold-runner tool-timeout), `reference_synthetics_drift_subflow` (the trigger/poll/gate sub-flow pattern), `reference_elastic_iac_migrated_to_gitlab_com`. SIO-913 contract doc: `experiments/HANDOFF-2026-06-16-SIO-913-fleet-upgrade-repo-side.md`.
