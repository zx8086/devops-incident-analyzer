[← Back to index](README.md)

# 8. Uncovered Capability Domains

*(No corresponding LZ KB page — these are real, live ADR capability areas in the Confluence registry with nowhere in the LZ KB's Strategy/Account Factory/Network/Security/Monitoring/FinOps/Toolbox navigation to live.)*

```
Category: Uncovered Capability Domains
Status:   NOT ON THE LZ KB NAV — tracked here so it isn't lost
Owner:    CCoE Platform Team (varies by sub-domain, see tables)
```

## Why this file exists

The LZ KB screenshots supplied for this bundle cover seven topic pages. The live Confluence ADR registry defines **twelve** capability labels. Five of them — Disaster Recovery, Workload Enablement, Data, AI, and Service Enablement & Management — have real, dated ADR activity (20 ADRs total) but no corresponding page in the KB's navigation. A twelfth label, Service Integration & Governance (`cap-sig`), currently has **zero** ADRs tagged against it at all. None of this is a defect in this bundle's structure — it's a gap in the *LZ KB itself*, worth surfacing so an agent (or reviewer) doesn't assume "not in the KB" means "not decided anywhere."

## Disaster Recovery (`cap-dr` — 4 ADRs, 0 Accepted)

| ADR | Title | Status |
|---|---|---|
| [0066](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2239103004) | DR Options | Review |
| [0067](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1936064513) | SSO Emergency Access | Review *(also Security — see [Security](04-security.md))* |
| [0071](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2753626144) | AWS Backup Feature in DR Factory | Review |
| [0084](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2239102988) | Centralized Backup Architecture | Review |

Read: a coherent, self-consistent DR story exists (options → backup architecture → the AWS Backup feature that implements it → the SSO break-glass path for when DR is actually invoked) — all four ADRs were opened within days of each other in February 2026 and all four are still Review. Nothing here is Accepted yet, but nothing looks contradictory either; this reads as "in progress," not "stalled."

**Real-World Example — the code is well ahead of the ADRs.** `aws-lz-account-creator/modules/account-bootstrap/backup.tf` (live, 2026-07-31) is a fully built, tiered AWS Backup implementation: per-region vaults with a deny-delete vault policy, and five distinct backup plans — `local` (stateful-only, daily/7-day, prd), `default` (daily/7-day, prd), `mission_critical` (daily + every 8h, prd), `business_critical` (daily + every 12h, prd), and `nonprod` (daily/3-day, non-prd) — selected per-resource via a `BackupStrategy` tag (see [FinOps](06-finops.md) for the undocumented-tag note) with `BusinessCriticality` routing prod resources into the right tier automatically. This is considerably more mature than "4 ADRs, all Review" suggests — the implementation exists and is tiered by business criticality exactly as a mature DR program would want; it's the *paper trail* (ADR-0066/0071/0084) that hasn't caught up to what's already running, not the other way around. Worth flagging to the CCoE Platform Team as a case where ratifying the ADRs is closer to "document what's already true" than "decide something new."

## Workload Enablement (`cap-workload` — 7 ADRs, 0 formally Accepted, 1 nonstandard "approved")

| ADR | Title | Status |
|---|---|---|
| [0017](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1414430721) | Central SFTP Service | Proposal *(stub)* |
| [0019](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1411776535) | CI/CD Infrastructure | Review *(also Platform Engineering — see [Toolbox](07-toolbox.md))* |
| [0037](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1603469332) | GitLab Project Scaffolding | **"approved"** *(nonstandard label; also Platform Engineering — see [Toolbox](07-toolbox.md))* |
| [0055](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827602433) | Mailing | Proposal *(stub — **duplicate ADR number**, see [FinOps](06-finops.md) for the other "ADR-0055")* |
| [0057](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827274798) | Artifactory / Image Registry | Proposal *(stub)* |
| [0080](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1955921921) | Intake Process | Proposal *(stub — also Strategy & Governance, see [Strategy](01-strategy.md))* |
| [0081](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1953824821) | Account Request Form | Proposal *(also Strategy & Governance)* |

Read: this is the domain with the most unwritten stubs (SFTP, Mailing, Artifactory/Image Registry are all placeholder pages with no real content yet). It's also where the account-vending "front door" (Intake Process, Account Request Form) actually lives, cross-tagged into Strategy. If an agent is asked to provision anything touching partner file transfer, outbound mail, or an internal image registry, there is currently **no ratified pattern to follow** — treat AGENT_PROMPT's silence on these as "not yet decided," not "out of scope."

## Data (`cap-data` — 3 ADRs, all Proposal)

| ADR | Title | Status |
|---|---|---|
| [0076](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2809233462) | Data Platform | Proposal |
| [0078](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2813460482) | Data Lakehouse & Catalogue | Proposal |
| [0079](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2813558785) | Analytics & Query Services | Proposal |

Read: all three were opened in the same week (mid-July 2026), each explicitly preceding the next (Platform → Lakehouse & Catalogue → Analytics & Query Services), each cross-referencing Security (classification/KMS/Macie), FinOps, and Platform Engineering as contributors. This is a brand-new capability area still being scoped end-to-end — nothing to build against yet, but worth watching since it will eventually intersect Security's `DataClassification` enum (see the [FinOps conflict](06-finops.md#-conflict-1--dataclassification--businesscriticality-enums-dont-match)).

## AI (`cap-ai` — 5 ADRs, all Proposal)

| ADR | Title | Status |
|---|---|---|
| [0077](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2809823269) | AI/ML Enablement | Proposal |
| [0083](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2813394958) | Amazon Bedrock — Foundation-Model Access | Proposal |
| [0089](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2813591553) | Retrieval-Augmented Generation & Knowledge Bases | Proposal |
| [0099](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2813198339) | Responsible-AI Guardrails, Prompt Logging & DLP | Proposal |
| [0100](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2813362186) | Sekhmet — Agentic AI Platform | Proposal |

Read: a full AI capability stack was drafted in one sitting (mid-July 2026): base enablement → model access (Bedrock) → grounding (RAG/knowledge bases) → guardrails/DLP → a named agentic platform ("Sekhmet") sitting on top of all of it. All five are Proposal — none ratified. Notably, ADR-0100 (Sekhmet) explicitly lists Platform Engineering (vending, IaC) as a contributor, meaning a future version of *this very bundle* may eventually need a "Sekhmet" or "Agentic AI" category once any of these move past Proposal.

## Service Enablement & Management (`cap-sem` — 1 ADR)

| ADR | Title | Status |
|---|---|---|
| [0068](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2298445863) | Platform Operating Model | Proposal *(also Strategy & Governance — see [Strategy](01-strategy.md))* |

Read: this is really an extension of Strategy's operating-model question (see 01-strategy.md's Governing ADRs table) rather than an independent domain — it's tagged `cap-sem` in addition to `cap-strategy`, and the two labels appear to describe the same underlying decision from two angles (the strategic "how do we run this" vs. the operational "who does what day to day").

## Service Integration & Governance (`cap-sig` — 0 ADRs)

No ADR in the registry currently carries this label. Either the label exists for future use and hasn't been needed yet, or decisions that should live here are being filed under a different capability (Strategy, Platform Engineering) without the more specific tag. Worth a one-line confirmation from the CCoE Platform Team on which it is — an empty capability label is easy to mistake for "nothing to govern here" when it may just mean "not tagged yet."

## Repository refresh (2026-09-21)

Operational implementation continued to move beyond the dated ADR snapshot. `aws-lz-backup` expanded regional coverage, corrected Veeam S3 access, and bounded DR vault-lock retention; account bootstrap added Windows VSS backup support. The new `aws-lz-ssm` root provides centrally shared SSM documents and monthly patch scheduling. These are implementation facts, not evidence that the Disaster Recovery or OS-patching ADR statuses changed. See the [repository refresh](findings/repository-refresh-2026-09-21.md#disaster-recovery-and-operations).

---
[← Back to index](README.md) · [← Toolbox](07-toolbox.md) · [Findings note →](findings/lzkb-fourth-source-cross-validation.md)
