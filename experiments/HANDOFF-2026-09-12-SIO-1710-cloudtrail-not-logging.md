# HANDOFF: SIO-1710 - two CloudTrail trails NOT logging in eu-mendix-platform-prd

- **Date**: 2026-09-12
- **Ticket**: [SIO-1710](https://linear.app/siobytes/issue/SIO-1710) - eu-mendix-platform-prd: two CloudTrail trails are NOT logging, uninvestigated
- **Related (filed same session, separate work)**: [SIO-1711](https://linear.app/siobytes/issue/SIO-1711) - monitor ingestion check false positives
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **Repo state**: `main` @ `324f3ec98953914a992341c16167bac54579ce2a` (clean)
- **Suggested branch**: n/a initially - this is an **investigation**, and may end with no code change in this repo

## TL;DR

The monitor's daily digest for AWS account **654654584630** (`eu-mendix-platform-prd`) reports two `critical` findings, both marked `[uninvestigated]`:

```
* (critical/trail) aws-controltower-BaselineCloudTrail:
    CloudTrail aws-controltower-BaselineCloudTrail is NOT logging [uninvestigated]
* (critical/trail) infra-log-prd-ae1-cloudtrail-org-trail:
    CloudTrail infra-log-prd-ae1-cloudtrail-org-trail is NOT logging [uninvestigated]
```

Two trails not logging in a production account is an audit and forensics gap. Success is knowing **why** they stopped and either restoring logging or recording a deliberate decision that they should stay off.

**Read this first**: nothing has been diagnosed. This handover records a reported state, not a root cause. Do not open with `StartLogging`.

## Context - how this ticket came to be

Surfaced while reading the live ops inbox in the fleet pane at the end of an unrelated UI session. The monitor had been reporting it; nobody had read it. The `[uninvestigated]` marker means the account's Pi agent did not spend an investigation turn on it - the monitor's per-day investigation budget went to other findings (including the false positives in SIO-1711, which is part of why that ticket matters).

## The full digest entry (2026-09-12, verbatim)

```
[info] aws-654654584630 daily digest (since 2026-09-11T00:00:07.906Z)
   * findings: 4 (ingestion=2 trail=2)
   * notable warn+ findings (last 24h):
      * (critical/trail) aws-controltower-BaselineCloudTrail: CloudTrail aws-controltower-BaselineCloudTrail is NOT logging [uninvestigated]
      * (critical/trail) infra-log-prd-ae1-cloudtrail-org-trail: CloudTrail infra-log-prd-ae1-cloudtrail-org-trail is NOT logging [uninvestigated]
      * (warn/ingestion) 3 - /aws/lambda/aws-controltower-NotificationForwarder: ...
   * uninvestigated: 2
   * check errors: 0
   * alarms: none in ALARM
   * spend yesterday: $0.18 vs 14d baseline $1.10
   * bundle: 75491f0b
```

**`check errors: 0`** matters: the monitor is not failing to read: it read successfully and found `IsLogging=false`. This is a real reported state, not a permissions artefact.

**Spend $0.18 vs $1.10 baseline** may or may not be related. A trail that stopped delivering writes fewer S3 objects, which would reduce cost. Equally it could be unrelated idle. **Check it, do not assume it** - if the spend drop coincides with the logging stop, that dates the onset.

## What is NOT known

Nobody has yet confirmed:

- whether the trails are **stopped** (`StopLogging` called), **mis-configured**, or **failing delivery** to their S3 destination
- **when** they stopped - the digest reports current state, not onset
- whether this is **one root cause affecting both**, or two independent faults
- whether an org SCP, an S3 bucket policy, or a KMS key change is implicated

The two trails are different kinds of thing, which argues against assuming a single cause:

- `aws-controltower-BaselineCloudTrail` is **managed by AWS Control Tower**. It is created and maintained by the landing zone, so remediation may belong in the Control Tower management account rather than in this account - and changing it directly can be reverted by Control Tower drift remediation.
- `infra-log-prd-ae1-cloudtrail-org-trail` is named like an **organization trail** owned by a central logging account (`infra-log-prd`). An org trail's `IsLogging` is controlled from the management account; a member account may be able to read it but not fix it.

## Investigation steps

The account's own spoke holds `DevOpsAgentReadOnly` in 654654584630 and can read all of this. Ask it directly through the fleet pane (select `eu-mendix-platform-prd`), or via the hub CLI.

### Step 1 - the actual status and the delivery error

```bash
aws cloudtrail get-trail-status --name aws-controltower-BaselineCloudTrail
aws cloudtrail get-trail-status --name infra-log-prd-ae1-cloudtrail-org-trail
```

`get-trail-status` is the key call. Read:

- `IsLogging` - confirms the monitor's finding
- `LatestDeliveryError` / `LatestDeliveryAttemptTime` - usually names the real cause outright (`AccessDenied`, `KMS.KeyUnavailableException`, bucket missing)
- `StopLoggingTime` - **if present, dates the onset and tells you it was stopped deliberately rather than failing**
- `LatestNotificationError`

### Step 2 - the configuration

```bash
aws cloudtrail get-trail --name <each>
```

Read `S3BucketName`, `KmsKeyId`, `IsOrganizationTrail`, `HomeRegion`. If `IsOrganizationTrail` is true, this account is likely not where the fix lives.

### Step 3 - who stopped it, if it was stopped

If `StopLoggingTime` is set, look for the API call. **Note the irony**: CloudTrail records `StopLogging`, but if the trail that would record it is the one that stopped, the evidence may only exist in the *other* trail or in the org trail's central bucket.

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=StopLogging --max-results 20
```

### Step 4 - correlate with the spend drop

Compare the Cost Explorer daily series for S3 in this account against `StopLoggingTime` or `LatestDeliveryAttemptTime`. A matching inflection confirms the onset date.

## Verification

There is no test suite for this - it is a live AWS state question. The evidence is:

1. `get-trail-status` showing `IsLogging: true` for both trails, **and**
2. `LatestDeliveryTime` advancing on a subsequent call (proving delivery works, not just that logging is enabled), **and**
3. the next daily digest for 654654584630 carrying no `trail` findings

Point 2 matters: a trail can report `IsLogging: true` and still fail every delivery. Enabling logging without fixing a bucket policy produces exactly that, and the monitor would go quiet while the audit gap persists.

Read the digest through the fleet pane (`Inbox ops`, scoped to `eu-mendix-platform-prd`), or:

```bash
curl -s "localhost:5173/api/pi/mailbox?hubKey=eu-shared-services-prd&estates=eu-mendix-platform-prd" | jq -r '.messages[].prompt'
```

## Possible outcomes - all legitimate

1. **Delivery failure** (bucket policy, KMS, bucket deleted) - fix the destination; the trail resumes.
2. **Deliberately stopped** - find out by whom and why. If intentional, the right action may be a monitor suppression plus a recorded decision, not a restart.
3. **Control Tower drift** - remediate through Control Tower in the management account, not by touching the trail here.
4. **Redundant trail** - if `infra-log-prd-ae1-cloudtrail-org-trail` supersedes the baseline trail, one being off may be by design. Confirm before "fixing" it.

**Do not close this by calling `StartLogging` and watching the finding disappear.** A trail that stopped because its destination denies writes will silently stop again, and the monitor will report it again in 24 hours.

## Access notes

- Hub account: `399987695868` (`eu-shared-services-prd`), profile `eu-shared-services-prd`, region `eu-central-1`
- Target account: `654654584630` (`eu-mendix-platform-prd`), reachable through its spoke
- The spoke is **read-only** (`DevOpsAgentReadOnly`). It can diagnose but cannot remediate - any fix needs a human with write access, or a change in the Control Tower / logging account
- Tunnel for the hub CLI: `just hub-tunnel eu-shared-services-prd`, then `just coms eu-shared-services-prd <name>`

## Out of scope

- **SIO-1711** (ingestion false positives) - same digest, unrelated cause, its own handover. Worth noting the connection though: the false positives consume the investigation budget that would otherwise have looked at these criticals.
- Changing the monitor's trail check (`packages/pi-coms/scripts/monitor/checks/`) - it reported correctly.
- The fleet pane UI work from this session, which is complete and merged.

## Related code references

- `packages/pi-coms/scripts/monitor/checks/` - the trail check family that produced the finding
- `packages/pi-coms/scripts/monitor/report.ts:287-300` - why `[uninvestigated]` findings lead the digest's notable list (SIO-1623: an uninvestigated warn has nobody looking at it)
- `packages/pi-coms/docs/architecture/monitoring.md` - the monitor's investigation budget and reporting model

## Memory references

- `reference_eu_shared_services_prd_account_mapping` - account id to name mapping
- `reference_devopsagentreadonly_two_policies` - what the spoke's role can and cannot do
- `reference_aws_iam_gotchas`
- `feedback_no_cross_environment_access`
- `reference_fleet_bundle_install_path_and_verify` - only if a monitor change turns out to be needed
