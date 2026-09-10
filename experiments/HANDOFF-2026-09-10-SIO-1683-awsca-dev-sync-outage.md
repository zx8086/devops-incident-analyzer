# HANDOFF 2026-09-10: SIO-1683 awsca.dev data sync outage (plus SIO-1684)

- Date: 2026-09-10
- Ticket: https://linear.app/siobytes/issue/SIO-1683 (Done, auto-transitioned by the PR merge)
- Related: https://linear.app/siobytes/issue/SIO-1684 (Done, mapping follow-up), https://linear.app/siobytes/issue/SIO-1559 (the credentials secret design that was never applied in dev)
- Project: Linear "AWS Cost Analyser"; code repo `~/WebstormProjects/aws-cost-analyzer` (master `e1e91d1`); this doc lives in devops-incident-analyzer because the session ran here
- PRs merged: https://github.com/zx8086/aws-cost-analyzer/pull/183, https://github.com/zx8086/aws-cost-analyzer/pull/184
- Deployment: ECS `aws-cost-analyzer-service`, cluster `shared-services-dev`, account 352896877281 (eu-shared-services-dev), eu-central-1, task definition rev 12
- Suggested branch for any follow-up code: `sio-16xx-<topic>` off `origin/master` in aws-cost-analyzer

## TL;DR

The Settings page at https://awsca.dev.shared-services.eu.pvh.cloud showed "Last synced 04/09", "Sync is unavailable: App Services rejected the sync user" and "integrity report 500". Five independent causes were found and fixed the same day; the daily sync now runs in the cluster (first success 13:41 UTC, 175 s, 17/17 accounts ok) and the app is back on local-first. What remains open: the Capella free cluster sits ~1 point under the 80 percent disk guardrail, and tomorrow's 06:30 UTC run is the first unattended one (a scheduled desktop check exists for it).

## What was done / what is next / gotchas

**Done**
1. Capella App Service `cost-analyzer-sync` allowlist: added the dev NAT `3.126.16.17/32` (it held only Simon's IP). Blocked IPs time out on `:4985`, they do not get a 403.
2. Task definition rev 7..12 (hand-registered with jq from the live rev; no Terraform owns it): `SYNC_DAILY_AT=06:30` (UTC, was `off` since 27 Aug), EFS access point `fsap-017c6ec7a4a4c7fbf` mounted at `/app/packages/backend/data`, image pinned per revision, and the SIO-1559 secret `AWS_CREDENTIALS_JSON` (SSM `/pvh/dev/shared_services/aws-cost-analyzer/AWS_CREDENTIALS_JSON`, SecureString, **Advanced tier**, 17 accounts) which had never been created.
3. PR #183: `saveIntegritySnapshotToCouchbase` is best-effort and no longer runs `createCollection` per GET; a rejected write logs a warning instead of a 500.
4. PR #184: 35 CUR-to-CE identity pins plus a shape rule for marketplace product ids; parity 2026-08 17/17 match at $0.00.
5. Dropped 11 never-scanned GSI indexes to get the cluster from 80.9 to 77.9 percent disk; writes resumed.

**Next**
- 2026-09-11 08:50 Amsterdam: scheduled desktop task `awsca-dev-daily-sync-check-2026-09-11` reads the run's logs, the three status endpoints and the Capella disk, and comments on SIO-1683. It needs the app open and a live SSO session for `eu-shared-services-dev`.
- Decide the Capella disk: free `singleNode` cluster, disk not resizable (API 422 code 4052, UI blocked). Options: Capella support to clean the ~6.7 GiB of OS/install/logs; recreate the free cluster and rebuild with `sync:historical 24`; paid plan.
- Confirm in the browser that App Services imported the 2026-09-10 documents (Dashboard September should show 9+ days). The admin API answers 403 to the `.env` copy of the admin credentials, so this could not be verified from the laptop.

**Gotchas hit**
- Only error-level logs ship to CloudWatch/Elastic in production; the sync orchestrator's info lines are the exception. Silence is not proof a boot step did not run.
- The daily orchestrator has no HTTP trigger (`RUNNABLE_SYNCS` excludes `daily`) and the distroless image has no shell, so forcing a run means rolling a revision with `SYNC_DAILY_AT` a few minutes ahead, then rolling back. Each rollout takes ~6 min (`maximumPercent=100` waits for the ALB deregistration delay).
- A full sync pushes the node from ~78 to ~81 percent during the run; auto-compaction brings it back ~10 min later. Writes are rejected in between.
- The Couchbase 8.0 guardrail surfaces as App Services HTTP 500 "Disk space ... above the configured threshold" and as a bare SDK `Error: protocol_error (1004)` on writes while reads stay healthy.

## Where the bodies are buried

- Scheduler: `packages/backend/src/services/sync-scheduler.ts` (UTC, `off` disables, only trigger). Dev scales to 0 at 17:00 and up at 08:00 Europe/Amsterdam, weekdays (Application Auto Scaling scheduled actions `aws-cost-analyzer-service-scheduled-scale-down/up`).
- Broker: `packages/backend/src/routes/auth.routes.ts:85-97` -> `services/app-services-admin.ts:29-50` (`PUT https://<host>:4985/<endpoint>/_user/<u>`, 10 s timeout, status 0 = network). UI string in `packages/frontend/src/lib/services/sync-credential-client.ts:93`.
- Local-first gate: `packages/frontend/src/lib/db.ts` `isLocalFirstEnabled()` needs secure context + `SYNC_URL` + brokered credentials; otherwise HTTP mode (1-2 s per API call, 28 org-node calls per dashboard).
- Credentials materialisation: `packages/backend/src/config/materialize-credentials.ts` writes `aws-credentials.json` from `AWS_CREDENTIALS_JSON` at boot.
- CUR map: `packages/backend/src/config/cur-service-map.ts`; discovery `bun run cur:discover-services <YYYY-MM>` writes `data-cur/.discovery/<period>-service-names.json`; parity `bun run validate:cur-parity -- --month 2026-08 --data-dir <ce dir> --cur-dir <shadow>`.
- Consolidation of a finished month runs only when `sync:daily` executes on the 1st (`sync-daily-orchestrator.ts:332-340`); August 2026 is still daily-granular because no run happened on 1 Sept. `bun run consolidate:previous-month` fixes it by hand.

## Verification

```bash
cd ~/WebstormProjects/aws-cost-analyzer/packages/backend && bun run typecheck && bun run lint && bun test
```

```bash
curl -sS https://awsca.dev.shared-services.eu.pvh.cloud/api/integrity/sync/status; curl -sS https://awsca.dev.shared-services.eu.pvh.cloud/api/sync/status; curl -sS https://awsca.dev.shared-services.eu.pvh.cloud/api/integrity/report | jq '{source, overall:.data.overall, complete:.data.summary.accountsComplete}'
```

```bash
AWS_PROFILE=eu-shared-services-dev aws logs filter-log-events --region eu-central-1 --log-group-name /ecs/fargate/shared-services-dev-log-group --log-stream-name-prefix aws-cost-analyzer-service/ --filter-pattern '"Orchestrator summary"' --start-time $(( ($(date +%s) - 86400) * 1000 )) --query 'events[].message' --output text | cut -c1-400
```

Expected after 06:30 UTC: `daily` job `succeeded`, `lastSyncedAt` today, integrity `ok` 17/17, no `CUR services without an explicit CE mapping` warning, disk under 80 percent.

## Out of scope

- Capella cluster resize/recreate (decision for Simon).
- August 2026 consolidation to monthly granularity.
- Terraform for the ECS task definition (none exists; revisions are registered by hand).

## Memory references

`reference_awsca_dev_deployment_facts`, `reference_capella_singlenode_disk_guardrail_protocol_error`, `feedback_awsca_local_first_is_mandatory`, `feedback_no_cross_environment_access`.
