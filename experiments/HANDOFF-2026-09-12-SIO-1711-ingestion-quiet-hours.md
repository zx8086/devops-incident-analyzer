# HANDOFF: SIO-1711 - monitor ingestion check fires on normal quiet hours

- **Date**: 2026-09-12
- **Ticket**: [SIO-1711](https://linear.app/siobytes/issue/SIO-1711) - Monitor ingestion check fires on normal quiet hours for event-driven functions
- **Related (filed same session, separate work)**: [SIO-1710](https://linear.app/siobytes/issue/SIO-1710) - two CloudTrail trails NOT logging in `eu-mendix-platform-prd`
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **Repo state**: `main` @ `324f3ec98953914a992341c16167bac54579ce2a` (clean; `.pi/` untracked and pre-existing)
- **Suggested branch**: `simonowusupvh/sio-1711-ingestion-quiet-hours`

## TL;DR

The hourly log-ingestion check alerts on **any single zero-count hour** when the same-hour 7-day median is >= 10. For event-driven Lambdas whose invocations are irregular, a zero hour is normal, so the check has raised the same false positive for `/aws/lambda/aws-controltower-NotificationForwarder` at least six times since 2026-09-07. The account's own spoke investigated and dismissed it every time, and has been recommending the fix since 2026-09-08.

Success: a single legitimate quiet hour produces no finding, while a genuine multi-hour ingestion stop still does. The existing false-positive pattern stops consuming the monitor's investigation budget.

## Context - how this ticket came to be

Not from a code review. It surfaced while reading the live ops inbox in the fleet pane at the end of a UI session: the digest for account `654654584630` carried this finding again, with the spoke's own six-occurrence dismissal attached. The spoke is doing the right thing and being ignored - its recommendation has been in the inbox since 2026-09-08 with nobody acting on it.

## Where the bodies are buried

**`packages/pi-coms/scripts/monitor/checks/ingestion.ts:64-88`** - the whole mechanism:

```ts
const observed = points.get(lastHourMs) ?? 0;
const history: number[] = [];
for (let d = 1; d <= BASELINE_DAYS; d++) history.push(points.get(lastHourMs - d * DAY_MS) ?? 0);
history.sort((a, b) => a - b);
const baseline = history[Math.floor(history.length / 2)];
const key = `ingest:${group}:`;
const at = new Date(now).toISOString();

if (observed === 0 && baseline >= minEvents) {      // <-- ANY zero hour alerts
    if (!state.shouldAlert(key)) continue;
    state.markAlerted(key, "ingestion");
    findings.push({
        family: "ingestion",
        severity: "warn",
        resource: group,
        summary: `Log ingestion stopped in ${group}: 0 events last hour vs same-hour 7d median ${baseline}`,
        dedup_key: key,
        evidence: { observed, baselineMedian: baseline, hourUtc: new Date(lastHourMs).toISOString() },
        at,
    });
} else if (observed > 0 && !state.shouldAlert(key)) {
    state.clearAlerts(key);
    findings.push({ family: "ingestion", severity: "info", /* "resumed" */ });
}
```

**`ingestion.ts:9-13`** - the constants:

```ts
const EXCLUDE_PREFIXES = ["/aws/events/"];
const MIN_EVENTS = 10;
const BASELINE_DAYS = 7;
```

Key detail: the same-hour baseline exists to silence nightly scale-to-zero (a group quiet at 02:00 every day has baseline 0, so `baseline >= minEvents` is false and nothing fires). That works. What it does **not** handle is a group whose median is high but whose distribution legitimately includes zeros - the median can be 27 or 51 while any individual hour is genuinely 0.

**CloudWatch detail that matters**: CloudWatch omits zero-count hours entirely rather than returning 0, so `points.get(lastHourMs) ?? 0` cannot distinguish "no data" from "measured zero". The spoke confirmed this independently via `AWS/Lambda Invocations`.

## The spoke's evidence (2026-09-12, verbatim from the ops inbox)

> CloudWatch get-metric-data (AWS/Lambda Invocations, Sum/1h) for 00:00-02:00Z on 2026-09-12 shows 12 and 6 invocations at 00:00Z and 01:00Z respectively with 0 Errors, and no datapoint at all for the flagged 02:00:00Z hour (CloudWatch omits zero-count hours), confirming the function genuinely received zero invocations that hour rather than experiencing a log-ingestion failure. This Control Tower NotificationForwarder only fires on upstream EventBridge/SNS organizational notifications, not a fixed schedule, so an isolated quiet hour is normal cadence.

> Reiterating the standing recommendation (first raised 2026-09-08): switch the monitor's alerting logic for this log group to a zero-tolerant rolling baseline or require a multi-consecutive-hour gap before raising a finding.

Occurrences so far: 2026-09-07, 2026-09-08 (x2), 2026-09-09, 2026-09-11, 2026-09-12.

## The fix - decide first, then implement

**This is not a decided ticket.** Three options, and the choice should be made explicitly rather than defaulted into:

1. **Require N consecutive zero hours.** Needs per-group zero-run state (`MonitorState` already persists in `~/.pi/monitor/state.db`, so there is somewhere to put it). Catches a real stop N hours later than today. Simplest to reason about.
2. **Zero-tolerant baseline.** If the 7-day same-hour history already contains any zero, a zero is evidently normal for this group - skip it. No new state. Weakness: one anomalous zero in the history permanently desensitises the group.
3. **Rolling window sum** (e.g. 3h observed vs 3h baseline). Changes the check's shape most; also changes what "last hour" means everywhere downstream.

Option 1 or 2 looks right. Whichever is chosen, **decide what happens to the paired `info` "resumed" finding** at `ingestion.ts:89-99` - it is only useful if the `warn` was real, and today it fires independently of whether a warn ever did.

### Step 1 - write the failing test first

`packages/pi-coms/tests/checks-ingestion.test.ts` already has the exact harness needed. `fakeClient` takes `{group: {offsetHours: value}}` where offset 0 is the observed hour and `d * 24` is the same hour d days back:

```ts
// Existing helper - a group chatty at this hour on each of the prior 7 days.
const activeBaseline = (lastHourValue: number): Record<number, number> => {
    const p: Record<number, number> = { 0: lastHourValue };
    for (let d = 1; d <= 7; d++) p[d * 24] = 100;
    return p;
};
```

Add a case matching the REAL shape: a history that is mostly active but contains zeros, with a single observed zero hour.

```ts
test("an event-driven group with a legitimately quiet hour does not warn", async () => {
    const state = new MonitorState(":memory:");
    // Irregular: busy some days, zero on others - median still >= MIN_EVENTS.
    const points: Record<number, number> = { 0: 0 };       // observed hour: quiet
    const history = [27, 0, 51, 12, 0, 33, 26];            // same hour, prior 7 days
    history.forEach((v, i) => { points[(i + 1) * 24] = v; });
    const out = await checkIngestion(fakeClient({ "/aws/lambda/forwarder": points }), state, { now: NOW });
    expect(out).toHaveLength(0);
});
```

Confirm it FAILS against current `main` before changing the check - that is the proof the ticket describes a real defect and not a misreading.

### Step 2 - keep the true-positive test passing

`checks-ingestion.test.ts` already has `"a normally-active group at zero warns once"` using `activeBaseline(0)` (100 events same hour every prior day, observed 0). That must still produce exactly one `warn`. If the chosen option breaks it, the option is wrong.

Add a multi-hour-stop case if option 1 is chosen, since a consecutive-hours rule needs its own coverage.

## Verification

```bash
cd packages/pi-coms && bun test tests/checks-ingestion.test.ts
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer && bun run typecheck && bun run lint
```

Expected: new quiet-hour test passes, existing `"a normally-active group at zero warns once"` and `"nightly scale-to-zero is silent"` both still pass.

**Live check (the real evidence, per SIO-1291)**: green tests do not prove the false positive stops. Read the ops inbox a day after rollout and confirm no new NotificationForwarder ingestion finding for account `654654584630`. The fleet pane's `Inbox ops` button shows this directly, or:

```bash
curl -s "localhost:5173/api/pi/mailbox?hubKey=eu-shared-services-prd&estates=eu-mendix-platform-prd" | jq '.messages[].prompt'
```

## Files to modify

| File | Change |
|---|---|
| `packages/pi-coms/scripts/monitor/checks/ingestion.ts` | The alerting condition at :77; possibly the `info` resumed branch at :89 |
| `packages/pi-coms/scripts/monitor/state.ts` | Only if option 1 - persist per-group zero-run count |
| `packages/pi-coms/tests/checks-ingestion.test.ts` | Failing-first quiet-hour case; multi-hour-stop case if option 1 |

## Deployment - do not skip

The monitor ships **in the fleet bundle**, so editing the file changes nothing on any host until published and rolled out:

```bash
# From merged main, clean tree under packages/pi-coms, agents/, packages/gitagent-bridge
PI_COMS_STAGE_DIR=/tmp/stage bash packages/pi-coms/deploy/publish-fleet.sh --stage-only   # dry run first
bash packages/pi-coms/deploy/publish-fleet.sh pi-coms-dist-399987695868 eu-shared-services-prd
```

Then roll out and **verify on the hosts** - SSM `Success` is not evidence the running agent picked up the code:

```bash
aws ssm send-command --targets Key=tag:Project,Values=pi-coms-net \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["/usr/local/bin/pi-coms-update"]' \
  --profile eu-shared-services-prd --region eu-central-1
```

Verify three things separately (see `reference_fleet_bundle_install_path_and_verify`):

1. `cat $AGENT_HOME/pi-coms/.bundle-version` equals the published SHA
2. the changed logic is actually on disk in `$AGENT_HOME/pi-coms/scripts/monitor/checks/ingestion.ts`
3. the agent process restarted (`ps -eo etimes,args | grep pi-coding-agent`, low uptime) and `ls /home/*/.pi-agent-reload` is gone

Path is `$AGENT_HOME/pi-coms`, **not** `/opt/pi-coms`, and differs per role (`/home/piagent`, `/home/comshub`). Discover it: `for d in /home/*/pi-coms; do echo $d; done`.

**Note**: the host reporting this finding had `.bundle-version` `75491f0b`, older than current main - worth checking whether the spoke accounts are lagging before concluding a fix did not land.

### Gotcha observed 2026-09-12

`aws ssm send-command --targets ...` returned `TargetCount: 0` immediately. That was **not** a wrong tag - targets resolve asynchronously, and `list-commands` a moment later showed `TargetCount: 2, Status: Success`. Do not re-issue on the strength of the initial `0`.

Also: the SSM rollout only reached the **2 instances in the hub account**. The five spoke accounts converge on their own State Manager schedule (every 30 min).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Fix desensitises a group that really does stop | Medium | Keep the `activeBaseline(0)` true-positive test green; option 1 delays detection by N hours, which is the explicit trade |
| Option 2 permanently silences a group after one anomalous zero in history | Medium | Prefer option 1, or require a minimum count of zeros in history before treating zero as normal |
| Zero-run state grows unbounded in `state.db` | Low | Key on the existing `ingest:<group>:` dedup key; clear on any non-zero hour |
| Fix looks live but hosts still run the old bundle | High (bitten before) | The three-part host verification above; check `.bundle-version` per host, not just SSM Success |

## Out of scope

- **SIO-1710** (CloudTrail not logging) - same digest, unrelated cause, its own handover.
- Changing the `logs` check family, which finds errors present rather than logging stopped.
- The monitor's `suppress`/`unsuppress` controls - suppressing this group would also hide a genuine outage of it, which is why this is a logic fix rather than a suppression.
- Anything in `apps/web` - the fleet pane work from this session is complete and merged.

## Related code references

- `packages/pi-coms/scripts/monitor/checks/ingestion.ts:35-40` - why the same-hour baseline exists (nightly scale-to-zero), correct as written
- `packages/pi-coms/scripts/monitor/checks/ingestion.ts:71-74` - the trailing-colon dedup key convention; group names nest, so prefix clears must stay exact
- `packages/pi-coms/scripts/monitor/state.ts` - `shouldAlert` / `markAlerted` / `clearAlerts`, the existing once-only alerting
- `packages/pi-coms/tests/checks-ingestion.test.ts:13-30` - `fakeClient` and `activeBaseline` helpers
- `packages/pi-coms/scripts/monitor/report.ts:275-276` - digest header construction (`daily digest` marker, relied on by the fleet pane's inbox anchoring)

## Memory references

- `reference_fleet_bundle_install_path_and_verify` - `$AGENT_HOME/pi-coms`, SSM Success != deployed, three-part verification
- `reference_sio1685_fleet_deploy_publish_bug_and_rollout_facts`
- `reference_fleet_deploy_live_gotchas`
- `reference_sio1673_spoke_context_1m_window_and_early_reply_race` - the monitor's investigate on/off and budget controls
- `feedback_no_cross_environment_access`
