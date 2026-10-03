# Handover: pi-coms fleet on Pi 1.0.1, update lock, Pi Durable decision

| | |
| -- | -- |
| Date | 2026-10-03 |
| Tickets | [SIO-1942](https://linear.app/siobytes/issue/SIO-1942) (Done), [SIO-1948](https://linear.app/siobytes/issue/SIO-1948) (Done) |
| Parent | none |
| Repo state | `main` @ `91077e86` (SIO-1948, PR #944), preceded by `4f7b78d4` (SIO-1942, PR #943) |
| Fleet state | all 8 spokes + both hubs on bundle `4f7b78d4`, Pi 1.0.1 |
| Rollback target | `61a056e0` in both buckets (Pi 0.99.2) |
| Suggested branch | none; both tickets are closed |

## TL;DR

Both tickets are closed and nothing is queued. This doc exists so a fresh
session knows three things without re-reading the 2026-10-03 session: (1) the
fleet is on Pi 1.0.1 with a launcher flag that matters, (2) every
`pi-coms-update` now runs under one `flock`, which changes how you roll out,
and (3) Pi Durable was evaluated and declined on measured evidence. The loose
ends below never became tickets; each says what would make it one.

## Context

The session started from "is Pi Durable (earendil.com/posts/pi-durable) a
better base for pi-coms?". Answer: no. Pi Durable is a single-process durable
agent harness (SQLite/JSONL, task checkpoints, replay-safe tools). It has no
network transport, so it could only replace the Pi runtime inside a spoke,
never the hub, mailbox or monitor, and adopting it means rewriting
`extensions/coms-net.ts` against a different extension API. Its one real win
for us is surviving an in-flight turn across a spoke restart, so we measured
how often that turn is lost (SIO-1942), then upgraded the fleet to Pi 1.0.1
(also SIO-1942). The rollout exposed an unlocked bundle swap that took the dev
hub down for about 7 minutes (SIO-1948, fixed the same day).

## Current state, with the code that matters

### Pi 1.0.1 on every spoke

`packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh:113` pins the install;
`packages/pi-coms/package.json` pins `pi-coding-agent` / `pi-tui` 1.0.1 for
typecheck (typebox stays 1.3.27). The launcher passes one new flag:

```bash
# agent-bootstrap.sh:705-708 (herdr agent start ... --)
  "${EXT_ARGS[@]}" \
  --tui-mode regular \
  --model "PI_MODEL_PLACEHOLDER" \
```

Pi 1.0.0 made the TUI fullscreen by default. Herdr readiness and the
read-only observers (SIO-1762) were proven against the regular screen, so the
flag keeps today's behaviour. Side effect observed: Herdr now reports
`interactive_ready: true` on the first attempt (before, `agent start` always
timed out and the hub registry was the readiness signal). Do not drop the flag
without re-proving the observers.

### Every updater runs under `/run/pi-coms-update.lock`

| Caller | Command | File |
| -- | -- | -- |
| State Manager association, 8 roots | `[ -x /usr/local/bin/pi-coms-update ] && flock -n /run/pi-coms-update.lock /usr/local/bin/pi-coms-update \|\| true` | `scripts/fleet/render.ts:453`, `deploy/accounts/*/main.tf` |
| `just fleet rollout` | `flock -w 900 /run/pi-coms-update.lock /usr/local/bin/pi-coms-update` | `scripts/fleet/rollout.ts:19-32` |
| `just fleet rollout --token-changed` | `flock -w 900 ... bash -c 'touch sentinel && ... && bash /var/lib/cloud/instance/user-data.txt'` | `scripts/fleet/rollout.ts:27` |
| `publish-fleet.sh` hint, deployment docs, pi-coms `CLAUDE.md` | `flock -w 900 ...` | `deploy/publish-fleet.sh:92` |

The lock lives at the CALLERS on purpose, not inside `pi-coms-update`:

- The hub writes its `pi-coms-update` from Terraform userdata
  (`deploy/modules/hub/userdata.sh.tftpl:45`) with
  `user_data_replace_on_change = true`, so editing it replaces both hubs.
- A second lock inside the script would be a separate open file description
  from the caller's lock: the inner `flock -n` would fail and every update
  would skip itself. **Never add a lock inside the script while callers hold
  one.**

Not locked, deliberately: cloud-init's first-boot run. `pi-coms-update` is
written after the first swap on both host types (hub template swap at
lines 24-37, updater at 45; agent bootstrap swap at 227-233, updater at 752),
and the association's `[ -x ]` guard is false until then.

### target_died frequency (the Pi Durable evidence)

`failDeliveredMail` (`scripts/coms-net-server.ts:870`) fails every delivered,
unanswered message when its spoke unregisters and logs a `target-died` line
(`:190`). Hub journals 2026-09-07 to 2026-10-03:

| Hub | responses | target-died |
| -- | -- | -- |
| dev | 716 | 0 |
| prd | 1633 | 2 (both 2026-09-12, `reason=shutdown`) |

2 of about 2,349 replies (0.09%). A durable spoke runtime is not justified.

## Verification (copy-paste)

Repo checks:

```bash
cd packages/pi-coms && bun run typecheck && bun run biome:check && bun run test
# expected: tsc clean, biome "No fixes applied.", 878 pass / 0 fail
```

Every account's association carries the lock (needs fresh SSO, see
`feedback_say_tokens_expired_plainly`):

```bash
for p in eu-shared-services-dev eu-oit-dev eu-shared-services-prd eu-oit-prd eu-mendix-platform-prd eu-ediservices-prd eu-b2b-ecom-prd eu-b2becom-v2-prd; do
  a=$(aws ssm list-associations --profile $p --region eu-central-1 --query 'Associations[?AssociationName==`pi-coms-fleet-update`].AssociationId' --output text)
  echo "$p $(aws ssm describe-association --profile $p --region eu-central-1 --association-id $a --query 'AssociationDescription.Parameters.commands[0]' --output text)"
done
# expected: 8 lines, each containing "flock -n /run/pi-coms-update.lock"
```

Rendered roots still match `render.ts` (run from `packages/pi-coms` with the
main checkout's gitignored manifest):

```bash
cat > rendercheck.tmp.ts <<'EOF'
import { readFileSync } from "node:fs";
import { loadManifest } from "./scripts/fleet/manifest.ts";
import { renderMainTf } from "./scripts/fleet/render.ts";
const m = loadManifest(process.argv[2]);
let bad = 0;
for (const n of Object.keys(m.spokes)) { const ok = renderMainTf(m, n) === readFileSync(`deploy/accounts/${n}/main.tf`, "utf8"); if (!ok) bad++; console.log(n, ok ? "matches" : "DIFFERS"); }
process.exit(bad);
EOF
bun rendercheck.tmp.ts ~/WebstormProjects/devops-incident-analyzer/packages/pi-coms/deploy/fleet.yaml; rm rendercheck.tmp.ts
# expected: 8 x "matches", exit 0
```

Re-measure target_died on a hub (SSM RunShellScript as root on the instance
tagged `Name=pi-coms-hub` in the `eu-shared-services-dev` / `-prd` profile):

```bash
journalctl -u coms-hub --no-pager | grep -c target-died
journalctl -u coms-hub --no-pager | grep -c response
```

## How to roll out from now on

1. Publish per hub from merged `main`; read `s3://pi-coms-dist-<acct>/fleet/version` first (rollback target).
2. Either `just fleet rollout <names>`, or per account
   `aws ssm start-associations-once --association-ids <id>`, or a manual
   send-command of `flock -w 900 /run/pi-coms-update.lock /usr/local/bin/pi-coms-update`.
   **Never a bare `pi-coms-update` or `bash user-data.txt`.**
3. Verify per host after the relaunch settles (a read in the extraction window
   returns the old version with no error, `reference_verify_bundle_after_rollout_settles`).
   `journalctl --since` cannot parse `ps -o lstart`; wrap it in
   `date -d "..." "+%F %T"` or a "registered with the hub" check reads 0 falsely.
4. Terraform: `fleet apply` re-plans with `-auto-approve`. For a change that
   must be exactly what you reviewed, run `terraform plan -out` per root and
   `terraform apply <planfile>` (what SIO-1948 did).

## Loose ends (not tickets; file one if the trigger happens)

| Item | Likelihood | Trigger / what to do |
| -- | -- | -- |
| CI `Test` hung once on PR #944 attempt 1: log stops at 20:46:17Z in `@devops-agent/web` after the `renderMarkdown` tests; the rerun passed in 2 min | Low | If it hangs again, read the cancelled run's log (`gh run view <id> --log`, only available once the run ends) for the last file, and file a ticket |
| Linear status writes from Claude silently no-op'd on 2026-10-03 (both connectors returned the old state, `updatedAt` unchanged); create and comment worked | Unknown | Check `updatedAt` after any status change; ask the user to set it by hand if it did not move |
| The hub's own `pi-coms-update` (Terraform userdata) is unlocked; only callers lock | Low | A raw manual run on a hub is the only path left. If a hub replacement is ever planned anyway, still do NOT add an inner lock (see above) |
| Pi Durable | n/a | Revisit only if `target-died` climbs well above 0.1% of responses |
| Mac operator console Pi is separate (nvm global) and was not touched | n/a | Upgrade separately if wanted |
| The worktree `.claude/worktrees/dazzling-bohr-377754` holds copied gitignored deploy config (`fleet.yaml`, per-root `terraform.tfvars`, `backend.hcl`) and `.terraform/` dirs | n/a | Gitignored, so harmless; remove with the worktree |

## Out of scope

- Adopting `@earendil-works/pi-durable` (declined on the numbers above).
- Changing the hub userdata template or any instance-replacing change.
- Upgrading the laptop console's Pi.

## Related code references

- `packages/pi-coms/docs/deployment/deployment.md` (rollout table, pin paragraph)
- `packages/pi-coms/docs/deployment/operations-gotchas.md` (the SIO-1948 gotcha)
- `packages/pi-coms/docs/deployment/deploying-from-a-worktree.md` (copy the gitignored config; `terraform` at `~/bin`)
- `packages/pi-coms/tests/fleet-preflight.test.ts` (`rolloutCommands` test: single locked token command, `bash -n` parse)
- `apps/web/src/lib/server/pi-fleet.ts:346` `sendFleetMessage` / `:399` `awaitFleetMessage` (the hub round-trip probe)

## Memory references

- `reference_pi_version_upgrade_procedure` (now includes the lock and `start-associations-once`)
- `project_open_after_2026_09_17_context_session` (fleet state line)
- `feedback_say_tokens_expired_plainly`
- `reference_fleet_rollout_host_by_host_over_ssm`
- `reference_verify_bundle_after_rollout_settles`
- `reference_worktree_gitignored_deploy_config`
- `feedback_roll_back_before_diagnosing_a_deploy_break`
- `feedback_greptile_skipped_codex_review_then_merge`
