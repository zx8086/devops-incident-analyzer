# Monitoring and the Hub Mailbox

Proactive monitoring of each AWS account by its own agent host, with durable delivery of reports to the operator. Two cooperating pieces, added together because one is useless without the other: the monitor detects issues on a schedule, and the hub mailbox guarantees its reports survive until the operator's next session -- the operator's laptop is usually offline when a check runs.

Design record: SIO-1575 (the original spec and implementation plan live in git history under `docs/superpowers/`, removed 2026-09-03).

```
+------------------+   15min/hourly/daily +------------------+
|  pi-monitor      | -- Bun.cron ticks -->|  checks (AWS SDK)|
|  (Bun process,   |                      +---------+--------+
|  coms-net peer)  |                                | Finding[]
+---+----------+---+                                v
    |          |                          +------------------+
    |          +--- coms send ----------->|  Pi agent        |
    |             "investigate" (batched) |  (model, tools)  |
    |          +--- auto-reply -----------+------------------+
    |          v
    |   report = findings + diagnosis
    |
    +--- coms send, ttl=days ---> hub mailbox (sqlite) ---> operator's
                                                            next session
```

The monitor and the Pi agent are separate processes on the same host. A wedged agent never stops detection; a crashed monitor (restarted by systemd) never touches the agent.

---

## The hub mailbox

The hub (`scripts/coms-net-server.ts`) stores messages in `bun:sqlite` at `~/.pi/coms-net/projects/<project>/messages.db` (WAL mode), write-through: creation inserts a row, every status transition updates it, the TTL sweep deletes terminal rows. The in-memory map stays the hot path; registry, SSE streams, and awaiters remain memory-only.

### Two TTLs

`POST /v1/messages` accepts an optional `ttl_ms`, capped by `PI_COMS_NET_MAX_TTL_MS` (default 14 days). The default TTL stays 30 minutes (`PI_COMS_NET_MESSAGE_TTL_MS`).

| Send | Target online | Target offline |
|------|---------------|----------------|
| Default / short `ttl_ms` | Delivered immediately | `target_not_found` (404), exactly as before |
| `ttl_ms` beyond the default | Delivered immediately, longer expiry | **Queued by name**: `200 {status: "queued", target_session: null}` |

A name-queued message is claimed by the next session that registers under that name (session ids change per connect, so the queue binds to the name, not a session). Interactive traffic keeps minutes; monitor reports use days.

### Flush on connect

When a session's SSE stream opens, the hub -- after `hello` and `pool_snapshot` -- claims any name-addressed mail for that session and flushes its queued messages oldest-first as `prompt` events flagged `mailbox: true`. Flushed mail does NOT trigger turns on the recipient (SIO-1579): the extension shows a passive notice per message and the operator reads the content on demand with `coms_net_inbox`. The prompt's sender identity comes from values stored at send time, so it renders correctly even if the sender is long gone.

### The durable inbox: read-many, on demand

Mailbox-class messages double as history. A terminal (delivered and answered, or expired-in-queue) mailbox message is retained in `messages.db` until its TTL expires, and `GET /v1/mailbox?name=<name>&limit=&since=<msg_id>` reads it back non-destructively — every operator sees the same list whenever they connect, with `since` as a stateless cursor (ULID ids sort by time). The client tool is `coms_net_inbox` (defaults to your own name; pass a shared name like `ops`). Short-TTL interactive messages never enter the inbox. Flush-on-connect still happens, but as quiet mailbox-flagged events -- the inbox is the read path, not the push.

### Conversation history

Completed interactive prompts (an operator asking an agent, the agent's reply, or an expiry with no reply) stay in the same database for 14 days after completion (`PI_COMS_NET_HISTORY_RETAIN_MS`) and are read through the target's inbox: `coms_net_inbox name=eu-oit-dev` lists what that agent was asked, by whom, when, and what it answered. The `ops` inbox holds only mail addressed to `ops`. In-flight messages are not listed until they complete.

### Restart recovery

The mailbox database sits on a dedicated EBS volume mounted at `~/.pi/coms-net` on the hub host, so it survives a hub process restart, a reboot, and a Terraform instance replacement alike. What it does not survive: loss of that single volume or its availability zone, and the message TTL (14 days by default) still bounds retention.


On boot the hub reloads all non-terminal messages from every project's `messages.db`. Delivered-but-unanswered mail is re-queued by name (at-least-once delivery: a peer that answered just as the hub died may see the prompt again). A new `server_id`, same mail. The hub container mounts a named volume (`coms-hub-mail` -> `/home/bun/.pi/coms-net`) so mail also survives container recreation.

### What changed about the hub's trust posture

The hub used to store nothing durable. It now persists **prompt and response bodies at rest** in `messages.db` until delivery plus sweep (up to 14 days for mailbox sends). See [Security Model](../security/security-model.md#hub-data-at-rest).

---

## The monitor

`scripts/coms-net-monitor.ts` runs as `pi-monitor.service` on every agent host, installed by the shared bootstrap. It sources `~/.coms-env`, so it sees the hub URL, token, `AWS_REGION`, and `AWS_ACCOUNT_ID`.

| Property | Value |
|----------|-------|
| Peer name | Code default `monitor-aws-<account_id>`; the bootstrap sets `monitor-<alias>` (e.g. `monitor-eu-oit-dev`) on deployed hosts. Registered `--explicit` (hidden from lists and broadcasts unless named) |
| Scheduling | In-process `Bun.cron()` (requires Bun >= 1.4): `*/15 * * * *` for alarms/logs/drift/health, `7 * * * *` for the ingestion heartbeat plus the Config compliance and GuardDuty scans (minute 7 keeps its guard off the */15 boundary), `@daily` for cost/trail/certs/listener-certs/watchlist + digest. Schedules are read in `PI_MONITOR_TZ` when set, otherwise the host zone -- UTC on deployed spokes, since nothing sets `TZ` |
| State | `bun:sqlite` at `~/.pi/monitor/state.db`: watermarks, alert fingerprints, resource snapshots (instances, security groups, route tables, RDS, Lambda), cost history, journal, unsent-report queue |
| Model usage | None inside the monitor. Zero token spend when no findings |
| Modules | `scripts/monitor/checks/{alarms,logs,drift,resource-drift,cost,ingestion,trail,certs,watchlist,health,compliance,guardduty}.ts`, `state.ts`, `report.ts`, `coms.ts` (headless coms-net client) |

### Checks

All checks are deterministic AWS SDK calls under the instance role, with clients injected for testability.

Every cycle starts with a T0 gate: `sts:GetCallerIdentity` compared against `AWS_ACCOUNT_ID`. A denial or account mismatch is a critical finding and skips the rest of that cycle's checks -- a monitor that silently loses access would otherwise report "all quiet" forever, and broken credentials would turn every check into correlated noise.

| Check | Cadence | Logic | Dedup |
|-------|---------|-------|-------|
| Identity (gate) | every cycle, first | `GetCallerIdentity`; mismatch or denial critical, recovery info | 24 h re-alert while broken; the gate skip continues even while deduped |
| Alarms | 15 min | `DescribeAlarms`; transitions into ALARM (critical) / INSUFFICIENT_DATA (info -- nightly scale-to-zero flaps these by design), recovery to OK (info). SIO-1739: a `LessThan*` alarm on a utilization-class metric (`*Utilization`, `RequestCount`, `Invocations`; `HealthyHostCount` stays critical) is an idle signal and reports warn; a new ALARM entry reads `DescribeAlarmHistory` for the last 24 h and reports warn with `flapping: n` once it has entered ALARM 3 times (a denied history read changes nothing). The finding's evidence carries the metric, dimensions, comparison, threshold and the datapoint parsed from `StateReason`, so the spoke diagnoses from the alarm definition | Alarm name + state: a still-firing alarm alerts once, and only a state change re-arms it |
| Log errors | 15 min | `FilterLogEvents` since a per-group watermark, pattern `?ERROR ?Exception`, grouped by a normalized message signature (timestamps, UUIDs, hex, digits, and mixed-alphanumeric ids all collapse); capped at 3 signatures/group and 10 warn findings/cycle, overflow journaled as one info finding. A group denied by the name-scoped log IAM is one info scoping finding, and the scan continues | Group + signature hash; re-alerts after 24 h |
| Drift/health | 15 min | Instance state changes vs the stored snapshot (stop/terminate = warn), failed status checks. Instances that appear, change state the same way, or disappear together in one cycle collapse into ONE finding (`resource: ec2:batch`, dedup key `drift:batch:<new|state:<to>|gone>:<minute>`, ids in the evidence, SIO-1676), so a node-pool replacement is one report line and one investigation instead of one per instance; suppress a batch family with `drift:batch:gone:%` | Edge-triggered by the snapshot diff; status-check fingerprints clear on recovery |
| Resource drift | 15 min | Snapshot diffs beyond instances (SIO-1597): security-group ingress+egress rules (change = warn), route-table routes (change = warn), RDS instance settings (public flip = critical, status = warn, class/version = info), Lambda config from one paginated `ListFunctions` (role = warn, rest info). New/deleted resources are info; a failing sub-scan is one fingerprinted info finding and the other scans still run | Edge-triggered by the snapshot diffs; scan-failure fingerprints clear on recovery |
| Cost | daily | Yesterday vs the trailing 14-day baseline (the median of those days, SIO-1739: a mean let one spike day hide every rise for two weeks); alerts when over by more than `PI_MONITOR_COST_ABS` (fleet default $100; the percentage gate `PI_MONITOR_COST_PCT` is off at 0, SIO-1680) | Once per date |
| Ingestion | hourly | Metrics Insights `IncomingLogEvents` per log group; warn when the trailing full hours are all 0 for at least `PI_MONITOR_INGEST_ZERO_HOURS` (3) AND longer than the group's own longest quiet run in the prior 7 days (SIO-1739: an event-driven forwarder with three-hour gaps every day is not stopped after three hours; it is stopped once it outlasts its own history), against a same-hour-of-day 7-day median >= 10 (so the nightly scale-to-zero is silent by construction, and an event-driven function's isolated quiet hour no longer fires -- SIO-1711); recovery info. The finding carries the last 24 hourly values and the 7 same-hour values so the spoke never re-derives a baseline. The inverse of the log-errors check: it finds logging that **stopped** | Per group, alert once until recovery |
| Trail | daily | `GetTrailStatus` per trail: `IsLogging=false` is critical only when **no** readable trail is logging (the account is dark), otherwise warn -- `DescribeTrails` in a member account also returns the org's trails, owned by the management account, where a stopped one is unactionable locally and routinely a deliberate consolidation (SIO-1713). Delivery error warn, zero trails info; recovery info. Shadow org trails that deny status reads are tolerated and cannot establish coverage | Per trail + condition, 24 h re-alert |
| Health | 15 min | `health:DescribeEvents` (global endpoint, `open` and `upcoming` events for the host region and `global`); an open issue or investigation is warn, a scheduled change is warn inside 48 h of its start and info beyond, account notifications info. An account without a Business or Enterprise support plan answers `SubscriptionRequiredException`: one info finding a week, never a check error (SIO-1740) | Event ARN + severity, 24 h re-alert, so a scheduled change crossing into the 48 h window warns at once; an event that leaves the open set re-arms |
| Compliance | hourly | `config:DescribeComplianceByConfigRule` (NON_COMPLIANT rules) plus `GetComplianceDetailsByConfigRule` per rule, snapshot-diffed like resource drift: a resource newly NON_COMPLIANT is one warn finding; a pair that vanishes is info worded as no longer reported NON_COMPLIANT (only NON_COMPLIANT results are ever read, so recovery is never asserted); standing findings stay silent after the first run establishes the snapshot (first run silent). Capped at 20 warn findings per run with an info overflow that carries every omitted pair. A rule whose details cannot be read keeps its previous entries, or a sentinel when it never had any so its first complete read is a silent baseline, and reports one info scoping finding a day (SIO-1740: the `restricted-rdp` flip that was only visible as a Lambda burst is now the finding itself) | Rule + resource id |
| GuardDuty | hourly | `ListDetectors`, then `ListFindings` at severity >= 4 updated since the per-detector watermark (first lookback 24 h) and `GetFindings` for titles; GuardDuty 7+ is critical, else warn. No detector means GuardDuty is not enabled here: silent, not an error (SIO-1740) | Finding id, 24 h re-alert; fingerprints are marked and the watermark advances (bounded by the scan's start) only after every batch succeeded |
| Certs | daily | ACM `NotAfter` across the host region and `us-east-1` (CloudFront certs live there; list configurable): < 30 d warn, < 7 d critical (managed renewal happens ~60 d out, so < 30 d means renewal is failing). A cert whose domain is covered by another valid cert in the same region (exact or single-label wildcard, DomainName or SANs) reports `info` as superseded -- a rotated-out cert is cleanup noise, not risk. A cert with an empty `InUseBy` reports `info` whatever its expiry (SIO-1724): an expiry only breaks TLS when something serves the cert, so an unattached one is cleanup, not an outage -- and an already-expired cert reads as "expired N day(s) ago", never "expires in -N days". An unreadable region is one info scoping finding; the other regions still scan | Per cert + severity, 7 d re-alert |
| Listener certs | daily | ELBv2 `DescribeListenerCertificates` per TLS listener across the same regions as the cert check. ACM alone cannot answer "is this domain covered?": a listener carries extra SNI certificates beyond its default, so a name absent from ACM may still be served. Reports the extra SNI certificates as one `info` inventory finding per listener. A denied or unreachable read is one `info` scoping finding per region saying SNI certificates are **not inspected** -- never silence, because silence would read as "no certificate" | Per listener, 7 d re-alert |
| Watchlist | daily | `cloudtrail:LookupEvents` for scary write events (StopLogging, SG ingress/egress and revocations, route changes, S3 exposure, IAM edits, ...); one call per event name, watermarked. `ModifyDBInstance` is deliberately absent: resource drift catches RDS changes within 15 minutes while this list runs daily. The monitor is read-only, so its own CloudTrail echo can never match | Per event id |
| Targets | 15 min | `DescribeTargetGroups` + `DescribeTargetHealth` (SIO-1748). The first family that reads continuous operational state, so the raw state is not the signal: `initial` and `draining` are excluded outright (they are what a rolling deployment looks like) and a target must be `unhealthy` across TWO CONSECUTIVE CYCLES before it is a finding. Zero healthy in a group is critical, some healthy is warn. Evidence carries the reason code (`Target.FailedHealthChecks`, `Target.Timeout`, `Target.ResponseCodeMismatch`) and the whole health-check config, so the spoke decides target-vs-check without a round trip | Snapshot of the per-group unhealthy set supplies the duration gate; group fingerprint, 24 h re-alert, clears on recovery |
| Tasks | 15 min | Three things ECS asserts about a service (SIO-1748), never the stopped tasks themselves -- every deployment and scale-in stops tasks. (1) `deployments[].rolloutState == FAILED`: the circuit breaker already ruled, critical. (2) A service event matching a failure phrase, free with `DescribeServices`: `is unable to consistently start tasks successfully` is ECS reporting a crash loop, which counts cannot see because tasks die and are replaced fast enough that `runningCount` never drops; also no-capacity placement, failing health checks, image/secret pull, `ResourceInitializationError`. (3) `runningCount < desiredCount` sustained across two cycles. Stopped-task reasons are left to the investigation, which has the CLI and the ecs-task-failures runbook | Snapshot for the shortfall gate, watermark on service events, per-signal fingerprint, 24 h re-alert, clears on recovery |
| Queues | 15 min | `ListQueues` + `GetQueueAttributes` (SIO-1748). Depth on a source queue is never reported -- a queue holding messages is a queue working. A DLQ is identified semantically, by being the `deadLetterTargetArn` of some other queue's redrive policy rather than by name, so a `-dlq` scratch queue nothing redrives into stays silent; any depth on a real one means messages already failed `maxReceiveCount` times. Evidence names the source queues, which is where the fault is. Source-queue backlog is deliberately absent: it needs a self-baseline over the CloudWatch `ApproximateAgeOfOldestMessage` history (not a queue attribute), sized on shadow data | Per queue fingerprint, 24 h re-alert, clears when drained |
| Scaling | 15 min | `autoscaling:DescribeScalingActivities`, `StatusCode` in {Failed, Cancelled} since a watermark (SIO-1748). No invented threshold: Auto Scaling labels the failure itself. Catches InsufficientInstanceCapacity, quota exhaustion, a launch template referencing a deleted AMI or security group, and `iam:PassRole` denials -- none of which produce an alarm unless somebody wrote one. Activities sharing a normalized cause collapse into one finding, so one AZ running dry is one report line rather than one per group. Application Auto Scaling is not read: it needs a call per ServiceNamespace and its ECS failures already surface through the tasks check | Normalized cause + group, 24 h re-alert; watermark bounded by the scan start |
| Db-events | hourly | `rds:DescribeEvents` filtered SERVER-side on `EventCategories` to failure / failover / low storage / availability (SIO-1749). The cleanest discriminator in the set, because the API does it: an account with 90 events over 14 days returns 0 once filtered, since all 90 were automated snapshot activity. `failure` and `low storage` are critical, the rest warn. ElastiCache is deliberately not read -- its events carry NO EventCategories field at all, so there is no categorical discriminator and every message observed in production was benign or self-healing | Source + category set, 24 h re-alert |
| Stacks | daily | CloudFormation `DescribeStacks`, snapshot-diffed (SIO-1749). CloudFormation states its own verdict, so the discriminator is a suffix of the status enum: `*_FAILED` is critical, a completed rollback is warn (the stack survived, the deployment did not), everything else silent. Edge-triggered, because a stack that has sat in `UPDATE_ROLLBACK_COMPLETE` for a year is not news every day. A failed stack costs one extra `DescribeStackEvents` for the failing resource and reason, and a denied read loses only the evidence, never the finding | Edge-triggered by the snapshot diff; first run establishes the baseline silently |
| Nodegroups | hourly | EKS `ListNodegroups` + `DescribeNodegroup` (SIO-1750). `ListClusters`/`DescribeCluster` were already granted but carry no node health -- `DescribeCluster` returns no `health` field at all -- so a nodegroup whose nodes cannot join was invisible. The discriminator is AWS's own twice over: `health.issues` is a list EKS populates when it has diagnosed the problem itself (code, message, affected resource ids), and `status` is a closed enum where DEGRADED and *_FAILED mean what they say. Failed status is critical; issues without a failed status are warn, because the group still serves but something will bite later | Nodegroup + status, 24 h re-alert, clears on recovery when the scan was complete |
| Quotas | daily | Trusted Advisor `DescribeTrustedAdvisorCheckSummaries` over the `service_limits` category (SIO-1750). **This replaces the Service Quotas design entirely**: rather than walking every quota and correlating each against `AWS/Usage` metrics to derive a utilisation percentage, ONE call answers all 52 service-limit checks, each carrying AWS's own `ok`/`warning`/`error` verdict -- so there is no threshold to invent. `error` (limit reached) is critical, `warning` (approaching) is warn. us-east-1 only; an account without a Business or Enterprise support plan answers `SubscriptionRequiredException`, reported once a week as info exactly as the health check treats it | Check id + status, 24 h re-alert, clears when no longer flagged |

### Shadow families (SIO-1748)

A new check family cannot be sized in advance. No reasoning says how many
findings `targets` raises a day in a busy account, and the dev spokes are too
quiet to measure it -- which is exactly why they are safe to deploy to and
useless for this.

`PI_MONITOR_SHADOW_FAMILIES` lists families that are detected and journalled as
`shadow_finding` but never reported, never investigated, and never matched
against the suppression ledger. The rate is then read off the journal in real
production traffic at no token cost and with no impact on the `ops` inbox:

```
monitor-eu-oit-prd history 200 warn targets shadow
monitor-eu-oit-prd status          # names the 24 h shadow count
```

**The four SIO-1748 families default to shadow** (`SHADOW_DEFAULT` in
`coms-net-monitor.ts`), so a deploy that sets nothing cannot put four unmeasured
families into the `ops` inbox on its first cycle. Setting the variable REPLACES
the default, so it names the families that should stay in shadow; an empty
string graduates all of them. The daily digest names whatever is still in
shadow with its 24 h count, because `status` is a pull and a family left in
shadow and forgotten is a check that silently never fires.

A family graduates by being removed from the list.

**Graduation does not replay what shadow already saw (SIO-1751).** A shadow run
still marks its fingerprints and writes its snapshots -- checks do that inside
themselves, before `runCycle` partitions shadow rows away. So a freshly
graduated fingerprint family (`queues`) stays silent on everything shadow
already found until its 24 h re-alert window expires, and a snapshot-diff
family (`stacks`, `targets`, the `tasks` shortfall) never re-reports a
standing condition at all -- only new transitions. Replay is deliberately not
built. Instead the digest **names** shadow findings, not just their count, in a
section marked UNMEASURED that stays visible for 24 h after a family graduates.
That is where a condition shadow found before graduation remains readable.

The digest's shadow section is kept apart from the real notables and carries
no `[uninvestigated]` marker: shadow never investigates by design, so the
marker would read as a failed investigation, and none of it feeds the real
uninvestigated count.

**`queues` graduated in SIO-1751**, the first family to leave shadow. Its
discriminator leaves nothing to measure -- a queue is only a DLQ because
another queue redrives into it, so depth on it means messages already failed
`maxReceiveCount` times -- and its first production cycle found 563 such
messages across three dead-letter queues that nothing had been reporting. One whose rate cannot be
made defensible is reconsidered rather than shipped. Shadow rows are kept out
of the ledger deliberately: a suppression entry records a finding an operator
has accepted, while a shadow row records one the fleet has not yet agreed is
worth reporting at all, and conflating them would make the weekly suppression
review report a shadow family as something the ledger is masking.

Watermarks, fingerprints, and snapshots all persist in `state.db`, so a monitor restart produces neither duplicate nor missed alerts.

### The suppression ledger

Operator-accepted imperfections (`suppress <pattern> | <reason>`) live in a `suppressions` table; patterns are SQL `LIKE` against `dedup_key`, so `alarm:%-Utilization-Low-20%` covers a whole alarm family. A matching finding is journaled (`suppressed_finding`), never investigated, and never in the report body -- the incident report carries a one-line footnote count and the digest a daily total. This is the anti-fatigue device: a periodic report is read hundreds of times, and known, accepted imperfections must not re-raise as fresh findings.

The counterweight is the scheduled suppression review (weekly by default): a mailed report listing every ledger entry with its reason, age, match count in the window, and sample dedup keys. Entries with zero matches are flagged as unsuppress candidates; a high-count entry is a prompt to re-examine what the pattern is actually eating. The same text is available on demand via the `review` command.

The agent module provisions one alarm itself -- `<name_prefix>-agent-status-check` (`StatusCheckFailed` on the agent host, no actions) -- so the alarm family always has a real signal even in an account with no other alarms: a degraded agent host becomes a critical incident report instead of silence.

### Investigation

Findings of severity warn or critical go to the account's Pi agent (`aws-<account_id>`) as **one batched coms prompt per run**, carrying a `response_schema` for structured diagnoses (probable cause, affected resources, suggested action) and prior-incident context from the journal. Timeout 5 minutes, one attempt; on timeout or an unparseable reply the report ships with an "uninvestigated" marker. Detection never depends on the model.

#### Investigation budget and operator controls (SIO-1673)

Every investigation prompt is a full model turn on the account agent, and one noisy source can otherwise buy an unbounded number of them: eu-oit-prd produced 72 warn/logs findings on a single application log group in a day, each with a fresh error signature, and its agent reached 98% context. Two rails bound the cost per account regardless of what the checks find:

- **Budget.** At most `PI_MONITOR_INVESTIGATE_BUDGET_PER_DAY` prompts per rolling 24 h, and at most `PI_MONITOR_INVESTIGATE_PER_RESOURCE_PER_DAY` prompts naming the same resource. Every prompt is journaled as an `investigation` row with its outcome once the reply is in (`diagnosed`, `failed`, `timeout`, `refused`); failed and timed-out turns count, so a failing agent cannot keep the cap from filling, while refusals (the spoke answered `refused: ...` without a turn) do not, so a muted spoke cannot burn the budget on instant refusals. A malformed budget value keeps the default. Findings over a cap still ship in the report with their own reason (`uninvestigated: resource over daily investigation cap (3/3 in 24h)`); when the whole batch is over budget no prompt is sent.
- **Reuse (SIO-1739).** A dedup_key the agent diagnosed within the last `PI_MONITOR_INVESTIGATE_COOLDOWN_MINUTES` (6 h) is the same incident still flapping: it is not sent again, and the report carries that diagnosis with `(diagnosis reused from <ts>; diagnosed N min ago, within cooldown)`. A finding the budget holds back likewise reuses a diagnosis up to 24 h old instead of shipping `uninvestigated`. A reused row is journaled with `reused_from` and never feeds a later reuse, so a flapping alarm is re-investigated once the cooldown has passed, not never. Before this, one flapping low-CPU alarm spent three turns in a day and then shipped uninvestigated with its diagnosis already in the journal.
- **Controls.** `investigate off [reason]` keeps detecting and reporting but never calls the agent (reports carry `uninvestigated: investigation disabled by operator: <reason>`); `pause [reason]` skips the scheduled check cycles entirely while the daily digest still ships with a `PAUSED` header, so the dead-man signal survives; an explicit `run-checks` runs even while paused. Both persist in the state db (`snapshots.controls`) across restarts. `PI_MONITOR_INVESTIGATE` is only the default for a state db that has never seen a control; once `investigate on|off` has been sent, the persisted value wins.
- **Diagnosis contract (SIO-1741).** Every diagnosis must carry `evidence: [{command, observation}]` (at least one command the spoke actually ran and the line of output that decided the cause) and a `confidence` of 0 to 1; the incident report renders the first citation as `cited: <command> => <observation> (confidence N)`. A reply without evidence fails validation and the finding ships `uninvestigated: agent reply did not match the diagnosis schema`, which is the honest state. The prompt also tells the spoke to diagnose from the numbers the finding evidence carries and never to state a baseline the prompt did not give without citing the command behind it: a spoke once answered with hourly figures CloudWatch contradicted.

### Reports

Both report kinds go to `PI_MONITOR_REPORT_TO` (code default `laptop`; the bootstrap sets `ops` on deployed hosts) with a long TTL, so they wait in the hub mailbox when the operator is offline:

1. **Incident report** whenever a run has findings: severity-first summary, per-finding diagnosis and evidence. Recoveries ship as info.
2. **Daily digest** even when quiet: 24 h finding counts, each warn/critical finding of the window named on its own line (capped at 10, `[uninvestigated]`-tagged where the diagnosis failed, with an uninvestigated total -- counts alone hide what needs follow-up), check errors broken down by check family, current ALARM states, spend vs baseline, suppressed-finding count, and the deployed bundle version (the deploy canary: a stale bundle is visible without an SSM round-trip). When any check family errored in the window the header flags `DEGRADED` at `[warn]` -- a green digest produced over broken checks would be a lie. A missing digest is itself the monitor's dead-man signal.

If the hub is unreachable at report time, the report is queued in `state.db` and retried on the next tick -- the mailbox covers the offline-recipient half, this covers the offline-hub half.

### Commands

Any peer can prompt the monitor by name; it answers without a model:

| Command | Reply |
|---------|-------|
| `run-checks` | Runs the 15-minute check families now (guarded against overlapping with the cron run) |
| `status` | Liveness, last run, 24 h finding/suppressed/check-error counts, unsent report count |
| `digest` | The current digest, on demand |
| `review` | The suppression review, on demand |
| `history [count] [info\|warn\|critical] [family]` | Journaled findings of the last 7 days, newest `count` (default 20, max 200), optionally at or above a severity and within one family, e.g. `history 50 warn drift`; the reply says how many matches it left out |
| `suppressions` | The suppression ledger |
| `suppress <pattern> \| <reason>` | Add a ledger entry (`LIKE` pattern against dedup keys, reason required) |
| `unsuppress <pattern>` | Remove a ledger entry |
| `investigate on\|off [reason]` | Stop or resume sending findings to the account agent; persisted |
| `pause [reason]` | Skip the scheduled check cycles; the digest still ships flagged PAUSED; persisted |
| `resume` | Clear a pause |

```
ask monitor-eu-oit-dev to run-checks
```

### Configuration

Env-with-defaults; no config files. Set in the systemd unit environment or `~/.coms-env`.

| Variable | Default | Controls |
|----------|---------|----------|
| `PI_MONITOR_NAME` | `monitor-aws-<account_id>` | Peer name |
| `PI_MONITOR_REPORT_TO` | `laptop` (bootstrap sets `ops`) | Report recipient (a peer name) |
| `PI_MONITOR_REPORT_TTL_MS` | `1209600000` (14 d) | Mailbox TTL on reports |
| `PI_MONITOR_CHECK_CRON` | `*/15 * * * *` | Alarm/log/drift cadence |
| `PI_MONITOR_HOURLY_CRON` | `7 * * * *` | Ingestion heartbeat (minute 7: never a */15 boundary) |
| `PI_MONITOR_DAILY_CRON` | `@daily` | Cost/trail/certs/listener-certs/watchlist + digest (midnight in `PI_MONITOR_TZ`, else host zone = UTC on deployed spokes) |
| `PI_MONITOR_CERT_REGIONS` | host region + `us-east-1` | Comma-separated ACM regions the cert check scans |
| `PI_MONITOR_REVIEW_CRON` | `@weekly` | Suppression review mail (monthly: `0 0 1 * *` + window 31) |
| `PI_MONITOR_REVIEW_WINDOW_DAYS` | `7` | Match window the review counts over |
| `PI_MONITOR_TZ` | unset (host zone) | IANA zone all four schedules are read in. Spokes set no `TZ`, so unset means UTC; set it to keep a wall-clock time across DST. An unknown zone throws at startup. Set fleet-wide via `defaults.monitor_tz` in `fleet.yaml` (the bootstrap writes it into `.coms-env`), not by hand on the host -- `~/.coms-env.local` does not survive an instance replacement |
| `PI_MONITOR_INVESTIGATE_TARGET` | `aws-<account_id>` | Peer that investigates findings |
| `PI_MONITOR_INVESTIGATE_TIMEOUT_MS` | `300000` (5 min) | Investigation deadline base |
| `PI_MONITOR_INVESTIGATE_PER_FINDING_MS` | `60000` (1 min) | Added to the deadline per finding in the batch |
| `PI_MONITOR_INVESTIGATE_MAX_MS` | `1800000` (30 min) | Deadline cap regardless of batch size |
| `PI_MONITOR_INVESTIGATE` | on (`false`/`0` off) | Boot default for the persisted `investigate` control |
| `PI_MONITOR_INVESTIGATE_BUDGET_PER_DAY` | `24` | Investigation prompts per rolling 24 h |
| `PI_MONITOR_INVESTIGATE_COOLDOWN_MINUTES` | `360` | A dedup_key diagnosed this recently reuses that diagnosis instead of a new prompt (SIO-1739); `0` turns the hold-back off, reuse then only fills in for budget-skipped findings |
| `PI_MONITOR_INVESTIGATE_PER_RESOURCE_PER_DAY` | `3` | Prompts naming the same resource per rolling 24 h |
| `PI_MONITOR_LOGS_FILTER` | `?ERROR ?Exception` | CloudWatch filter pattern (WARN deliberately absent) |
| `PI_MONITOR_LOGS_MAX_GROUPS` | `200` | Log-group scan cap (paginated, alphabetical) |
| `PI_MONITOR_LOGS_EXCLUDE` | `/aws/events/` (check default) | Comma-separated log-group name prefixes to skip; setting it replaces the default |
| `PI_MONITOR_JOURNAL_RETAIN_DAYS` | `90` | Journal history retention, pruned at the daily tick |
| `PI_MONITOR_INGEST_MIN_EVENTS` | `10` | Same-hour median floor below which a group never alerts on silence |
| `PI_MONITOR_INGEST_ZERO_HOURS` | `3` | Consecutive zero-event hours required before silence warns; 1 restores the old single-hour behaviour (SIO-1711) |
| `PI_MONITOR_WATCHLIST` | see `checks/watchlist.ts` | Comma-separated CloudTrail event names; setting it replaces the default |
| `PI_MONITOR_CERT_WARN_DAYS` / `PI_MONITOR_CERT_CRIT_DAYS` | `30` / `7` | Certificate expiry thresholds |
| `PI_MONITOR_COST_PCT` / `PI_MONITOR_COST_ABS` | `0` / `100` | Cost anomaly threshold: yesterday must exceed the 14-day baseline by BOTH values; the fleet default is an absolute $100 gate with the percentage filter off (SIO-1680) |
| `PI_MONITOR_SHADOW_FAMILIES` | `targets,tasks,scaling,db-events,stacks,nodegroups,quotas` | Comma-separated families detected and journalled as `shadow_finding` but never reported or investigated (SIO-1748). Setting it REPLACES the default; empty graduates all. Read them with `history ... shadow` |
| `PI_MONITOR_STATE_DB` | `~/.pi/monitor/state.db` | State location |

Hub-side: `PI_COMS_NET_MAX_TTL_MS` (default `1209600000`, 14 days) caps any requested `ttl_ms`.

### IAM

Everything fits the existing role except two named additions in `deploy/modules/agent/main.tf`: `ce:GetCostAndUsage` (inline `cost-explorer-read`; Cost Explorer is always called against `us-east-1`) and `acm:ListCertificates`/`acm:DescribeCertificate` plus `elasticloadbalancing:DescribeLoadBalancers`/`DescribeListeners`/`DescribeListenerCertificates` (`CertificateReads` in the dev-extensions policy) for the cert and listener-cert checks. `sts:GetCallerIdentity` needs no grant; `cloudwatch:GetMetricData`, `cloudtrail:GetTrailStatus`, and `cloudtrail:LookupEvents` are already on the DevOpsAgentReadOnly policies.

### Families considered and not built (SIO-1749)

Three of the five families originally scoped were cut on production evidence,
before any code was written. Recording why, so they are not re-proposed:

- **`securityhub`** -- one account holds **58 standing ACTIVE+NEW findings at
  CRITICAL or HIGH**, and Security Hub re-stamps `UpdatedAt` as its controls
  re-evaluate, so a watermark would re-report all 58 every cycle. The content is
  AWS Foundational Security Best Practices controls ("GuardDuty should be
  enabled", "RDS automatic minor version upgrades should be enabled"), which is
  the same class the `compliance` family already covers by snapshot diff. It
  would have been alert fatigue for no new information.
- **`executions`** -- Step Functions `ListStateMachines` returns **zero in four
  production accounts**. Nothing to detect, and nothing to verify a
  response shape against.
- **`quotas`** -- the Service Quotas API is not reachable through the tooling
  available, so the shapes could not be verified. The need is met instead by
  Trusted Advisor's `service_limits` category (SIO-1750), which answers all 52
  limit checks in a single call with AWS's own ok/warning/error verdict.

The SIO-1748 and SIO-1749 checks add **no IAM at all**. `elasticloadbalancing:DescribeTargetGroups`/`DescribeTargetHealth`, the `ecs:List*`/`Describe*` set, `sqs:ListQueues`/`GetQueueAttributes` and `autoscaling:DescribeScalingActivities` were already granted and simply had no detector reading them.

---

## Testing

`bun test` runs the repository's test suite (`tests/`): unit tests for every check family, monitor state, report formatting, and the run cycle (investigation fallback, unsent retry, overlap guard); integration tests that spawn the real hub as a subprocess with `HOME` in a temp dir to cover mailbox queueing, oldest-first flush, restart recovery, and the headless coms client end to end.

The manual end-to-end drill after a monitor change: force one finding per family on a live account (a test alarm transition, a log line matching the error filter, a tag change on a watched resource), send `run-checks` to that account's monitor, and verify the report lands in the `ops` inbox and the next digest counts it.

## See Also

- [Communication](communication.md) -- the message lifecycle the mailbox extends
- [Networking](networking.md) -- endpoints and SSE events
- [Security Model](../security/security-model.md) -- what durable messages change
- [Deployment](../deployment/deployment.md) -- installing `pi-monitor.service`

### IAM added by SIO-1750

One statement, `WorkloadStateReads`, in the inline `pi-coms-extensions` policy
(`deploy/modules/agent/main.tf`) -- the one policy pi-coms manages in both
create and adopt mode. `SecretAndDataPlaneDeny` is untouched and everything
added is read-only metadata.

| Action | Unlocks |
|--------|---------|
| `eks:ListNodegroups`, `eks:DescribeNodegroup` | the `nodegroups` check |
| `ec2:DescribeVolumeStatus` | impaired and retiring volumes, folded into the `drift` family |
| `support:DescribeTrustedAdvisorChecks`, `support:DescribeTrustedAdvisorCheckSummaries` | the `quotas` check |

Five actions, every one of which a detector actually calls. `eks:ListFargateProfiles`
and `ec2:DescribeVolumes` were in the first draft and removed: no check invokes
either, and the test that excluded whole services applies equally to actions
inside a statement. Note `DescribeVolumeStatus` has no `IncludeAllVolumes`
parameter -- its accepted inputs are `MaxResults`, `NextToken`, `VolumeIds`,
`IncludeManagedResources`, `DryRun` and `Filters` -- and its default response
already carries healthy volumes, which is what makes the pending-action signal
reachable at all.

Each was verified to return usable output in a real account before being
requested. Two items from the estate-watch wishlist were deliberately NOT
taken: `backup:ListBackupJobs` (zero backup jobs across three production
accounts) and `synthetics:DescribeCanaries` (zero canaries). Asking for
permissions nothing uses widens the role for no signal.

Adding statements here does not touch userdata, so it does not trigger
`user_data_replace_on_change` and does not replace instances.
