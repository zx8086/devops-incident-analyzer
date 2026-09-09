# HANDOFF 2026-09-09 — session close: monitor mute and budget, spoke context rail, drift grants, Haiku trial

**Date**: 2026-09-09
**Repo state**: `main` @ `259db3f2` plus this update, clean tree, nothing in flight
**Updated**: 2026-09-09 16:30 CEST — dev hub caught up after this doc was first written; see "Dev fleet" below
**Suggested branch**: n/a — nothing is half-done. The one open item is a
scheduled evaluation, not code.
**Linear**: SIO-1673, SIO-1674, SIO-1675, SIO-1676 (all Done by Linear's
merge automation, none by hand)
**Companion doc**: `experiments/HANDOFF-2026-09-09-SIO-1675-haiku-trial.md`
carries the trial evaluation recipe; do not duplicate it here.

## TL;DR

**Nothing is blocked and nothing is half-finished.** Four PRs merged (#716 to
#719), three fleet actions applied to production (an IAM policy update on
three spokes, one instance replacement on eu-oit-prd, two bundle rollouts),
and every process this session started is stopped.

The session began with the eu-oit-prd spoke at 98% context and about 150M
cached tokens read in three days. It ends with the mechanism fixed on every
prd spoke (bundle `e75cd657`), the noisy log groups suppressed, eu-oit-prd
running Haiku 4.5 as a one-week price trial, and a local scheduled task that
evaluates the trial on 2026-09-16 09:00 Europe/Amsterdam.

## What shipped

| PR | Issue | Squash | What |
|---|---|---|---|
| #716 | SIO-1674 | `05aca3b2` | `DriftAndComplianceReads` on the Terraform-managed `pi-coms-extensions` policy; spoke rule that drift detection is a read |
| #717 | SIO-1673 | `c3263057` | Monitor `PendingReplies` early-reply fix, persisted `investigate on\|off` / `pause` / `resume`, investigation budget (24/day, 3/resource/day), spoke inbound policy (mute, context rail, token-based compaction), `~/.coms-env.local` overrides |
| #718 | SIO-1675 | `af26bd91` | Re-rendered eu-oit-prd root with the Haiku 4.5 `pi_model` default |
| #719 | SIO-1676 | `ecd7aa38` | `history [count] [severity] [family]`; same-cause EC2 drift collapses into one `ec2:batch` finding; console and spoke persona guidance |

Docs commits straight to main (allowed for docs): bake-off ledger entries for
all four PRs, the SIO-1675 handover, this document.

## What was applied to production

| When (UTC) | Where | Action | Proof |
|---|---|---|---|
| 12:57 | eu-oit-prd, eu-mendix-platform-prd, eu-shared-services-prd | `terraform apply` of the IAM statement, plan-guarded | `Plan: 0 to add, 1 to change, 0 to destroy` on each; only `aws_iam_policy.pi_coms_extensions[0]` |
| 12:59 | monitor-eu-oit-prd | `suppress logs:/ecs/fargate/eu-oit-prd-log-group:%` and `...connectors-prd-log-group:%` | ledger listed both |
| 12:59 | eu-oit-prd host | `pi-agent` relaunch via `.pi-agent-reload` | back online at 0% |
| 13:15 | prd hub bucket | bundle `58d4ac28` published, rolled to three hosts | `.bundle-version` and monitor `budget 24/day...` line on each |
| 13:33 | eu-oit-prd | instance replaced for `PI_MODEL=eu.anthropic.claude-haiku-4-5-20251001-v1:0` | `Plan: 1 to add, 1 to change, 1 to destroy`; new `i-0cfa0e49f544e1288`; spoke registered with the Haiku model at 13:35 |
| 13:35 | monitor-eu-oit-prd | both suppressions re-sent (state db lost with the instance) | `suppressions` and `status` replies |
| 14:12 | three hosts | bundle `e75cd657` via `pi-coms-update` over SSM | bundle version, services, monitor and agent registration lines on each |
| 14:24 | dev hub bucket | bundle `259db3f2` (code-identical to `e75cd657`) published, rolled to eu-oit-dev and eu-shared-services-dev over SSM | bundle version, services, monitor and agent registration lines on each |
| 14:28 | eu-oit-dev, eu-shared-services-dev | `terraform apply` of the SIO-1674 IAM statement, plan-guarded | `Plan: 0 to add, 1 to change, 0 to destroy` on each; only `aws_iam_policy.pi_coms_extensions[0]` |

## Root cause, for the record

- The fleet model `eu.anthropic.claude-sonnet-5` has a 1,000,000-token window
  and Pi compacts only above `contextWindow - reserveTokens` (16,384), i.e. at
  98.4%. A spoke parked at 97-98% is Pi behaving as designed. Confirmed live:
  the eu-oit-prd session file had exactly one compaction entry and the spoke
  read 10% before the restart.
- The load was one application log group whose error messages produce fresh
  signatures each cycle (`checks/logs.ts` keys `logs:<group>:<sig>`, 24 h
  re-alert per signature): 72 of 105 findings in 28 h, each a full turn.
- Nothing on the monitor-to-spoke path could mute, budget, or compact.

## Invariants that are easy to break

- **Refusal reasons start with `refused:`.** The monitor's budget counts
  `investigation` journal rows by outcome and skips `refused`; the extension's
  `decideInbound` reasons carry the prefix. Change one side and a muted spoke
  burns the daily budget on instant refusals again (`scripts/monitor/budget.ts`
  `REFUSED_PREFIX`, `extensions/inboundPolicy.ts`).
- **Compaction runs from `agent_settled`, never `agent_end`.** In `agent_end`
  the run is still active and `compact()` aborts it. `agent_settled` shipped
  in Pi 0.80.5; hosts run 0.84.4 (`deploy/bootstrap/agent-bootstrap.sh:99`).
- **The persisted control wins over the env.** `PI_MONITOR_INVESTIGATE` only
  seeds a state db that has never seen `investigate on|off`.
- **Rendered roots are tracked; the manifest is not.** `deploy/fleet.yaml` is
  gitignored (main checkout only) and carries the eu-oit-prd `pi_model`
  override; `deploy/accounts/eu-oit-prd/main.tf` is committed with the same
  default (#718). Change one without the other and the next `fleet apply`
  either reverts the trial or drifts.
- **Batch drift findings use `resource: ec2:batch`** and keys
  `drift:batch:<new|state:<to>|gone>:<minute>`; a lone change keeps its
  per-instance key, so existing instance-id suppressions still match.
- **`packages/pi-coms/AGENTS.md` is generated.** Edit `agents/pi-fleet/*.md`
  and run `just sync-persona`; the exporter tests (442) pin the shape.

## Traps that cost time today

- **`fleet render` without `tokens ensure` writes a placeholder hub token**
  (36 chars vs the real 66) into `terraform.tfvars`, and the plan then rewrites
  `aws_ssm_parameter.coms_token`. Diff the rendered tfvars against the main
  checkout's, key by key with values hidden, before any apply.
- **`pi_model` rides in userdata**, so changing it replaces the instance and
  the monitor's `~/.pi/monitor/state.db` (suppressions, controls, fingerprints,
  journal) goes with it. Re-send suppressions after any replacement.
- **The fleet rollout CLI's hub poll hung past its 10-minute deadline** when
  the eu-oit-prd instance was replaced under it. Triggering
  `/usr/local/bin/pi-coms-update` per host over SSM and verifying
  `.bundle-version` plus the monitor's registration line is faster and
  deterministic (`scratchpad rollout.py` pattern, see the handover).
- **The rollout CLI reads the hub token from the env named by the hub's
  `token_env`** (`PI_COMS_NET_AUTH_TOKEN_PRD`); `publish` takes `--hub <key>`,
  not `--env`. Piping the CLI through `tail` hides progress until exit.
- **Worktree typecheck for `packages/pi-coms` reports TS2307** for
  `@earendil-works/*` because `pi-coms/node_modules` is absent in worktrees
  and the main checkout alike. Symlink `node_modules/@earendil-works/{pi-coding-agent,pi-tui,pi-ai}`
  and `node_modules/typebox` to the global nvm Pi install; never `bun install`
  there. The four `Bun.cron` TS2339 errors are pre-existing on main.
- **Bash that reads an operator-written file needs a repro, not a
  read-through.** Every reproduced defect from the local review was in
  `agent-bootstrap.sh`: `${!key}` under `set -u`, `;` versus `&&` before
  `exec`, `read -r` dropping a last line without a newline.
- **The artifact host refuses a publish from plan mode** and asks not to
  retry in the session; `SendUserFile` with the HTML is the fallback.
- **`echo ===X===` in zsh** expands `=X` as a command path and errors; quote
  separators.

## Verification

```bash
cd packages/pi-coms && bun test            # 304 pass on main @ 5defa6de
cd packages/gitagent-bridge && bun test    # 442 pass (persona exporter)
bun run lint
```

Live state, read-only (SSO profiles `eu-oit-prd`, `eu-mendix-platform-prd`,
`eu-shared-services-prd`; `aws sso login --profile <p>` if expired):

```bash
# bundle + monitor line on a host
aws ssm send-command --profile eu-oit-prd --region eu-central-1 \
  --targets Key=tag:Name,Values=pi-agent-agent --document-name AWS-RunShellScript \
  --parameters 'commands=["cat /home/piagent/pi-coms/.bundle-version; journalctl -u pi-monitor --since \"2 hours ago\" --no-pager | grep -o \"registered as .*\" | tail -1"]'
# expect e75cd657 and "... budget 24/day, 3/resource/day; investigate: on, paused: no"
```

Bedrock token metrics and the ops-inbox quality counter: scripts are in the
SIO-1675 handover, section "The evaluation".

## State of the fleet at handover

| Spoke | Instance | Bundle | Model | Notes |
|---|---|---|---|---|
| eu-oit-prd | `i-0cfa0e49f544e1288` | `e75cd657` | Haiku 4.5 (trial) | two log-group suppressions in the ledger; 0% context at 13:35Z |
| eu-mendix-platform-prd | `i-0691ab0612db77655` | `e75cd657` | Sonnet 5 | |
| eu-shared-services-prd | `i-085e7f9979d9f53df` | `e75cd657` | Sonnet 5 | hosts the prd hub too |

All three monitors: `budget 24/day, 3/resource/day; investigate: on, paused: no`.

### Dev fleet

| Spoke | Instance | Bundle | Model | Notes |
|---|---|---|---|---|
| eu-oit-dev | `i-0b69d671a3880000d` | `259db3f2` | fleet default | IAM statement applied |
| eu-shared-services-dev | `i-01de2cc4c069723e1` | `259db3f2` | fleet default | IAM statement applied; hosts the dev hub |

Both dev monitors report the same budget line. The dev hub's local tunnel port
(8787) belonged to the user's own session during this work and was never opened
by the session; every dev action went over SSM.

## Open, by design

- **Trial evaluation on 2026-09-16.** Local scheduled task
  `sio-1675-haiku-trial-evaluation` fires at 09:00 Europe/Amsterdam (runs on
  next app launch if the desktop app is closed). It has a dry-run guard
  before 2026-09-15 (steps 1 to 3 only, no Linear post). The user was asked
  to click "Run now" once to pre-approve its tools; whether that click
  happened is not recorded here. The task ends by asking the user to choose
  keep / widen / revert; it never applies.

## Known, documented, NOT fixed

- The logs check still emits up to 3 new warn findings per group per cycle
  (per-signature re-alert). The budget bounds the cost; the suppression ledger
  covers the live case; the drift check got the batching treatment (SIO-1676),
  the logs check did not. Candidate: a per-group daily emission cap.
- `investigate off` plus a resource already over its per-resource cap prints
  the cap reason on that finding instead of the operator's reason. Both are
  true; cosmetic.
- `REFUSE_ABOVE_PCT` is a percentage while `COMPACT_ABOVE_TOKENS` is a token
  count; on a 200K-window model the two are 10 points apart, on 1M they are
  700K tokens apart. Deliberate for now (the rail is about headroom, the
  compaction about cost), flagged by the review's altitude angle.
- `buildDigest` runs the `check_error` journal query twice (pre-existing).

## Review-bot status

Greptile returned `SKIPPED` within seconds on all four PRs (36 consecutive
skips since #711); CodeRabbit posted nothing. #717 was reviewed locally with
`/code-review high` (eight finder angles, ten surviving findings, seven fixed
before merge, three declined with reasons in the ledger). The other three PRs
merged on CI plus the user's explicit per-PR go-ahead. Every PR has a
`docs/code-review-bakeoff.md` entry.

## Related code references

- `packages/pi-coms/scripts/coms-net-monitor.ts` `handleCommand` (controls,
  history, status), the `investigate` closure (journal after reply, outcome)
- `packages/pi-coms/scripts/monitor/{pending,controls,budget,history}.ts`
- `packages/pi-coms/scripts/monitor/checks/drift.ts` `batchOrSingle`
- `packages/pi-coms/extensions/inboundPolicy.ts`, `extensions/coms-net.ts`
  (`refuseInbound`, `agent_settled` compaction)
- `packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh` (`.coms-env.local`,
  guarded forwarding loop, `&&` before `exec`)
- `packages/pi-coms/deploy/modules/agent/main.tf` `DriftAndComplianceReads`
- `packages/pi-coms/docs/architecture/monitoring.md`,
  `docs/architecture/communication.md`, `docs/deployment/operations-gotchas.md`

## Memory references

- `reference_sio1673_spoke_context_1m_window_and_early_reply_race`
- `reference_sio1675_fleet_render_placeholder_token_and_model_swap`
- `reference_sio1653_fleet_deploy_cli`
- `reference_sio1635_pi_coms_hub_client_gotchas`
- `reference_pi_coms_send_403_name_not_allowed`
- `reference_greptile_skips_docs_only_prs`
- `feedback_no_cross_environment_access`
- `feedback_capabilities_default_on_in_config_schema`
