---
type: Stack
title: aws-lz-infra-ss-components
description: The LZ knowledge-base web host — ASG, Route 53 record, SSH key material in SSM, an S3 content bucket, and a cross-account DynamoDB read role.
resource: aws-lz-infra-ss-components
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, shared-services, asg, route53, dynamodb, s3]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: ddb
    resource: aws-lz-infra-ss-components/dynamodb_access.tf
    title: Cross-account DynamoDB read policy
  - id: vars
    resource: aws-lz-infra-ss-components/_variables.tf
    title: Root variables
---

# When this applies

The knowledge-base site content, its host, its DNS record, its security group,
or the cross-account DynamoDB read path changes.

# Surface

**Edit:** `web_server.tf`, `web_dns.tf`, `web_ssh.tf`, `knowledge_base.tf`,
`dynamodb_access.tf`, `_locals.tf`, `_variables.tf`,
`templates/userdata_lzkb.sh`, and the site content under `knowledge_base/`.

**Never edit:** `_backend.tf`, `_versions.tf`.

# Traps

- **The README's architecture diagram contradicts the code.** It labels the
  DynamoDB source as a `stg` account and names the tables differently from the
  ARNs the policy actually grants. [^ddb] The same README's changelog records
  the correction that the diagram never received. `_variables.tf`,
  `provider.tf`, `.gitlab-ci.yml` and `dynamodb_access.tf` are authoritative —
  never take an account or table name from the diagram.
- `dynamodb_account_id`'s own `description` still says the tables live in `stg`
  while its default points elsewhere. [^vars] The default is what runs.
- **`knowledge_base` sources the shared S3 module at `?ref=main`.** `AGENTS.md`
  forbids `main`, a branch, or an untagged commit as a module ref. [^agents-md]
  It is one of seven non-tag refs across the estate — see
  [/shared/index.md](/shared/index.md). Any change to this root can pick up an
  unrelated upstream change with no diff to review.
  Pinning it is a real change with a plan impact, not a cleanup — verify the
  released tag that matches current behaviour first.
- The naming module here is pinned several major-minor steps behind every other
  repo in the estate. Bumping it can change generated resource names, which
  means replacements.
- **The AWS provider is upper-bounded** (`< 6.57`) — the only repo with a
  ceiling. There is a reason it is there; do not raise it as a side effect.
- `tls_private_key` plus `aws_key_pair` generate SSH material into state and
  SSM. It is sensitive by construction. Never echo the SSM paths' values.
- The site is served from an ASG behind a Route 53 A record that user data
  updates on launch. The record's value is therefore runtime-owned; a plan
  proposing to change it means the ASG rebuilt.
- Uses S3 native locking with a backend `assume_role` into the same account the
  provider uses.

# Fields

Root inputs: `region` · `dynamodb_account_id` · `dynamodb_region` ·
`dynamodb_role_name`.

Root outputs: `asg_name` · `bucket_name` · `bucket_arn` · `web_fqdn` ·
`web_security_group_id` · `ssm_password_path` · `ssm_ssh_key_path` ·
`stg_dynamodb_role`.

# Plan

Content change under `knowledge_base/`: `N in place` on `aws_s3_object`.
Security-group or DNS edit: `1 in place`. Launch-template change: `1 to change`
plus an ASG refresh. Pinning the S3 module ref: unknown until planned — state
that explicitly.

# Stop

- A change relies on a fact taken from the README diagram rather than from code.
- The S3 module ref is being pinned without first confirming which released tag
  matches deployed behaviour.
- The provider ceiling is being raised without a stated reason.
- SSH key material would be regenerated, invalidating existing access.
