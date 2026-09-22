[← Back to index](README.md)

# 5. Monitoring

*(LZ KB: CloudWatch OAM cross-account observability · Billing data (CUR) · Alerting)*

```
Category: Monitoring
Status:   TO BE REVIEWED (LZ KB) / 1 of 5 ADRs Accepted, live 2026-07-31
Owner:    CCoE Platform Team
```

## Objective

Every account is observable from day one — metrics, logs, and cost data flow to the central Monitoring account before the account serves traffic.

## Key Results

- [ ] **KR1 —** 100% of new accounts complete an OAM **link** into the `monitoring-prd` **sink** during Phase 2 bootstrap — 0 accounts serving production traffic without an active OAM link.
- [ ] **KR2 —** The OAM sink stays "Active" in all four regions (`eu-central-1`/`ae1`, `eu-west-1`/`ae2`, `us-east-1`/`an1`, `ap-southeast-1`/`aa6`) with `CloudWatch::Metric` and `Logs::LogGroup` as shared resource types.
- [ ] **KR3 —** CUR billing data replicates from the master account to `monitoring-prd` for 100% of billing periods, keeping Elastic Fleet cost analysis current.
- [ ] **KR4 —** Budget alerts and vending-pipeline-failure alerts reach `Owner` (from the mandatory tag set) with 0 missed notifications.

## Governing ADRs (`cap-observability`, live 2026-07-31 — 5 ADRs)

| ADR | Title | Status |
|---|---|---|
| [0031](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1546584065) | CloudWatch Log Retention Automation | Review *(also FinOps)* |
| [0039](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1789919270) | Monitoring Account | **Accepted** |
| [0040](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1789919285) | AWS – Elastic Integration | Proposal |
| [0041](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1789919300) | Elastic Agents (APM, OTEL Collectors, Syslogs), Synthetics Private Locations and Logstash | Proposal |
| [0094](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2607153673) | LogicMonitor | Proposal |

Read: only the foundational decision — that a dedicated Monitoring account exists and receives cross-account data (ADR-0039) — is Accepted. Every ADR about *what actually ships the telemetry* (the Elastic integration, its agents/collectors, log retention automation, and a second tool — LogicMonitor — that isn't mentioned anywhere else in this bundle) is still Proposal or Review. Worth noting: LogicMonitor's presence here alongside the Elastic stack (ADR-0040/0041) isn't explained by any other source — confirm with the platform team whether these are complementary or one supersedes the other before assuming both are live.

## Real-World Examples (from `aws-lz-account-creator`, live repo, 2026-07-31)

`modules/account-bootstrap/oam.tf` is the actual Terraform behind KR1/KR2, and it matches the documented behavior closely:

```hcl
resource "aws_oam_link" "regional" {
  for_each = var.account_name != "monitoring-prd" ? {
    for region, arn in local.oam_sink_arns : region => arn
    if arn != "" && contains(var.region, region)
  } : {}

  provider = aws.new_account
  region   = each.key

  resource_types = [
    "AWS::CloudWatch::Metric",
    "AWS::Logs::LogGroup"
  ]
  sink_identifier = each.value
}
```

This confirms KR1/KR2 exactly: every new account (except `monitoring-prd` itself) links into the sink for each region it's deployed to, sharing precisely `CloudWatch::Metric` and `Logs::LogGroup` — no more, no less (X-Ray, Application Insights, and Internet Monitor resource types are present in the file as commented-out options, i.e. deliberately not yet shared). The `for_each` is keyed by the account's own declared regions (`var.region`, sourced from the account YAML), not a hardcoded four-region list — so KR2's "all four regions" framing is really "whichever regions this account YAML declares," worth keeping in mind when writing the KR as a literal test.

## Open gap — worth reconciling

The OAM region-code scheme (`ae1`, `ae2`, `an1`, `aa6`) is a *second* region-abbreviation namespace that doesn't match [Strategy](01-strategy.md)/`AGENT_PROMPT §1`'s `euc1`/`use1`/`ew1`/`apse1`. Neither `AGENT_PROMPT.md` nor the Guide reviews mention an OAM-specific code scheme exists at all. If an agent generates monitoring/OAM-adjacent Terraform and reads "ae1" from a data source or existing resource, it should not assume that's a typo of `euc1` — they appear to be two deliberately separate systems (naming-module region abbreviation vs. OAM's own internal sink codes). Flag, don't "fix," until the platform team confirms. Full detail in the [findings note](findings/lzkb-fourth-source-cross-validation.md#new-observation).

## Repository refresh (2026-09-21)

`aws-lz-monitoring` now supports the organizational data feeds needed by the expanded CID implementation: Compute Optimizer, cost anomaly, Marketplace, and Identity Center principal lookup. This makes monitoring part of the FinOps data plane, not only the OAM sink. The paired changes in `aws-lz-finops` consume and present that data; see the [repository refresh](findings/repository-refresh-2026-09-21.md#monitoring-and-finops).

---
[← Back to index](README.md) · [← Security](04-security.md) · [Next: FinOps →](06-finops.md)
