---
type: Stack
title: aws-lz-storage
description: FSx for NetApp ONTAP — filesystems, SVMs and volumes driven by a per-environment, per-region, per-cluster config tree, plus AD secrets and an optional test client.
resource: aws-lz-storage
archetype: yaml-driven-root
change_class: gitops-config
tags: [aws-lz, fsxn, ontap, storage, secretsmanager, yaml]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: repo
    resource: aws-lz-storage
    title: Repository contents as checked out
---

# When this applies

An FSx ONTAP filesystem, SVM or volume is created, resized or retired; AD
secrets change; the test client is enabled or disabled.

# Surface

**Edit:** `config/<env>/<region>/<cluster>/filesystem.yaml`,
`config/<env>/<region>/<cluster>/svms/<n>.yaml`,
`config/<env>/<region>/<cluster>/volumes/<n>/<volume>.yaml`. This tree is the
intended change surface. `modules/fsxn-*/` for behaviour changes.

**Never edit:** `_backend.tf`, `_versions.tf`. `_modules.tf`, `main.tf` and
`_locals.tf` are generic loaders.

# Traps

- **The config tree's directory shape is the key structure.** Cluster, SVM and
  volume identity come from the path, not from a field inside the file. Moving
  or renaming a directory changes the `for_each` key and destroys and recreates
  the resource. Never reorganise the tree to tidy it.
- **`ignore_changes` appears ten times across this repo** — more than anywhere
  else in the estate. Each one hides a field from drift detection. Before
  concluding a config edit "has no effect", check whether the field you changed
  is ignored.
- `aws_fsx_ontap_volume` size and type changes are not uniformly in-place.
  Verify against the provider whether the specific attribute forces replacement
  before stating an expected plan — a replaced volume loses data.
- Storage capacity on `aws_fsx_ontap_file_system` can generally grow but not
  shrink. A reduction is a replace.
- `modules/fsxn-ad-secret` and `modules/fsxn-secret` are two different modules
  that both create a Secrets Manager secret with a `random_password`. Establish
  which one owns the secret you are changing before editing either.
- `modules/fsxn-test-client` builds an EC2 instance. It is a diagnostic aid, not
  part of the storage service; leaving it enabled in production is a cost and
  surface decision, not a default.
- SnapMirror handoff to the secondary cluster is described in the README as an
  operational step; it is not driven by this root.
- Seven local modules, none with a README. The `.tf` is the only source for
  their contracts — see the module concepts under `/modules/`.
- Uses DynamoDB locking with no backend `assume_role`; `required_version` is an
  upper-bounded range rather than the estate default. [^agents-md]

# Fields

`filesystem.yaml`: `deployment_type` · `storage_capacity_gib` ·
`throughput_capacity_mbps` · `automatic_backup_retention_days` ·
`endpoint_ip_address_range`.

SVM and volume files carry their own key sets; read a sibling file in the same
directory level before authoring a new one.

Root inputs: `account_id` · `environment` · `application_name` ·
`mandatory_tags` · `custom_tags`.

Root outputs: `filesystems` · `svms` · `volumes` · `intercluster_endpoints` ·
`svm_nfs_endpoints` · `fsxn_ad_secret_arns` · `fsxn_test_client_instance_ids`.

# Plan

New volume file: `1 to add`. Capacity increase: `1 in place`. Capacity
decrease, or a type change: verify replacement behaviour first. Directory
rename: destroy plus add — never the intended change.

# Stop

- Any plan proposing to destroy or replace a filesystem, SVM or volume.
- A capacity reduction is requested.
- A config directory would be moved or renamed.
- The field being changed turns out to be under `ignore_changes`.
