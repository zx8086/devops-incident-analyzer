# Stack modules — what lives where

## `modules/elastic-cloud-deployment/`

Wraps `elasticstack_elasticsearch_cloud_deployment` (or equivalent). Inputs:

- `cluster_name`
- `topology` — map of tier → `{ size_per_zone, max_size_per_zone, zones, hardware_profile }`
- `enable_autoscaling` (bool)
- `region`

Outputs: deployment_id, endpoints, plan_id.

## `modules/ilm-policy/`

Generates a single ILM policy. Inputs:

- `name`
- `phases` (map of phase → settings)
- `rollover` (max_age, max_primary_shard_size, max_size)
- `force_merge_segments`

## Tier sizing — autoscaling order

Provider mirrors the API: `max_size_per_zone >= size_per_zone` is enforced. On downsize, two commits:

1. Lower `size_per_zone`.
2. Lower `max_size_per_zone`.

Upsizing or changing only Max → single commit.

## Templates

Priority cheat-sheet for PVH:

| Priority | Purpose |
|---|---|
| 251 | nonprod-retention-fleet (⚠ may be empty body inheriting prod 90d) |
| 200 | dataset-specific overrides |
| 100 | stack-shipped defaults |

When auditing dev/stg shard sprawl, always check 251 templates with empty body.

## Ingest pipelines — the hook surface

For Elastic Agent / Fleet streams, `logs@custom` is the only global hook. Guard your processors by `dataset` to avoid clobbering unrelated streams. Removing dotted OTel keys requires a `script` processor, not `remove` (remove fails on dotted keys).
