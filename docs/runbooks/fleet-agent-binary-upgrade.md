# Fleet Agent Binary Upgrade Runbook

How to roll a new Elastic Agent binary version across a deployment's Fleet-enrolled agents
using the elastic-iac agent, and a log of every apply run. The Fleet agent binary version is
pure Fleet runtime state -- there is no repo file to diff -- so this flow is an imperative
`POST /api/fleet/agents/bulk_upgrade` dispatched via CI on explicit operator approval, NOT a
Terraform MR (SIO-913/SIO-924). Design: `docs/superpowers/specs/2026-06-16-fleet-apply-long-running-signoff-design.md`.

## Procedure

1. Ask the elastic-iac agent: `In the <deployment> deployment, upgrade the Elastic Fleet agents to version <X.Y.Z>`.
   Deployment resolution needs a live `EC_API_KEY`; since SIO-1463 an auth/connectivity failure
   is named in the clarify card instead of masquerading as "which deployment?".
2. The agent triggers `fleet-upgrade-preview-on-demand` in the
   [observability-elastic-iac](https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac) repo,
   polls the pipeline, and renders the preview card: resolved count, upgradeable crosstab,
   version availability, prior-upgrade recall, and (since SIO-1462) the KG change history.
3. The gate card requires an explicit Approve -- this is a LIVE `bulk_upgrade`, not an MR.
   Approving auto-passes the resolved count as `MAX_AGENTS` (blast-radius cap accepted by the
   approval itself, SIO-927).
4. The apply job runs `scripts/fleet-bulk-upgrade.sh`, polls `action_status`, then runs the
   per-agent `upgrade_details` verify sweep. The agent streams `iac_pipeline_progress` and
   renders the final summary from `fleet-upgrade-report.json` (contract `fleet-upgrade-report/v1`).

## Reading the result

- `failed_silent` (the verify-sweep `UPG_FAILED` count) is the ground truth. Fleet's
  `action_status` UNDERCOUNTS silent failures -- a clean action status alone is NOT success.
- `resolved_count` counts ALL enrolled agents (match-all kuery, no status filter), so it is
  expected to exceed the status-filtered Kibana Fleet UI count.
- `wolfi_container` agents are never Fleet-upgradeable; moving them is an image-tag bump in the
  deployments stack (a normal config-edit MR), not a Fleet action.
- Follow-ups like "how is the rollout going?" route to pipeline-status re-polling (SIO-928).

## Apply history

Newest first. One entry per apply run; previews are not logged unless they blocked.

### 2026-08-13 -- eu-b2b -> 9.5.1: succeeded (4/4)

- Job: <https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/jobs/15878831283>
  (action `1f4f873c-2aeb-406a-85f4-a02868af7f37`, rollout 600s, selector `*`)
- Matched 123 enrolled agents; 4 Fleet-upgradeable, all 4 succeeded; 0 failed, 0 rolled back,
  0 unsettled, `failed_silent: 0` (verify sweep clean).
- 119 skipped as `wolfi_container` (image-tag bump route if they should follow), 2 already on 9.5.1.
- Context: first apply after the EC_API_KEY rotation. The initial attempt earlier the same day
  hit the silent-clarify failure mode (dead key -> 401 -> "which deployment?"), diagnosed and
  hardened as SIO-1463 (PR #655); the stale key was replaced and resolution worked first try.

### 2026-08-02 -- eu-cld -> 9.4.4: succeeded

- Job: <https://gitlab.com/pvhcorp/dhco/observability/observability-elastic-iac/-/jobs/15664434354>
- Recorded from session notes: 1752 agents matched, 1615 tracked by the action, 134 ignored at
  POST time (Fleet re-evaluates when the action is created, so the denominators differ; that
  log-format confusion led to elastic-iac MR !401 / SIO-1365, which made apply logs track only
  the actioned set).
