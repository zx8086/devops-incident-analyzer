[← Back to index](README.md)

# 2. Account Factory

*(LZ KB: Organization & OUs · Vending decision · Pipeline flow · Account YAML · Phase 1/2 · Orchestrator · Baseline module · Region strategy · IAM Identity Center · Cross-account roles · Repository map)*

```
Category: Account Factory
Status:   TO BE REVIEWED
Owner:    CCoE Platform Team
```

## Objective

New AWS accounts are requested, vended, baselined, and decommissioned with zero manual click-ops in the Management account.

## Key Results

- [ ] **KR1 —** 100% of new accounts are declared as YAML (`accounts/*.yml`) and expand per-environment automatically (e.g. `edp-dev`, `edp-qa`, `edp-prd`, `edp-dr`) — no hand-authored `.tf` for account creation. *(AGENT_PROMPT §14, confirmed against real `aws-lz-account-creator/accounts/` data in the Three-Way Validation doc)*
- [ ] **KR2 —** The 8-step vending journey (YAML PR → active account) completes without a manual Management-account step, end to end, including Phase 1 (Account Basic: Organizations, IAM, SSO, VPC cleanup) and Phase 2 (Bootstrap: config, KMS, budgets, PAM, backup, OAM).
- [ ] **KR3 —** Every vended account gets its baseline module automatically (no opt-out) and completes Post-Vending Route53 PHZ delegation without a support ticket.
- [ ] **KR4 —** The DynamoDB-state-store + Lambda orchestrator processes 100% of workload-VPC YAML → Cloud WAN attachment events without a manual network-team touch.

## Open gap

`AGENT_PROMPT.md` has no coverage of IAM Identity Center / SSO permission-set provisioning — it's purely a Terraform-authoring prompt, and SSO/account-lifecycle orchestration lives one layer up (the vending pipeline itself, not per-repo Terraform an agent would author). Not a defect, just a boundary worth stating explicitly so an agent doesn't try to "fix" SSO from inside a workload repo. Note the live registry shows this is **not an ungoverned gap** — ADR-0030 (below) covers exactly this and is Accepted; it just isn't referenced from `AGENT_PROMPT.md`, which is worth fixing since an agent following only the prompt wouldn't know the ADR exists.

## Governing ADRs (live 2026-07-31)

This category is inherently cross-cutting — no single `cap-*` label matches "Account Factory" the way the LZ KB names it. These are the ADRs that actually govern vending, baseline, and account-level access, pulled from `cap-strategy`, `cap-platform`, and `cap-security`:

| ADR | Title | Status | Capability |
|---|---|---|---|
| [0005](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1390903318) | Organizations & Accounts Structure | **Accepted** | Strategy |
| [0006](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1390903339) | Vending Machine Approach | **Accepted** | Strategy, Platform Engineering |
| [0016](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1411776514) | Account Vending - Automation | **Accepted** | Platform Engineering |
| [0030](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1467056130) | AWS SSO (IAM Identity Center) Configuration via Terraform | **Accepted** | Security, Platform Engineering |
| [0034](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1547862192) | Cross-Account Role Strategy | **Accepted** | Security, Platform Engineering |
| [0080](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1955921921) | Intake Process | Proposal *(stub)* | Strategy, Workload Enablement |
| [0081](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1953824821) | Account Request Form | Proposal | Strategy, Workload Enablement |
| [0088](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2241658902) | Self Service Orchestration | Review | Strategy, Platform Engineering |

Read: the mechanics that actually vend an account — org/account structure, the vending approach, the automation that runs it, SSO, and cross-account roles — are **all five Accepted**. What's still unratified is the *front door* (Intake Process and Account Request Form, both still stubs/proposal) and the newer self-service orchestration layer on top. That's a healthier picture than KR1–KR4 above imply on their own — worth reflecting the next time this file's KRs are revisited.

## Real-World Examples (from `aws-lz-account-creator`, live repo, 2026-07-31)

Pulled directly from the actual repo behind this category rather than assumed — confirms the shape KR1/KR2 describe, and surfaces detail AGENT_PROMPT doesn't mention.

**Account YAML — confirms KR1 exactly.** Every account is one file under `accounts/*.yml` (51 files in the 2026-09-21 snapshot: one per application, plus one per infra/shared account — `edp.yml`, `infra-network.yml`, `infra-security.yml`, `drfactory.yml`, and so on). A real workload example (`accounts/edp.yml`, `dev` environment):

```yaml
application_name: edp

common:
  cost_center: 1000-1002971173
  owner: eda_owner@pvh.com
  managed_by:  eda_owner@pvh.com        # a person's email, not "Terraform" — see the FinOps ManagedBy conflict
  approver: eda_approver@pvh.com
  blueprint_id: fde5ce32-9fe4-4e5a-aabc-e87e05881bb3
  business_unit: corp
  map-migrated: mig6ZHOPC45Z1            # undocumented tag — not in AGENT_PROMPT §8's 10-tag list, see FinOps

environments:
  dev:
    region: [eu-central-1]
    ou_id: ou-kapu-ske24tyb
    budget_limit: 1000
    data_classification: Highly Confidential   # matches the KB's enum, not AGENT_PROMPT's
    business_criticality: business_critical    # lowercase-snake — see the casing note below
    sso_config:
      additional_groups:
        "AAD-GG-EDP-Developer":
          description: "Common PVH ReadOnly access"
          permission_set_name: "Developer_DevAccess"
```

`accounts/infra-network.yml` (a shared-services account, same repo) uses `business_criticality: BusinessCritical` — PascalCase — for the equivalent field. Both casings are live, today, in the one system of record, not a drifted outlier vs. a clean standard. That's the real convention, inconsistently applied, exactly as the [FinOps conflict](06-finops.md#-conflict-1--dataclassification--businesscriticality-enums-dont-match) describes.

**SSO assignment — confirms KR2.** `modules/account-basic/sso.tf` does exactly what `sso_config.additional_groups` in the YAML implies: a `for_each` over group→permission-set pairs, looked up by name against **existing** permission sets (`data.aws_ssoadmin_permission_set.existing[...]`) — this repo doesn't create permission sets, only assigns them, confirming the KB's positioning of SSO permission-set management as a layer above this repo (see the Open Gap above). Real permission-set names in active use: `Developer_DevAccess`, `PVH_ReadOnly_Access`, `Developer_PrdAccess`, `AWSReadOnlyAccess`, `AWSPowerUserAccess`, `AdministratorAccess`, `ISG_SecurityAuditAccess`, `AWSOrganizationsFullAccess`, `PlatformReadOnlyAccess` — none are documented in AGENT_PROMPT; an agent generating a new account's `sso_config` should reuse one of these existing names rather than invent a new one.

**Account resource — confirms `prevent_destroy`.** `modules/account-basic/account.tf`'s `aws_organizations_account` carries `lifecycle { prevent_destroy = true }`, matching AGENT_PROMPT §13 exactly.

## Repository refresh (2026-09-21)

The current account-vending chain now includes material post-July changes across all three stages. `aws-lz-account-creator` has 51 account YAML files and added CID collection access, SSM patch roles, Image Builder distribution access, and Windows VSS backup behavior. `aws-lz-post-vending` added additional-VPC support and private hosted-zone association fixes. `aws-lz-vending-orchestrator` added the post-vending publish path. These remain separate ownership surfaces; a baseline change is not interchangeable with a post-vending or orchestration change. See the [repository refresh](findings/repository-refresh-2026-09-21.md#account-factory).

---
[← Back to index](README.md) · [← Strategy](01-strategy.md) · [Next: Network →](03-network.md)
