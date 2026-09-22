[← Back to index](README.md)

# 7. Toolbox & Shared Services

*(LZ KB: Terraform remote state · Shared services · CI/CD platform · AMI pipeline)*

```
Category: Toolbox
Status:   TO BE DONE (LZ KB — least mature page of the seven) / 0 of 13 ADRs Accepted, live 2026-07-31
Owner:    CCoE Platform Team
```

## Objective

Terraform state is centralized, locked, encrypted, and never lost or corrupted by a concurrent run.

## Key Results

- [ ] **KR1 —** 100% of root modules declare a backend that matches the **one** agreed topology (bucket structure + locking mechanism) — **currently not true, this is the single highest-priority open item across all sources.** Now confirmed directly, not just inferred: `aws-lz-account-creator`'s and `aws-lz-finops`'s real `_backend.tf` files disagree with **each other**, not just with the Guide/ADR/KB — see Real-World Examples below.
- [ ] **KR2 —** 0 production repos run with locking disabled (`use_lockfile = false` with no documented reason, or no `dynamodb_table`) — **currently failing, confirmed by direct repo read (2026-07-31):** `aws-lz-account-creator`'s root `_backend.tf` sets `use_lockfile = false` explicitly, with no comment explaining why. This is no longer a Three-Way-Validation-doc citation — it's read directly from the live file this session.
- [ ] **KR3 —** Control-plane (account-vending) state is physically separated from workload state in a dedicated, KMS-protected bucket — **currently failing**: `aws-lz-account-creator` writes to the shared workload bucket today.
- [ ] **KR4 —** One workspace-naming (or key-naming) convention is used by 100% of repos — **currently two conventions coexist** (`pvh-aws-<workload>-<env>` for flat repos vs. `aws-account-<app>-<env>` for vended accounts), per the Three-Way Validation doc.
- [ ] **KR5 —** State lifecycle on decommission (archive → delete) never touches another workload's data — requires the shared-bucket model to be fully workspace/prefix-scoped, not bucket-scoped.

## ⚠ Conflict 3 — the LZ KB Toolbox page is a fourth, previously-uncompared data point, and it doesn't match the Guide either

The Toolbox page's own example backend config:

```hcl
terraform {
  backend "s3" {
    bucket         = "lz-tfstate-euw1"                    # per-region bucket
    key            = "workloads/alpha/prod/api.tfstate"   # literal path, not env:/<workspace>/...
    region         = "eu-west-1"
    dynamodb_table = "lz-tfstate-lock"                     # DynamoDB locking, not use_lockfile
    kms_key_id     = "alias/cmk-tfstate"
    role_arn       = "arn:aws:iam::<shared>:role/tfstate-rw"
    encrypt        = true
  }
}
```

Three existing findings already disagreed on this (Guide: native-S3-lockfile + one shared bucket + workspace keys; ADR-0009: DynamoDB + per-org/per-account buckets; repo reality: DynamoDB, mixed bucket practice). The KB page adds a **fourth, distinct position**: DynamoDB locking (agreeing with the ADR and the repo) **and** a **per-region** bucket naming scheme (`lz-tfstate-<region-abbrev>`) that matches *none* of the three previous models **and** a literal hierarchical state key instead of workspace-based keying. This needs a platform-team decision, not an agent-side guess — full detail in the [findings note](findings/lzkb-fourth-source-cross-validation.md#extended-conflict-state-backend-toolbox-page).

### Real backend.tf files, read directly (2026-07-31) — the conflict is sharper than "docs vs. repos"

`aws-lz-account-creator/_backend.tf` (root, control-plane repo):

```hcl
terraform {
  backend "s3" {
    bucket       = "pvh-terraform-state-bucket"
    key          = "terraform.tfstate"
    region       = "eu-central-1"
    use_lockfile = false
  }
}
```

`aws-lz-finops/_backend.tf` (root, a newer repo — created 2026-07-22):

```hcl
terraform {
  # Remote state lives in the shared-services account (346519312430). The runner
  # (in deployment-prd 160282065478) has no direct access to that bucket, so
  # Terraform assumes the shared-account TerraformCrossAccountRole for state —
  # per the LZ "Pipeline Setup" standard (use_lockfile = S3 native locking).
  backend "s3" {
    bucket       = "pvh-terraform-state-bucket"
    key          = "terraform.tfstate"
    region       = "eu-central-1"
    use_lockfile = true
    assume_role = {
      role_arn = "arn:aws:iam::346519312430:role/TerraformCrossAccountRole"
    }
  }
}
```

Both repos share the same bucket (`pvh-terraform-state-bucket`) and the identical literal key (`terraform.tfstate` — not workspace-scoped, not a hierarchical path, no per-repo prefix at all — a **fifth** real-world pattern that matches none of the Guide's, the ADR's, the KB's, or each other's stated conventions). Where they diverge is locking: account-creator explicitly disables it (`use_lockfile = false`), finops explicitly enables it and documents why, citing an internal "LZ Pipeline Setup standard" that isn't referenced anywhere else in this bundle and isn't one of the ADRs pulled above — worth asking the platform team whether that standard is written down somewhere findable. Two live root repos, sharing one bucket and one literal key, actively disagreeing on locking, is a materially stronger finding than "the docs and the repos don't match" — the repos don't match **each other**.

**Practical implication for an agent:** never assume `_backend.tf` from one repo is safe to copy into another. Check the specific repo's own file, and if it sets `use_lockfile = false` with no comment (like account-creator today), flag it rather than silently propagating it — sharing one bucket across repos with inconsistent locking is exactly the scenario concurrent-run state corruption comes from.

## Governing ADRs (`cap-platform`, Toolbox-relevant subset, live 2026-07-31 — 13 ADRs)

Pulled from the 22 `cap-platform`-labeled ADRs, filtered to the ones this page's own scope (Terraform state, CI/CD platform, AMI/image pipeline) actually covers — the rest of `cap-platform` (naming, vending automation, cross-account roles, SSO) already governs [Strategy](01-strategy.md)/[Account Factory](02-account-factory.md) and isn't repeated here.

| ADR | Title | Status |
|---|---|---|
| [0009](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1548517377) | Terraform State Management Strategy | Review |
| [0012](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1395425281) | Storage capabilities for cloud | Proposal |
| [0019](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1411776535) | CI/CD Infrastructure | Review |
| [0037](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1603469332) | GitLab Project Scaffolding | **"approved"** *(nonstandard status label — not one of the 6 canonical values; treat as accepted-in-practice but flag to the platform team)* |
| [0049](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827242000) | Terraform Modules | Review |
| [0050](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827405825) | Container Images | Proposal *(stub)* |
| [0051](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827438593) | Ansible | Proposal *(stub)* |
| [0052](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827274783) | OS Patching | Proposal *(stub)* |
| [0070](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2769354756) | SQL Server Deployment Patterns | Review |
| [0085](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827241985) | AMIs | Review |
| [0086](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827274753) | Build Process AMIs | Review |
| [0090](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2481553409) | Netapp Cloud Migration (Extending to FSxN) | Proposal |
| [0095](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2648113153) | DFS Namespaces on AWS | Review |

**The single most important fact in this table:** `ADR-0009` — the ADR that actually governs the Conflict 3 backend fight above — is confirmed still **Review**, not Accepted, as of 2026-07-31. Nothing has changed there since the June 15 baseline; the state-backend topology remains genuinely unratified, not just undocumented. Combined with the rest of the table, **Toolbox is the only category in this bundle with zero Accepted ADRs** (0 of 13) — which lines up exactly with the LZ KB marking this page "TO BE DONE" rather than the weaker "TO BE REVIEWED" used everywhere else. `ADR-0037` is worth a second look too: its status literally reads `"approved"`, a word that doesn't appear in the registry's own six-value status enum (proposal/review/accepted/superseded/deprecated/rejected) — functionally it's being treated as ratified, but it should be normalized to `accepted` or explained as a deliberate seventh state.

## Repository refresh (2026-09-21)

The full AWS-root census confirms three live behaviors: 10 roots use DynamoDB locking, 7 use native S3 lockfiles, and the 2 vending roots explicitly disable native locking. This strengthens the evidence for non-convergence but still does not authorize a migration. Separately, `gitlab-k8s-runners-lzv2` added on-demand behavior, state-lock serialization, strict unknown-key schema rejection, and transient-failure mitigation; `aws-lz-ami` automated recipe version bumps across supported operating systems. Exact repositories and HEADs are in the [repository refresh](findings/repository-refresh-2026-09-21.md#toolbox-ci-and-shared-services).

---
[← Back to index](README.md) · [← FinOps](06-finops.md) · [Next: Uncovered Domains →](08-uncovered-domains.md)
