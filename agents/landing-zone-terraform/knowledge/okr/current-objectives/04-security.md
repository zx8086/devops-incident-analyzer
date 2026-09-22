[← Back to index](README.md)

# 4. Security

*(LZ KB: Org boundaries · Security tooling · Service Control Policies · Permission boundaries · KMS · Config rules · Domain Controllers)*

```
Category: Security
Status:   TO BE REVIEWED (LZ KB) / 6 of 21 ADRs Accepted, live 2026-07-31
Owner:    CCoE Platform Team
```

## Objective

The Landing Zone is secure by default, with boundaries enforced structurally (accounts, OUs, keys) rather than by convention.

## Key Results

- [ ] **KR1 —** 100% of accounts have a dedicated customer-managed KMS key (annual rotation); `prevent_destroy = true` on every `aws_kms_key`/alias and every `aws_organizations_account` — 0 exceptions, since both are irreversible deletions. *(AGENT_PROMPT §13)*
- [ ] **KR2 —** SCPs are attached only at the OU boundary, never to individual accounts — 0 account-level SCP attachments found in an audit. *(matches the KB's four boundary types: account / OU / segment (Cloud WAN) / key)*
- [ ] **KR3 —** Every constrained Terraform variable ships with a `validation` block (environment, region, application_name, etc.) — fails at `plan` time, never mid-`apply`. *(AGENT_PROMPT §7)*
- [ ] **KR4 —** Developer/CI roles carry a permission boundary that prevents privilege escalation — verified by an IAM Access Analyzer finding count of 0 for escalation paths. **Currently unverifiable in practice:** the real `aws_accessanalyzer_analyzer` resource in `aws-lz-account-creator/modules/account-bootstrap/access_analyzer.tf` is entirely commented out — see Real-World Examples below. Access Analyzer isn't deployed to new accounts today, so "0 findings" can't be measured; the permission boundary itself (see the KMS/IAM real example below) does appear to be wired up independently.
- [ ] **KR5 —** `DataClassification` and `BusinessCriticality` tag values are drawn from **one** agreed enum everywhere (see [FinOps](06-finops.md) for the current mismatch) — this is a Security concern too, since `DataClassification` drives KMS key policy and backup tier selection. *(AGENT_PROMPT §8)*

## Governing ADRs (`cap-security`, live 2026-07-31 — 21 ADRs)

| ADR | Title | Status |
|---|---|---|
| [0007](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1391034369) | Organisational Boundaries | **Accepted** |
| [0015](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1403846657) | AWS Security Tooling | **Accepted** |
| [0023](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1460011009) | Permission Boundaries | **Accepted** |
| [0024](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1489502255) | Security Aggregation | Review |
| [0030](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1467056130) | AWS SSO (IAM Identity Center) Configuration via Terraform | **Accepted** |
| [0034](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1547862192) | Cross-Account Role Strategy | **Accepted** |
| [0043](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827602463) | Active Directory Integration | Proposal |
| [0045](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1489502238) | KMS Usage | **Accepted** |
| [0053](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827504129) | SSM Usage Policy | Proposal |
| [0054](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827602448) | Bastion | Proposal *(stub — **duplicate ADR number**, see below)* |
| [0056](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1954447361) | Just in Time Access Approach | Proposal |
| [0058](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1826816019) | Secrets | Proposal *(stub)* |
| [0059](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827635201) | Break Glass Procedures | Review |
| [0061](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2230288385) | Cloud Container Security | Proposal |
| [0062](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2312175627) | Secrets Management — AWS Secrets Manager | Proposal |
| [0063](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2318204956) | Certificate Management — ACM | Proposal |
| [0067](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1936064513) | SSO Emergency Access | Review |
| [0069](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2769354779) | License Management — SQL Server | Review |
| [0087](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1832484865) | Certificate Management | Proposal *(stub — likely duplicates 0063's scope; not yet reconciled)* |
| [0097](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2709192765) | Retail Identity & AD Domains | Proposal |
| [0102](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2837774365) | CyberArk PAM | Proposal *(stub, "next unused number" placeholder)* |

**Duplicate ADR number flagged:** `ADR-0054` is used for two unrelated, live pages — "Bastion" (Security, shown above) and "FinOps Governance Model" (`cap-finops`, see [FinOps](06-finops.md)). Both are Proposal-stage; neither is a typo of the other. Same issue affects `ADR-0055` (see FinOps). Treat the number alone as ambiguous until the CCoE Platform Team renumbers one.

Read: the four boundary primitives KR1/KR2/KR4 assume — org/account boundaries, permission boundaries, KMS, SSO — are all **Accepted** (6 of 21), consistent with the KB's own framing of security as "boundaries enforced structurally." What's unratified is almost everything about *how a human gets privileged access when the structural boundary isn't enough*: break-glass, JIT access, bastion, secrets management, and certificate management are all still Review/Proposal/stub. An agent asked to author Terraform for any of those should treat AGENT_PROMPT's silence on them as expected, not an oversight.

## Real-World Examples (from `aws-lz-account-creator`, live repo, 2026-07-31)

**KMS — confirms KR1 exactly.** `modules/account-bootstrap/kms.tf` creates one default customer-managed key per region (`for_each = toset(var.region)`), with `enable_key_rotation = true` and:

```hcl
lifecycle {
  prevent_destroy = true
  ignore_changes  = [policy]
}
```

Both `prevent_destroy` and annual rotation match AGENT_PROMPT §13 precisely. The `ignore_changes = [policy]` is worth noting for anyone extending this module: Terraform will not self-heal a manually-edited key policy, by design — a drift-detection tool, not Terraform `plan`/`apply`, is the intended way to catch policy drift here.

**IAM Access Analyzer — contradicts KR4 as currently written.** The actual resource block in `modules/account-bootstrap/access_analyzer.tf` is fully commented out:

```hcl
# resource "aws_accessanalyzer_analyzer" "regional" {
#   for_each = toset(var.region)
#   provider  = aws.new_account
#   region    = each.value
#   analyzer_name = "${var.account_name}-${each.value}-access-analyzer"
#   type          = "ACCOUNT"
#   ...
# }
```

This means KR4's premise — "verified by an IAM Access Analyzer finding count of 0" — can't be checked today; there's no analyzer to query. This isn't a documentation gap like most of this bundle's other findings, it's commented-out code sitting in the exact module an agent would be pointed to. Worth a direct question to the platform team: intentionally disabled (cost, noise, a known issue) or just not yet turned back on?

**Budget/backup permission boundary — real evidence for the "boundary" half of KR4.** `modules/account-bootstrap/backup.tf`'s `aws_iam_role.backup` does carry a `permissions_boundary = aws_iam_policy.member_account_permission_boundary.arn`, so the boundary-attachment mechanism itself is live and used by at least one bootstrap-created role — it's specifically the *verification* (Access Analyzer) half of KR4 that's missing, not the boundary itself.

## Repository refresh (2026-09-21)

The host and image repositories received material hardening after the prior review: `aws-lz-ami` tightened cross-account KMS access and consolidated shared Image Builder components; `aws-lz-app-proxy`, `aws-lz-dc`, and `aws-lz-citrix` changed ingress, security-group, and IAM/deployment-role behavior; and `aws-lz-security-tools` corrected its delegated security-account target. The IAM Access Analyzer resource in account bootstrap remains commented out, so the earlier KR4 verification gap is still open. See the [repository refresh](findings/repository-refresh-2026-09-21.md#security).

---
[← Back to index](README.md) · [← Network](03-network.md) · [Next: Monitoring →](05-monitoring.md)
