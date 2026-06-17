# HANDOFF -- SIO-935 fleet version_crosstab: elastic-iac MR status (push done, MR not opened)

- **Date:** 2026-06-17
- **Ticket:** [SIO-935](https://linear.app/siobytes/issue/SIO-935) (umbrella, In Review). Agent half merged: [devops-incident-analyzer#231](https://github.com/zx8086/devops-incident-analyzer/pull/231) -> `main`.
- **Target repo:** `observability-elastic-iac` -- gitlab.com `pvhcorp/dhco/observability/observability-elastic-iac` (id 82850717).
- **Local checkout (user's, DIRTY -- do not touch):** `~/Documents/Claude/Projects/Elastic Infrastructure Management IaC/` on branch `docs/module-howto-accuracy-sync` with ~10 unrelated modified files (incl. 253 lines of uncommitted SIO-913 WIP on `fleet-bulk-upgrade.sh` -- this is NOT my work and must be left alone).
- **Isolated worktree I used (off origin/main, clean):** `/tmp/elastic-iac-sio935`. Safe to delete after the MR is open (`git -C "~/Documents/.../Elastic Infrastructure Management IaC" worktree remove /tmp/elastic-iac-sio935`).

## TL;DR -- what's done / what's next

**Done:** the repo-side change is written, verified, committed, and **pushed**. Branch `feature/sio-935-fleet-version-crosstab` (commit `548a9df`, off `origin/main` `0bb4d45`) exists on GitLab. One file changed: `scripts/fleet-bulk-upgrade.sh`, +62 lines, additive only.

**Next (3 steps):**
1. **Open the MR** -- `glab mr create` failed with a 404 (token can't see the project over HTTPS API; SSH push worked fine -- classic OAuth-vs-PAT split, see `reference_gitlab_oauth_vs_pat_split`). Open it manually at the URL the push printed:
   `https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fsio-935-fleet-version-crosstab`
   (target `main`, ready for review). MR title/body text is in the "MR description" section below -- paste it.
2. **Dry-run before merge** (NOT yet run against a live deployment -- see Verification).
3. **Merge**, then SIO-935 can move to Done (with your approval) once the live card shows the version numbers.

## What the change does

The fleet-upgrade preview card showed `196 other / 4 wolfi / 601 unknown` and could not answer "how many agents are already on 9.4.2", because `upgradeable_crosstab` is built purely from Fleet's `upgradeable:false` boolean (Wolfi/container via `os.name`) and never queries version. This adds a VERSION partition.

New `compute_version_crosstab()` in `scripts/fleet-bulk-upgrade.sh` -- mirrors the existing `compute_crosstab()` idiom (`${CURL[@]}`, `$BASE`, URL-encoded selector, best-effort null on failure). Three cheap `perPage=0` count queries on the KQL-searchable `local_metadata.elastic.agent.version` field. Emits a new OPTIONAL `version_crosstab` block in `fleet-upgrade-report/v1` (schema string UNCHANGED):

```json
"version_crosstab": {
  "already_on_target": 196,
  "outdated": 601,
  "version_unknown": 10,
  "upgradeable_outdated": 6,
  "version_field": "local_metadata.elastic.agent.version"
}
```

Design decisions (already in the committed code + comments):
- `already_on_target` and `version_unknown` measured directly; **`outdated` DERIVED** as `resolved - already - unknown` so the three always sum to `resolved_count` (avoids the `NOT version:*` double-count for agents with no readable version).
- `upgradeable_outdated` combines the version kuery with the `showUpgradeable=true` PARAM (`upgradeable:true` is not KQL-searchable -- same constraint `compute_crosstab` already documents).
- Computed ONLY in preview/selector mode; `null` in apply mode and on `--agent-ids`. Additive + optional, so it merges independently of the agent.

## Where the bodies are (worktree `/tmp/elastic-iac-sio935`, all in `scripts/fleet-bulk-upgrade.sh`)

4 edits, all additive (line numbers approximate, off origin/main's 865-line script):
- `~line 73`: `VERSION_CROSSTAB_JSON="null"` global, next to `CROSSTAB_JSON`.
- `~line 322 + 340` (`emit_report`): `--argjson vxtab "${VERSION_CROSSTAB_JSON:-null}"` + `version_crosstab: $vxtab,` after `upgradeable_crosstab: $xtab,`.
- `~line 404` (after `compute_crosstab()` closes): the new `compute_version_crosstab()` function + a `VERSION_FIELD="local_metadata.elastic.agent.version"` const above it.
- `~line 757` (after the `compute_crosstab` call): `compute_version_crosstab` call + an echo of the version crosstab in the preview-only summary.

`git -C /tmp/elastic-iac-sio935 show 548a9df` is the full diff.

## MR description (paste this into the manual MR)

> **Title:** SIO-935: emit version_crosstab in fleet-upgrade preview report
>
> **What:** Adds a VERSION partition to the fleet-upgrade preview report so the DevOps agent can show "N already on 9.4.2 (no action)" instead of lumping already-current agents into the opaque by_reason buckets. Pairs with the merged agent half (devops-incident-analyzer #231). Linear SIO-935.
>
> **Why:** The card showed "196 other / 4 wolfi / 601 unknown" and operators couldn't tell how many were already on target. `upgradeable_crosstab` is built purely from Fleet's `upgradeable:false` boolean and never queries version.
>
> **How:** New `compute_version_crosstab()` (mirrors `compute_crosstab()`) runs three cheap perPage=0 count queries on the KQL-searchable `local_metadata.elastic.agent.version` field. `outdated` is derived as `resolved - already - unknown` so the partition sums to `resolved_count`; `upgradeable_outdated` combines the version kuery with the `showUpgradeable=true` param. Additive + optional (preview/selector mode only; null otherwise); no schema bump.
>
> **Back-compat:** The agent parser (#231, on main) reads it tolerantly (absent -> undefined, card falls back to today's stats), so this merges independently and the card lights up the moment it lands. No agent redeploy.
>
> **Verification:** `bash -n` clean; jq shape + partition invariant verified with mock data; END-TO-END round-trip proven (the emitted JSON parses through the merged agent `parseFleetUpgradeReport` to the correct camelCase `versionCrosstab`, partition sums to resolvedCount). NOT yet run against a live deployment -- dry-run recommended before merge (command below).

## Verification

Done (all green):
- `bash -n scripts/fleet-bulk-upgrade.sh` -- syntax OK.
- jq shape + invariant with mock data: `already_on_target + outdated + version_unknown == resolved_count` holds (196+601+10 == 807).
- **End-to-end round-trip**: fed the exact emitted JSON through the MERGED agent `parseFleetUpgradeReport` (monorepo) -> correct camelCase `versionCrosstab` `{ alreadyOnTarget:196, outdated:601, versionUnknown:10, upgradeableOutdated:6 }`, partition sums to `resolvedCount`. This proves the two halves fit -- the card WILL light up once merged.

NOT done -- run before merge:
- **Live dry-run** against a sandbox (gl-testing, 3 GB):
  ```bash
  bash scripts/fleet-bulk-upgrade.sh --deployment=gl-testing --version=9.4.2 --preview-only --report-file /tmp/r.json
  jq '.version_crosstab' /tmp/r.json
  # assert: (.already_on_target + .outdated + .version_unknown) == .resolved_count
  jq '(.version_crosstab.already_on_target + .version_crosstab.outdated + .version_crosstab.version_unknown) == .resolved_count' /tmp/r.json   # -> true
  jq '.version_crosstab.upgradeable_outdated <= .upgradeable_crosstab.upgradeable' /tmp/r.json   # -> true
  ```
  Watch for: (a) `local_metadata.elastic.agent.version` being the right field on that deployment's Fleet (the script's own --selector examples use it, so it should be); (b) the `NOT version:*` semantics for missing-version agents -- if `version_unknown` looks wrong, the derived-outdated approach still keeps the sum correct, but sanity-check the bucket values.

## Risks and edge cases
| Risk | Likelihood | Mitigation |
|---|---|---|
| `local_metadata.elastic.agent.version` not queryable on some Fleet | Low | The script already uses it in --selector examples; `version_field` echoes what was queried; best-effort null on query failure |
| `NOT version:*` semantics differ for missing-version agents | Med | `outdated` is DERIVED from the remainder, so the partition sums correctly regardless; only the unknown-vs-outdated split could shift |
| Extra 3 curl round-trips exceed runner/tool timeout | Low | All `perPage=0` count-only; within the existing drift budget |
| glab can't open the MR (token 404) | Hit | Open manually via the push URL above; SSH push already succeeded |

## Out of scope
- The 253 lines of uncommitted SIO-913 WIP in the user's dirty checkout of `fleet-bulk-upgrade.sh` -- NOT mine, left untouched. My change was made off a CLEAN `origin/main` worktree, so it does not include that WIP.
- The agent-side display (already merged on #231).
- `.gitlab-ci.yml` -- no change needed; the existing `fleet-upgrade-preview-on-demand` job + `fleet-upgrade-report.json` artifact carry the new field automatically.

## Memory references
`reference_fleet_upgrade_pills_and_version_crosstab` (the full SIO-935 design), `reference_gitlab_oauth_vs_pat_split` (why glab 404'd but ssh push worked), `reference_git_stash_desyncs_read_cache` (worktree-hygiene lesson from the agent-side work), `reference_elastic_iac_migrated_to_gitlab_com`. Original contract spec: `experiments/HANDOFF-2026-06-17-SIO-935-fleet-version-crosstab-repo-side.md`.
