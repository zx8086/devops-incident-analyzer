# HANDOFF — SIO-913 Fleet agent binary upgrade: elastic-iac REPO-SIDE deliverable

- **Date:** 2026-06-16
- **Ticket:** [SIO-913](https://linear.app/siobytes/issue/SIO-913) (parent epic [SIO-911](https://linear.app/siobytes/issue/SIO-911) "Agent proposes, GitOps disposes")
- **Target repo:** `observability-elastic-iac` — gitlab.com `pvhcorp/dhco/observability/observability-elastic-iac` (id 82850717). Local checkout: `~/Documents/Claude/Projects/Elastic Infrastructure Management IaC/`
- **This doc covers ONLY the elastic-iac repo changes.** The agent-side (this monorepo: MCP tools + `fleet-upgrade` sub-flow + tests) is delivered on its own PR and references this contract.
- **Suggested branch (in elastic-iac):** `feature/sio-913-fleet-upgrade-on-demand-ci`

## TL;DR

The DevOps agent needs to **propose** a Fleet agent **binary** upgrade (imperative `POST /api/fleet/agents/bulk_upgrade`, not Terraform) by triggering an on-demand GitLab CI pipeline — mirroring the existing `SYNTH_DRIFT_CHECK` / `SYNTH_PUSH` on-demand jobs. Two repo-side changes are needed:
1. **`scripts/fleet-bulk-upgrade.sh`** — add a `--report-file <path>` (JSON output) mode so preview/apply/verify emit a structured `fleet-upgrade-report.json` the agent can parse. The script currently prints human text + exit codes only.
2. **`.gitlab-ci.yml`** — add `fleet-upgrade-preview-on-demand` (gated `FLEET_UPGRADE_PREVIEW=true`) and `fleet-upgrade-apply-on-demand` (gated `FLEET_UPGRADE_APPLY=true`) jobs that run the script, redirect/collect the JSON artifact, and add the `when: never` exclusions to the regular jobs.

Success = the agent triggers a preview pipeline, reads `fleet-upgrade-report.json` (resolved agent count + target version + upgradeable crosstab), surfaces it for human approval, then on approval triggers an apply pipeline and reads the verify result (incl. silent-UPG_FAILED ground truth).

## Context — how this came to be

The user asked the Elastic IaC agent "upgrade all Elastic agents for eu-b2b that are upgradable to 9.4.2". That is a Fleet binary upgrade, classified `workflow: "other"`, which used to crash on a dead local-terraform path ([SIO-912](https://linear.app/siobytes/issue/SIO-912), fixed + merged PR #206). SIO-913 adds the real capability. Per the v7 restructure deck slide 18 ("Agent proposes, GitOps disposes") the agent must PROPOSE via CI trigger, never execute. Deck slide 12 documents the imperative Fleet flow (`make fleet-bulk-upgrade-{preview,apply,verify}`, 2,514 agents upgraded to 9.4.1).

## Where the bodies are buried (current repo state, file:line)

### `scripts/fleet-bulk-upgrade.sh` — emits human text, NOT JSON
The data the agent needs already exists in the script; it just prints it. Key points:
- **Version validation** (`385-396`): `AVAIL_JSON` from `/api/fleet/agents/available_versions`; warns if target not present.
- **Count resolution** (`399-424`): `COUNT` from `/api/fleet/agents?kuery=...&perPage=0` `.total`, or explicit `AGENT_IDS` count. Hard caps: `MAX_AGENTS`, 10000.
- **Preview-only stop** (`427-432`): prints `Resolved $COUNT agents would be upgraded to $VERSION over ${ROLLOUT_SECONDS}s.` then `exit 0`.
- **Apply POST** (`443-481`): POSTs `bulk_upgrade`, extracts `ACTION_ID=$(jq -r '.actionId')`.
- **Poll** (`483-491`, `poll_action()`): exit 0 COMPLETE/all-acked, 1 FAILED/failures, 2 ROLLOUT_PASSED-with-pending.
- **Verify sweep** (`499-501`, `verify_upgrade_details()` at `317-354`): queries `upgrade_details.action_id:"<id>" and upgrade_details.state:UPG_FAILED`; `failed_count = .total`; prints per-agent hostname/agent_id/error. **This is operationally critical** — Fleet's `action_status` undercounts silent `UPG_FAILED` (bug discovered 2026-05-17 on ap-cld). The agent MUST surface this count.
- **Final exit** (`502-509`, `worst_rc`): worst of poll + verify.

### `.gitlab-ci.yml` — no FLEET_* job exists (confirmed)
Pattern to mirror (`drift-check-synthetics-on-demand`, ~`302-367`):
```yaml
drift-check-synthetics-on-demand:
  stage: validate
  tags: [tools-prd]
  image: { name: alpine:3.19, entrypoint: [""] }
  variables: { BUN_INSTALL: "/root/.bun" }
  before_script:
    - apk add --no-cache bash git curl unzip libstdc++ >/dev/null
    - curl -fsSL https://bun.sh/install | bash >/dev/null
    - export PATH="$BUN_INSTALL/bin:$PATH"
  script:
    - |
      if [ -z "${DEPLOYMENT:-}" ]; then echo 'ERROR: DEPLOYMENT must be set'; exit 1; fi
    - |
      set +e
      bun run "$CI_PROJECT_DIR/scripts/synthetics-drift-check.ts" --deployment="$DEPLOYMENT" --format=json > synthetics-drift-report.json
      RC=$?; set -e
      cat synthetics-drift-report.json
      exit "$RC"
  allow_failure: { exit_codes: [2] }
  artifacts: { when: always, paths: [synthetics-drift-report.json], expire_in: 30 days }
  environment: { name: $DEPLOYMENT, action: prepare }
  interruptible: true
  rules:
    - if: '$SYNTH_DRIFT_CHECK == "true"'
      when: always
```
Exclusion rules in `validate` (`69-75`), `validate-trigger-logic` (`102-110`), `generate-pipeline` (`126-130`), `deploy` (`144-148`) each add `- if: '$<VAR> == "true"' when: never`.

Runner tag for all on-demand jobs: **`tools-prd`** (confirmed). The Fleet job runs bash + curl + jq only (no terraform), so `alpine:3.19` + `apk add bash curl jq` is sufficient (no Bun needed if the script stays bash).

## THE CONTRACT — `fleet-upgrade-report.json`

Both the bash emitter and the agent parser target this exact shape. snake_case (the agent parser maps to camelCase, same as the synthetics parser). All fields present in every mode; mode-irrelevant fields hold sentinel values (`null` / `[]` / `-1`).

```json
{
  "schema": "fleet-upgrade-report/v1",
  "mode": "preview",                     // "preview" | "apply"
  "deployment": "eu-b2b",
  "target_version": "9.4.2",
  "rollout_seconds": 600,
  "selector": "status:online",           // the KQL used (or "" for explicit ids)
  "resolved_count": 128,                 // agents matched by the selector
  "version_available": true,             // target in /available_versions
  "max_agents": 10000,                   // the cap that was in effect
  "upgradeable_crosstab": {              // pre-flight: who can/can't be Fleet-upgraded
    "upgradeable": 120,
    "not_upgradeable": 8,                // Wolfi/container agents (upgradeable:false) -> image-tag bump, NOT this flow
    "by_reason": [ { "reason": "wolfi_container", "count": 8 } ]
  },
  "action_id": null,                     // null in preview; the bulk_upgrade actionId in apply
  "apply": {                             // null in preview; populated in apply mode
    "poll_status": "COMPLETE",           // COMPLETE | ROLLOUT_PASSED | FAILED | ...
    "acked": 120,
    "created": 128,
    "failed_silent": 2,                  // verify-sweep UPG_FAILED count (the 2026-05-17 ground truth)
    "failed_agents": [                   // capped list for the report
      { "hostname": "host-7", "agent_id": "abc", "failed_state": "...", "error": "..." }
    ]
  },
  "exit_code": 0,                        // the script's final rc (0 ok / 1 fail / 2 rollout-passed-pending)
  "generated_at": "2026-06-16T00:00:00Z",
  "error": null,                         // populated when a mode could not complete (e.g. 0 agents)
  "error_reason": null
}
```

### Repo-side: `--report-file` implementation sketch
Add `--report-file <path>` arg parsing. Build the JSON with `jq -n` from the variables the script already computes, written at each exit point (after count resolution for preview; after verify for apply). E.g. preview:
```bash
emit_report() {  # called before each exit
  [[ -z "$REPORT_FILE" ]] && return 0
  jq -n \
    --arg mode "$MODE" --arg dep "$DEPLOYMENT" --arg ver "$VERSION" \
    --argjson rollout "$ROLLOUT_SECONDS" --arg sel "$SELECTOR" \
    --argjson count "${COUNT:-0}" --argjson avail "$VERSION_AVAILABLE" \
    --argjson maxa "$MAX_AGENTS" --argjson xtab "${CROSSTAB_JSON:-null}" \
    --arg action "${ACTION_ID:-}" --argjson apply "${APPLY_JSON:-null}" \
    --argjson rc "$1" --arg gen "$(date -u +%FT%TZ)" \
    --arg err "${ERR:-}" --arg errr "${ERR_REASON:-}" \
    '{ schema:"fleet-upgrade-report/v1", mode:$mode, deployment:$dep, target_version:$ver,
       rollout_seconds:$rollout, selector:$sel, resolved_count:$count, version_available:$avail,
       max_agents:$maxa, upgradeable_crosstab:$xtab, action_id:(if $action=="" then null else $action end),
       apply:$apply, exit_code:$rc, generated_at:$gen,
       error:(if $err=="" then null else $err end), error_reason:(if $errr=="" then null else $errr end) }' \
    > "$REPORT_FILE"
}
```
The `upgradeable_crosstab` needs a pre-flight `/api/fleet/agents?kuery=<sel> and upgradeable:false` count (and a `by_reason` from `os.name` Wolfi detection per deck slide 12) — add a small query before the preview stop. `failed_agents` reuses the `verify_upgrade_details` query output.

### CI job sketch (preview)
```yaml
fleet-upgrade-preview-on-demand:
  stage: validate
  tags: [tools-prd]
  image: { name: alpine:3.19, entrypoint: [""] }
  before_script:
    - apk add --no-cache bash curl jq >/dev/null
  script:
    - |
      if [ -z "${DEPLOYMENT:-}" ] || [ -z "${VERSION:-}" ]; then
        echo 'ERROR: DEPLOYMENT and VERSION pipeline vars are required'; exit 1; fi
    - |
      set +e
      bash "$CI_PROJECT_DIR/scripts/fleet-bulk-upgrade.sh" \
        --deployment="$DEPLOYMENT" --version="$VERSION" \
        ${SELECTOR:+--selector="$SELECTOR"} ${ROLLOUT_SECONDS:+--rollout-seconds="$ROLLOUT_SECONDS"} \
        --preview-only --report-file fleet-upgrade-report.json
      RC=$?; set -e
      cat fleet-upgrade-report.json || true
      exit "$RC"
  allow_failure: { exit_codes: [2] }
  artifacts: { when: always, paths: [fleet-upgrade-report.json], expire_in: 30 days }
  environment: { name: $DEPLOYMENT, action: prepare }
  interruptible: true
  rules:
    - if: '$FLEET_UPGRADE_PREVIEW == "true"'
      when: always
```
Apply job is identical minus `--preview-only`, gated `$FLEET_UPGRADE_APPLY == "true"`, job name `fleet-upgrade-apply-on-demand`, same artifact name. Add both `FLEET_UPGRADE_PREVIEW`/`FLEET_UPGRADE_APPLY` to the `when: never` exclusions in `validate`/`validate-trigger-logic`/`generate-pipeline`/`deploy`.

## Agent-side env knobs (already coded against this contract on the agent PR)
The agent MCP tools read these (defaults shown); the repo job names/var keys must match:
- `ELASTIC_IAC_FLEET_PREVIEW_VAR=FLEET_UPGRADE_PREVIEW`, `ELASTIC_IAC_FLEET_APPLY_VAR=FLEET_UPGRADE_APPLY`
- `ELASTIC_IAC_FLEET_PREVIEW_JOB_NAME=fleet-upgrade-preview-on-demand`, `ELASTIC_IAC_FLEET_APPLY_JOB_NAME=fleet-upgrade-apply-on-demand`
- `ELASTIC_IAC_FLEET_REPORT_ARTIFACT=fleet-upgrade-report.json`
- `ELASTIC_IAC_FLEET_PIPELINE_REF` (falls back to `ELASTIC_IAC_DRIFT_PIPELINE_REF` then `main`)

## Verification (repo side)
1. Lint the CI: `cd ~/Documents/.../Elastic\ Infrastructure\ Management\ IaC && (the repo's CI-lint, if any)`.
2. Dry-run the script JSON mode locally against a sandbox (gl-testing, 3 GB): `bash scripts/fleet-bulk-upgrade.sh --deployment=gl-testing --version=9.4.2 --preview-only --report-file /tmp/r.json && jq . /tmp/r.json` — assert `mode:"preview"`, `resolved_count`, `version_available`, `upgradeable_crosstab` present, `action_id:null`, exit 0, zero writes.
3. Trigger the preview pipeline via the GitLab API with `FLEET_UPGRADE_PREVIEW=true, DEPLOYMENT=gl-testing, VERSION=9.4.2` and confirm the `fleet-upgrade-report.json` artifact downloads with the contract shape.
4. **Do NOT run a live apply** without explicit operator sign-off. When you do, cross-check the Fleet UI per deck slide 12 step 5 and confirm `apply.failed_silent` matches the verify sweep.

## Risks and edge cases
| Risk | Likelihood | Mitigation |
|---|---|---|
| Script JSON mode drifts from the contract | Med | The agent parser is tolerant (sentinel defaults) but assert the v1 shape in a repo-side smoke test |
| Wolfi/container agents silently included | Med | `upgradeable_crosstab.not_upgradeable` must be populated from a `upgradeable:false` pre-flight query; agent reports them as skipped |
| Cold-runner round-trip > agent tool timeout | Med | Agent uses the `DRIFT_POLL_*` budget (300s) + a per-server `defaultToolTimeout` above the cold-runner ~130s (memory `reference_driftcheck_main_pipeline_permission`) |
| `action_status` undercounts failures | High (known bug) | Contract carries `apply.failed_silent` from the verify sweep; agent leads with it |
| Apply gated behind preview but human approves stale count | Low | Agent re-runs preview inside the apply path is NOT done; the apply selector must equal the previewed selector — keep the same DEPLOYMENT/VERSION/SELECTOR vars |

## Out of scope (this ticket)
- Config-edit stack proposers ([SIO-914](https://linear.app/siobytes/issue/SIO-914)..[SIO-920](https://linear.app/siobytes/issue/SIO-920)).
- Container/Wolfi image-tag bumps (a deployments-stack config edit -> belongs in [SIO-919](https://linear.app/siobytes/issue/SIO-919)).
- `fleet:bulk-unenroll-stale-*` (a separate imperative op; same pattern can be added later).

## Memory references
`project_elastic_iac_agent_proposes_gitops_disposes`, `reference_driftcheck_main_pipeline_permission` (runner tags + cold-runner tool-timeout), `reference_synthetics_drift_subflow` (the trigger/poll/gate sub-flow being cloned), `reference_elastic_iac_migrated_to_gitlab_com`.
