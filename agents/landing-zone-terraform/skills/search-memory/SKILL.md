---
name: search-memory
description: Recall prior PVH Landing Zone decisions and outcomes as advisory context that must be revalidated against live evidence.
inputs:
  question: { type: string, required: true }
outputs:
  prior_memory: { type: array }
---

# Search Landing Zone memory

Use cross-session memory for questions about why a prior decision was made, whether an approach was tried, or what outcome was recorded. The graph automatically searches the independent `landing-zone-terraform` identity using the current question and any known repository and account filters.

Memory is advisory. Label every returned item as prior experience requiring live revalidation. Never use memory to authorize an OU, permission set, account, CIDR, IPAM pool, region, runner permission, backend, or other deployable value. Current GitLab, AWS, accepted PVH decisions, and deterministic graph history take precedence.

Prefer these durable kinds: `terraform-change`, `account-vending`, `network-onboarding`, `dns-design`, `gitlab-project`, `runner-onboarding`, `plan-outcome`, `key-decision`, `platform-exception`, `failed-approach`, and `learned-pattern`. `in-flight-change` is temporary and must be checked against the live merge request and pipeline before reporting status.

An empty result means no matching memory was found or memory was unavailable. It does not prove that an event never happened.

Do not store or repeat secrets, credentials, Terraform state values, sensitive plan values, plaintext environment variables, or routine tool output. Durable records require a reviewed decision or confirmed outcome and must retain repository, account, workflow, merge-request URL, and config-change identifiers when those values are known.
