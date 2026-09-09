# Operations gotchas

Hard-won pitfalls from operating the corp fleet. Each entry is still true;
remove an entry when the underlying behavior changes.

## Terraform

- Both corp roots use `lifecycle ignore_changes [ami]` and
  `user_data_replace_on_change = true`: any userdata-affecting change (for
  example `hub_url`) REPLACES the instance. Always read the "forces
  replacement" lines of a plan. AMI updates require
  `terraform apply -replace=<instance>`.
- Per-host configuration that must not churn instances belongs in the
  bootstrap, not in terraform or userdata (`PI_MONITOR_REPORT_TO` is set
  by the bootstrap for this reason).
- Per-host operator overrides go in `/home/piagent/.coms-env.local` (lines
  of `export KEY=value`, owned by piagent, mode 600). Both units source it
  after `.coms-env`; the bootstrap never writes it, so it survives bundle
  updates. To apply a change: `systemctl restart pi-monitor`, then
  `touch /home/piagent/.pi-agent-reload && systemctl restart pi-agent`.
  Typical use: `export PI_COMS_NET_MUTE_SENDERS='monitor-*'` to stop the
  monitor waking one account agent (SIO-1673).
- The fleet model (`eu.anthropic.claude-sonnet-5`) has a 1,000,000-token
  window and Pi only auto-compacts above `contextWindow - reserveTokens`
  (16,384 by default), i.e. at 98.4%. A spoke parked at 97-98% is normal
  Pi behaviour, not a wedge; the extension's token-based compaction
  (`PI_COMS_NET_COMPACT_ABOVE_TOKENS`) is what keeps sessions small. The
  settings-file alternative (`~/.pi/agent/settings.json`,
  `compaction.reserveTokens`) is not written by the bootstrap.
- The hub mailbox lives on a dedicated EBS volume (`<prefix>-hub-mailbox`,
  `prevent_destroy`) mounted at `/home/comshub/.pi/coms-net`. Replacing the
  hub instance keeps the inbox: the new host re-attaches and mounts the
  volume at boot. Stop `coms-hub` on the old host before the apply so sqlite
  is flushed. The volume is single-AZ with no snapshots; TTL (14 days) still
  bounds retention.
- The rendered agent userdata is hashed. Any byte change to
  `deploy/modules/agent/userdata.sh.tftpl`, a comment included, replaces
  every agent instance in every account. Behaviour changes go in the
  bootstrap (delivered by the S3 bundle); touch the template only when
  replacing agents on purpose.
- Never give `module "agent"` a `depends_on` on `module "hub"`: it defers the
  agent module's data sources to apply time, the security group's `vpc_id`
  becomes unknown, and Terraform replaces the SG and the instance whenever
  the hub changes. `terraform apply -target=module.hub` is the escape hatch
  if a plan ever couples them again.

## SSM

- Inline quoting in `aws ssm send-command` fails repeatedly. Reliable
  pattern: write the script locally, base64 it, then
  `echo <b64> | base64 -d > /tmp/x.sh && bash /tmp/x.sh`.
- `aws ssm wait command-executed` gives up after roughly 100 s. Poll the
  command status in a loop for long host-side work.
- AWS SSO sessions expire; re-authenticate with
  `aws sso login --profile <profile>`. Pasted temporary STS credentials
  cannot be refreshed from a session: probe `sts get-caller-identity`
  before a publish.

## Fleet deploys

- Order: publish the bundle (`deploy/publish-fleet.sh`), then either wait
  for the 30-minute State Manager convergence or run
  `/usr/local/bin/pi-coms-update` per host via SSM.
- `pi-coms-update` restarts `pi-monitor` (and `coms-hub` on the hub host)
  and signals the Herdr-hosted agent to relaunch. If an agent does not pick
  up new `extensions/` code: `pkill -TERM -u piagent -f cli.js`, wait for
  the name to leave the registry, then `systemctl restart pi-agent`. A
  bare unit restart sees "already registered" and leaves the old process
  running.
- IAM-only changes need `terraform apply`, no bundle.
- The daily digest carries the running `bundle:` version; a stale host is
  visible from the `ops` inbox without an SSM round-trip.

## Hub and peers

- Explicit peers (monitors, operator laptops with `--explicit`) are hidden
  from `GET /v1/agents` and the pool widget by design. Check
  `journalctl -u coms-hub` on the hub host for their register lines.
- In directory mode a held name is refused with `409 name_taken`; on a
  single-token hub it is auto-suffixed and the client warns. Either way,
  mail to the original name does not reach the new session.
- `herdr --remote`: a version mismatch triggers a remote update that
  bounces the agent (systemd recovers). Nested attach is refused from
  inside a local Herdr session.

- **A spoke that is `online` and answers every prompt within about 200 ms is a spoke whose model call fails.** Before SIO-1678 the extension posted the failed run's empty text as a `complete` reply, so the hub, `fleet status` and the monitor all looked healthy while schema-free prompts came back blank and investigations read `response not valid JSON`. First check CloudWatch `AWS/Bedrock` `InvocationClientErrors` for the spoke's model id in that account, then the newest Pi session jsonl on the host (`/home/piagent/.pi/agent/sessions/*/*.jsonl`, grep `"stopReason":"error"`) for the provider message. Seen 2026-09-09 on eu-oit-prd: `AccessDeniedException ... aws-marketplace:Subscribe` because account 762715229080 had no Bedrock model agreement for Haiku 4.5 (`aws bedrock get-foundation-model-availability --model-id anthropic.claude-haiku-4-5-20251001-v1:0` showed `agreementAvailability NOT_AVAILABLE`); an admin accepted it with `aws bedrock create-foundation-model-agreement`. A model swap needs that agreement in EVERY spoke account, not just the one the analyzer runs in. Since SIO-1678 such a turn is answered `status: error` with the provider message, and a blank reply is stored by the hub as `error: empty_reply`.

## Monitor

- Quiet cycles log nothing to journalctl. The sqlite journal
  (`~/.pi/monitor/state.db`, table `journal`) is the ground truth; read it
  host-side with a readonly `bun:sqlite` script via the SSM base64 pattern.
- The monitor observing an account changes the account: its API calls land
  in CloudTrail and EventBridge log groups. `/aws/events/` is excluded from
  the logs check for that reason; the pattern generalizes.
- Suppression patterns are SQL LIKE over dedup keys. Alarm keys end in
  `:STATE`, so a family pattern looks like `alarm:%-Utilization-Low-20:%`;
  a bare alarm name can never match. Ingestion keys end with a trailing
  colon. The weekly suppression review flags patterns with zero matches.
- Suppression applies at finding-emission time: findings already inside
  their re-alert window never reach the ledger, so `suppressed: 0` right
  after adding an entry is expected.
- MSK rebalance noise is one log signature per consumer group; suppress at
  the group level, not per exact key.
- Inbox messages age out at 14 days and the journal at 90 days; durable
  conclusions belong in Linear.

## Shell

- The Bash tool in Claude Code runs zsh: no word-splitting in
  `for P in "a b c"` loops. Use explicit per-host commands or arrays.
- Foreground `sleep` is blocked locally; host-side waits inside SSM
  commands are fine.
