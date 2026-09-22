---
type: Module
title: storage/fsxn-volume
description: One ONTAP volume per volume file, with SnapMirror-aware lifecycle handling.
resource: aws-lz-storage/modules/fsxn-volume
change_class: gitops-hcl
tags: [aws-lz, fsxn, ontap, volume, snapmirror]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-storage/modules/fsxn-volume
    title: Module source as checked out
  - id: parent
    resource: aws-lz-storage
    title: Consuming root — see /repos/aws-lz-storage.md
---

# When this applies

A volume is added, resized, retyped, or moves out of a SnapMirror relationship.

# Surface

**Edit:** `aws-lz-storage/modules/fsxn-volume/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `_modules.tf` / `main.tf` in the storage root, iterated over the `config/` tree. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-storage.md](/repos/aws-lz-storage.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **`ontap_volume_type` and `junction_path` are both under `ignore_changes`, deliberately.** After a SnapMirror cutover the storage team breaks the mirror, ONTAP converts the volume from DP to RW and sets the junction path on the ONTAP side. Terraform must not revert either. Changing these in config has no effect.
- That also means the config and the live volume legitimately disagree on those two fields. Do not report it as drift to reconcile.
- A size reduction is not an in-place operation. Verify replacement behaviour before stating a plan shape — a replaced volume loses data.
- Volume identity is the file path under `volumes/<svm>/`. Moving a volume file between SVM directories destroys and recreates it.
- Deleting a volume file destroys the volume and its data on the next apply.

# Fields

Inputs: `cooling_period_days` · `junction_path` · `name` · `ontap_name_prefix` · `region` · `security_style` · `size_mb` · `snapshot_policy` · `storage_efficiency_enabled` · `svm_id` · `tags` · `tiering_policy` · `type`

Outputs: `arn` · `id` · `name` · `type` · `uuid`

# Plan

New volume: `1 to add`. Size increase or policy edit: `1 in place`. Type or junction-path change: no plan diff, by design.

# Stop

- Any plan proposing to destroy or replace a volume.
- A change would remove either field from `ignore_changes`.
- A volume file would be moved between directories.
