[← Back to index](README.md)

# 1. Strategy

*(LZ KB: Vision & principles · Account boundaries · OU structure · Region selection · Control Plane · ADR policy · Phasing & roadmap · Naming convention)*

```
Category: Strategy
Status:   TO BE REVIEWED (LZ KB) / 5 of 13 ADRs Accepted, live 2026-07-31
Owner:    CCoE Platform Team
```

## Objective

The Landing Zone's foundational decisions (accounts, regions, naming) are unambiguous, ratified, and identical everywhere they're cited.

## Key Results

- [ ] **KR1 —** Approved regions and abbreviations match everywhere they appear: `eu-central-1` (primary/`euc1`), `us-east-1` (`use1`), `eu-west-1` (`ew1`), `ap-southeast-1` (`apse1`), plus `gl` for global/non-regional. *(AGENT_PROMPT §1, §8)* — **watch:** [Monitoring](05-monitoring.md)'s OAM sink table uses a second, independent code set (`ae1`, `ae2`, `an1`, `aa6`) for the same four regions; see the [findings note](findings/lzkb-fourth-source-cross-validation.md).
- [ ] **KR2 —** 100% of `cap-strategy` ADRs reach "Accepted." Live count as of 2026-07-31: **5 of 13 Accepted** (see table below) — up from the June 15 baseline of 0/6, but that was a different, smaller, since-renumbered ADR set (see the [findings note](findings/lzkb-fourth-source-cross-validation.md#adr-registry-has-been-substantially-reworked-since-june-15) before comparing the two numbers directly). Track this ratio over time as the clearest signal of how "final" this whole bundle is.
- [ ] **KR3 —** Every LZ construct ships as reviewed IaC (principle: "Terraform-everywhere," no manual drift) — measurable as: 0 manually-created resources found by Config/drift detection in any Landing Zone account.
- [ ] **KR4 —** Naming convention `<application>-<env>-<region-abbrev>-<service-type>-<descriptor>` is produced exclusively via `aws_naming`/`aws_naming_global` — 0 string-literal `Name` tags in any reviewed repo. *(AGENT_PROMPT §8)*

## Standards feeding this objective

Toolchain versions (§1), the six guiding principles (multi-account by default; automate the lifecycle; Terraform-everywhere; centralize-shared/decentralize-owned; secure-by-default; observable-from-day-one; self-service-with-guardrails).

## Governing ADRs (`cap-strategy`, live 2026-07-31 — 13 ADRs)

Pulled directly from the Confluence ADR registry (`label = aws-lz2-adr AND label = cap-strategy`). Some ADRs carry a second capability tag where the decision genuinely crosses domains (shown in the Also-tagged column).

| ADR | Title | Status | Also tagged |
|---|---|---|---|
| [0001](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1442938882) | Cloud Region Selection | **Accepted** | — |
| [0004](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1390903297) | Naming Convention | **Accepted** | Platform Engineering |
| [0005](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1390903318) | Organizations & Accounts Structure | **Accepted** | — |
| [0006](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1390903339) | Vending Machine Approach | **Accepted** | Platform Engineering |
| [0011](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1395130369) | Cloud Operating Model | Review | — |
| [0038](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1584889857) | Deployment Strategy | **Accepted** | — |
| [0068](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2298445863) | Platform Operating Model | Proposal | Service Enablement & Management |
| [0074](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2805366799) | SOX Compliance | Proposal | *(Compliance overlay)* |
| [0075](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2806153220) | PCI-DSS Compliance | Proposal | Security |
| [0080](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1955921921) | Intake Process | Proposal *(stub)* | Workload Enablement |
| [0081](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1953824821) | Account Request Form | Proposal | Workload Enablement |
| [0082](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2113110039) | Documentation Approach | Review | — |
| [0088](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2241658902) | Self Service Orchestration | Review | Platform Engineering |

Read: the load-bearing decisions for this OKR — region selection, naming, org/account structure, and the vending approach itself — are all **Accepted**. What's still moving is the operating-model and governance layer above them (Cloud Operating Model, Platform Operating Model, Self Service Orchestration, Documentation Approach) plus two brand-new compliance-overlay ADRs (SOX, PCI-DSS) opened mid-July, still in Proposal.

## Real-World Examples (confirms KR4, across every repo checked)

KR4 requires the naming/tagging modules to be used exclusively, never a string-literal `Name` tag. Every real `.tf` file read across `aws-lz-account-creator`, `aws-lz-networking`, and `aws-lz-finops` for this bundle follows that pattern consistently — `module.aws_naming[each.value].backup.name_prefix`, `module.aws_naming_global.iam_role_global.name_prefix`, and `module.aws_tagging.resource_tags` (merged with `var.additional_tags`) appear in effectively every resource block, in every repo, with 0 counter-examples found. This is one of the few KRs in this whole bundle with clean, consistent, real-world evidence behind it — worth calling out as a model for what "ratified and actually followed" looks like, in contrast to the state-backend situation in [Toolbox](07-toolbox.md).

## Repository refresh (2026-09-21)

The operative estate is now documented as 23 projects: 20 `aws-lz-*` projects and three GitLab/platform projects. The group hierarchy is flattened only in the local checkout; GitLab subgroup paths remain part of each remote URL. One project, `aws-lz-shared-tools`, is an empty remote and cannot yet supply implementation evidence. Exact HEADs and the scope boundary are recorded in the [repository refresh](findings/repository-refresh-2026-09-21.md).

---
[← Back to index](README.md) · [← Governance](00-governance-agent-behavior.md) · [Next: Account Factory →](02-account-factory.md)
