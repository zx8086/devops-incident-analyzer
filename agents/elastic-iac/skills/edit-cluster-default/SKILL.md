---
name: edit-cluster-default
description: Set total_shards_per_node on an EXISTING cluster-defaults index template in IaC (read-modify-write the per-template JSON + open an MR). Does NOT create templates. Lowering is flagged.
inputs:
  cluster: { type: string, required: true }
  template_name: { type: string, required: true }        # template file basename, e.g. "logs" (NOT the @custom suffix)
  total_shards_per_node: { type: number, required: true } # positive integer
---

# Set total_shards_per_node on a cluster-defaults template

Source of truth: `environments/<cluster>/cluster-defaults/<template>.json` -- ONE file per `<name>@custom` index template.

```json
{ "name": "logs@custom", "settings": { "index": { "routing": { "allocation": { "total_shards_per_node": 2 } } } } }
```

The file basename is the part before `.json` and WITHOUT the `@custom` suffix (e.g. `logs`, `metrics`, `metrics-system.cpu`).

## The change (read-modify-write)

1. Read `environments/<cluster>/cluster-defaults/<template>.json` via `gitlab_get_file_content`. A 404 means the template doesn't exist -- STOP (creating a new template is out of scope).
2. Set `settings.index.routing.allocation.total_shards_per_node` (creating the nested path if absent). Preserve every other setting + 2-space indent + trailing newline.
3. Commit to a branch + open the MR.

## Risk

- **LOW** when raising or setting on a multi-node cluster. The setting affects allocation as NEW indices roll over (not retroactively).
- **MEDIUM when LOWERING**: it concentrates shards on fewer nodes and can block shard placement if `total_shards_per_node x nodes < shard_count`. Surface a leading risk line and confirm the deployment's node count supports the value.
- `total_shards_per_node` must be a positive integer.

## Anti-patterns -- refuse to write

- Creating a NEW cluster-defaults template (out of scope).
- A value < 1 or non-integer.
- Lowering below `ceil(primary_shards / node_count)` for the targeted indices without confirmation -- it can wedge allocation.

## MR body

Use `knowledge/reference/mr-template.md` headings. Category: `cluster-defaults`. Risk: LOW (MEDIUM when lowering). State the resolved change (`logs@custom: total_shards_per_node 2 -> 3`), the single file touched, and the rollback (revert the MR).
