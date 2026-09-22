[← Back to index](README.md)

# 3. Network

*(LZ KB: Cloud WAN · Vendor TGW · Check Point Inspection · DNS · IPAM · Direct Connect · Netskope Publishers · lz-networking · Traffic flows · Service Quotas)*

```
Category: Network
Status:   TO BE REVIEWED (LZ KB) / 10 of 27 ADRs Accepted, live 2026-07-31
Owner:    CCoE Platform Team
```

## Objective

Every account reaches the network fabric (Cloud WAN, inspection, DNS, on-prem, private apps) through the same reviewed modules — no bespoke per-team networking.

## Key Results

- [ ] **KR1 —** 100% of Cloud WAN / TGW / IPAM / Direct Connect resources are sourced from Resource-tier shared modules (`aws-cloud-wan`, `aws-ipam`, `aws-network-service-quotas`), pinned to an exact semver tag — 0 uses of `?ref=main`/`HEAD`. *(AGENT_PROMPT §9)*
- [ ] **KR2 —** Check Point CloudGuard inspection (GWLB-backed) and Netskope Publishers (ZTNA) are composed via the Solution-tier module, never re-implemented locally per account.
- [ ] **KR3 —** Direct Connect capacity stays within documented limits per region without silent over/under-provisioning: `eu-central-1` 4×DX (6 Gbps, Equinix FR5/AM3), `us-east-1` 2×DX (10 Gbps, ATL13/VA1), `ap-southeast-1` 2×DX (4 Gbps, SG) — track actual vs. documented as a Service Quotas review item.
- [ ] **KR4 —** All east-west and egress traffic is inspected (0 direct-to-internet egress paths bypassing the Inspection VPC / GWLB).

## Standards feeding this objective

Module taxonomy and pinning rules (§9), multi-region pattern for per-region network resources (§11), locals for platform constants like ASN/CIDR ranges (§12).

## Governing ADRs (`cap-network`, live 2026-07-31 — 27 ADRs)

The largest single-capability ADR set in the registry, and the least-ratified relative to its size (10 of 27 Accepted, 2 Superseded, the rest split across Review and Proposal — several still unauthored stubs).

| ADR | Title | Status |
|---|---|---|
| [0002](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1423081483) | Cloud WAN | **Accepted** |
| [0003](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1387659281) | Regional Network Design | **Accepted** |
| [0008](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1391067137) | DNS | **Accepted** |
| [0010](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1395327020) | VPC Lattice | Proposal |
| [0014](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1404043265) | Vendor Transit Gateway | **Accepted** |
| [0018](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1400766512) | Inspection VPC | **Accepted** |
| [0020](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1408499751) | Egress | Superseded → 0046 |
| [0021](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1415839889) | Centralized IP Address Management (IPAM) | **Accepted** |
| [0022](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1452212226) | Networking Resources Management | Proposal *(decision undocumented)* |
| [0026](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1466466395) | Ingress VPC | Review |
| [0027](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1477443734) | CDN | Review |
| [0028](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1492647937) | User Access to Internal Applications (Netskope) | **Accepted** |
| [0029](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1492615186) | Hybrid Connectivity (Direct Connect / S2S VPN) | Proposal *(stub)* |
| [0035](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1580367875) | Public Endpoints Management | Review |
| [0036](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1580335108) | WAF | Proposal *(stub)* |
| [0042](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1859059725) | Network ACL Management for AWS CloudWAN Mixed Network Architecture | Superseded → 0060 |
| [0044](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1760722951) | Go-live plan | **Accepted** |
| [0046](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1827733505) | Egress Amendment | **Accepted** |
| [0060](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1809547267) | Inter AWS Workload Traffic Strategy | **Accepted** |
| [0064](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2588803104) | Isolated AWS DataSync Connectivity Pattern | Proposal |
| [0065](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1492615169) | Corporate SD-WAN | Proposal *(stub)* |
| [0072](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2457468943) | Load Balancing | Review |
| [0091](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2584838230) | F5 BIG-IP Platform | Review |
| [0092](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2607153307) | Infoblox | Proposal |
| [0093](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2607153324) | Checkpoint | Proposal |
| [0096](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/2712731649) | Kong API Management | Proposal |
| [0098](https://pvhcorp.atlassian.net/wiki/spaces/DHCO/pages/1492582401) | Retail Connectivity (SD-WAN) | Proposal |

Read: the network *fabric itself* (Cloud WAN, IPAM, TGW, DNS, Inspection VPC, egress) is Accepted and stable — this matches what KR1/KR2/KR4 above assume. What's unsettled is almost everything at the *edge*: CDN, WAF, public endpoints, load balancing, F5, Infoblox, retail SD-WAN, and both hybrid-connectivity ADRs are still stubs. If an agent is asked to author Terraform for any of those edge topics, treat AGENT_PROMPT's silence on them as expected — there's no ratified pattern yet to encode.

## Real-World Examples (from `aws-lz-networking`, live Resource-tier module repo, 2026-07-31)

`cloud-wan.tf`'s `aws_networkmanager_vpc_attachment` is the actual Cloud WAN attachment resource this category's KR1 describes. It uses `lifecycle { precondition { ... } }` blocks rather than variable `validation {}` blocks to fail fast:

```hcl
lifecycle {
  precondition {
    condition     = var.cloudwan_core_network_id != ""
    error_message = "Cloud WAN core network ID must be provided for VPC attachment."
  }
  precondition {
    condition = local.use_native_ipam ? (
      length(local.native_wan_subnet_ids) > 0
      ) : (
      length(data.aws_subnets.wan_subnets[0].ids) > 0
    )
    error_message = "WAN subnets must exist for Cloud WAN attachment. Ensure WAN subnets are configured in vpc_config.subnets."
  }
}
```

This is the same "fail at `plan`, not mid-`apply`" intent [Security KR3](04-security.md) and AGENT_PROMPT §7 describe for input variables — just implemented as resource-level `precondition`s instead of `variable { validation {} }` blocks, since the thing being validated (a live core-network ID, actual subnet existence) isn't knowable from the variable alone. Worth noting in AGENT_PROMPT as a second, equally valid validation pattern rather than treating `variable validation` as the only sanctioned mechanism.

## Repository refresh (2026-09-21)

`aws-lz-network-core` now carries ingress-VPC definitions in its WAN YAML. `aws-lz-network-workloads` made the workload-VPC JSON schema a blocking CI contract, added changed-file child pipelines and an explicit gate for undeclared rename/deletion destroys, and publishes an address-space catalog from code and state. The repository currently contains 97 environment YAML files; treat that as a dated inventory, not a standard. Details and source paths are in the [repository refresh](findings/repository-refresh-2026-09-21.md#network).

---
[← Back to index](README.md) · [← Account Factory](02-account-factory.md) · [Next: Security →](04-security.md)
