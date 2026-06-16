# Fleet-apply: sign off a long-running upgrade instead of calling it "failed" — design

- **Date:** 2026-06-16
- **Status:** Approved (brainstorming complete; ready for implementation plan)
- **Repo:** `zx8086/devops-incident-analyzer`
- **Related:** SIO-913 (fleet-upgrade sub-flow), SIO-924 (live apply progress), SIO-881 (post-merge apply tracking — same "agent stops watching" gap)

## TL;DR

A real fleet apply against `ap-cld` (247 agents, **3600s rollout window**) reported
**"Fleet upgrade failed: Apply did not finish within the poll budget"** — but the pipeline had
**not failed**. It was still `running` when the agent's poll budget expired (~5 min) and the code
mapped "anything not `success`" to `status: "failed"`. The apply almost certainly succeeded in the
background. Two structural defects: (1) the poll budget (300s MCP / 90s agent ticker) is ~12× shorter
than the rollout it waits on, and (2) "running-at-budget" is rendered as a hard failure. The fix:
**size the wait from the known `rolloutSeconds`, tell the user the expected duration and that the
upgrade started successfully, return one status snapshot, and make the apply pipeline resumable** so a
follow-up turn ("how's it going?") re-polls the same pipeline instead of re-triggering or guessing.

## Evidence (from the live run)

Agent log:
```
3:56:42 iac fleet upgrade: apply triggered; polling  pipelineId=2605468937
3:56:52 iac fleet apply: pipeline status            status=running
4:00:04 iac fleet upgrade: apply result             status=failed       responseTime=204709 (~3.4 min)
```
MCP log (same pipeline):
```
gitlab_get_fleet_upgrade_apply_result: polling          budgetMs=300000
gitlab_get_fleet_upgrade_apply_result: still running at budget   status=running  polls=56
```
Preview that immediately preceded it: `resolved=249, upgradeable=247, versionAvailable=true`,
**rolloutSeconds=3600**. The apply card itself shows "Rollout window: 3600s".

So: a 3600s rollout was waited on for 300s, came back `running`, and was reported `failed`.

## Where the bodies are buried

**1. Budget is the wrong constant and far too short.**
- `packages/mcp-server-elastic-iac/src/tools/gitlab.ts:901` — `gitlab_get_fleet_upgrade_*_result`
  block-polls for `DRIFT_POLL_BUDGET_MS` (the **drift-check** budget, default 300000ms). There is no
  fleet-specific budget, and 300s < 3600s rollout by construction.
- `packages/agent/src/iac/nodes.ts:5969` — the agent-side progress ticker uses
  `IAC_PIPELINE_POLL_BUDGET_MS` (default **90000ms**) before it even calls the blocking result fetch.
- The duration is **already known**: the same `report` object exposes `report.rolloutSeconds`
  (read at `nodes.ts:5919` for the gate message). It is simply not used to size the wait.

**2. "running-at-budget" collapses into `failed`.**
- `packages/agent/src/iac/nodes.ts:5994-6025` — `res.status === "success" ? {applied} : {failed}`.
  Anything not literally `"success"` (including `"running"`) takes the `failed` branch. The `note`
  ternary (6021-6024) already *distinguishes* "actually failed/canceled" from "did not finish within
  the poll budget" — but both share `status: "failed"`, which reddens the card and logs `failed`.
- The MCP side is already honest: `gitlab.ts:916-918` returns
  `{status: "running", note: "still running at budget; re-check"}` on budget expiry. The agent throws
  that signal away.

**3. The apply pipeline id is not persisted for a follow-up turn.**
- `applyFleetUpgrade` returns `fleetUpgradeResult` with `pipelineId`, but there is no node/route to
  **re-poll an in-flight apply** on a later turn. A "how's the upgrade going?" follow-up has nowhere
  to go (same shape as the SIO-881 gap). `FleetUpgradeResult` (`state.ts:321`) has no `dispatched`
  status and the apply pipeline id is not surfaced as resumable state.

## Design

### 1. A third outcome: `dispatched` (started, still in flight) — not `failed`

Add `dispatched` to `FleetUpgradeResult.status` (`state.ts:321`:
`"applied" | "dispatched" | "skipped" | "blocked" | "failed"`). In `applyFleetUpgrade`
(`nodes.ts:5994+`), branch three ways on the result fetch:
- `res.status === "success"` -> `applied` (unchanged; carries the verify-sweep `failed_silent`).
- `res.status === "failed" | "canceled"` -> `failed` (a real failure; keep `classifyPipelineFailure`).
- **otherwise (`running`/non-terminal at budget) -> `dispatched`** with a note like
  "Upgrade started and running; expected ~{duration}. Not finished within the status window — track
  the pipeline, or ask me to check on it." The card renders neutral/in-progress, never red.

### 2. Size the wait from `rolloutSeconds` and set expectations up front

- The MCP block-poll budget for the fleet apply becomes its own value derived from the rollout, not
  `DRIFT_POLL_BUDGET_MS`. Introduce `CI_CONTRACT`-adjacent budget config (env-overridable) used only
  by the fleet apply result fetch. Because a full 3600s block-poll is undesirable UX, the **intent is
  not to block for the whole rollout** — it is to (a) confirm the pipeline is created/running, (b)
  wait a short, bounded "did it start cleanly" window, then (c) return `dispatched` with the expected
  duration computed from `rolloutSeconds`.
- Up-front message (before/at trigger) states the expected duration: e.g. "Starting the bulk_upgrade
  for 247 agents — this rolls out over ~60 min (3600s). Pipeline #… created." This uses
  `report.rolloutSeconds` + `report.crosstab.upgradeable`, both already in state.

### 3. One status snapshot before closing out, plus a resumable follow-up

- **Snapshot:** before returning `dispatched`, emit one `iac_pipeline_progress` with the current
  status + pipeline URL (the SIO-924 ticker already does transitions; ensure a final snapshot lands).
- **Resumable:** persist the in-flight apply pipeline id in `IacState` (e.g.
  `fleetApplyPipelineId` / reuse `fleetUpgradeResult.pipelineId`) and add a lightweight intent +
  node so "how is the ap-cld upgrade going?" / "check the fleet upgrade" re-polls **that** pipeline
  via `gitlab_get_pipeline` + `gitlab_get_fleet_upgrade_apply_result` and reports current
  status/outcome — without re-triggering. (Coordinate with SIO-881; this is the fleet-apply slice of
  the same "track an already-dispatched pipeline" capability.)

### Message copy (replaces the red failure)

- Dispatched: **"Fleet upgrade started for ap-cld — 247 agents upgrading to 9.4.2 over ~60 min. 2
  non-upgradeable (Wolfi/container) skipped for an upstream image-tag bump. Pipeline #2605468937 is
  running [link]. I'll not block on the full rollout; ask me to check on it or watch the pipeline."**
- Only emit the true-failure copy when `res.status` is actually `failed`/`canceled`.

## Verification

```
bun run typecheck && bun run lint && bun run test
bun run --filter '@devops-agent/agent' test          # fleet-upgrade.test.ts
bun run --filter '@devops-agent/mcp-server-elastic-iac' test
```
Unit tests to add:
- `applyFleetUpgrade` maps `res.status==="running"` -> `dispatched` (not `failed`); `failed`/`canceled`
  still -> `failed`; `success` -> `applied`.
- The expected-duration string derives from `report.rolloutSeconds`.
- The resume/check path re-polls the persisted pipeline id and reports status without re-triggering.

Manual replay: re-run "upgrade all fleet elastic agents to 9.4.2 in ap-cld" and confirm the card reads
"started / running / ~60 min", not "failed"; then a follow-up "how's that upgrade going?" reports the
live pipeline status.

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/iac/state.ts` | `FleetUpgradeResult.status` += `dispatched`; persist apply pipeline id for resume |
| `packages/agent/src/iac/nodes.ts` | 3-way outcome branch (5994+); expected-duration message from `rolloutSeconds`; final status snapshot; resume/check node + intent |
| `packages/mcp-server-elastic-iac/src/tools/gitlab.ts` | fleet-apply result fetch uses its own (rollout-aware, env-overridable) budget, not `DRIFT_POLL_BUDGET_MS` |
| `packages/agent/src/iac/fleet-upgrade.test.ts` | dispatched-vs-failed mapping; duration string; resume path |
| `agents/elastic-iac/` (RULES/skills as needed) | document the "dispatched, track it" behavior + the check-status follow-up |

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| `dispatched` mistaken for success when the apply later fails | Medium | Copy is explicit ("running, not finished"); resume path surfaces the eventual `failed`/`failed_silent` |
| Resume re-triggers instead of re-polling | Low | Check path calls only read tools (`gitlab_get_pipeline` / `_apply_result`), never `_trigger_` |
| A genuinely-fast apply now returns `dispatched` instead of `applied` | Low | Keep a short bounded "did it start" wait; `success` within it still yields `applied` |
| `rolloutSeconds` absent/zero | Low | Fall back to a sensible default duration string + fixed budget |

## Out of scope

- Full async job runner / push-notification on apply completion (the resume path is pull-based here).
- The broader SIO-881 post-merge Terraform `apply:<cluster>` tracking (this ticket is the fleet-apply
  slice; they should share the "track a dispatched pipeline" primitive).
- Re-running the non-upgradeable (Wolfi/container) agents — still an upstream image-tag bump.

## Memory references

- `reference_fleet_upgrade_subflow` — the CI contract (jobs/vars/artifact, `failed_silent` ground truth)
- `reference_driftcheck_main_pipeline_permission` — prior instance of tool-timeout < runner round-trip
- `reference_config_edit_workflow_recipe` — agent/iac node + state touch-points
