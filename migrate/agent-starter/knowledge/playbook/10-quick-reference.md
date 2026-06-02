# 10. Quick reference

Source: Elastic_Optimisation_Playbook_v12 §10 (reference content).

## §10.1 Diagnosis commands

-----------------------

    # Cluster at a glance
    GET _cluster/health
    GET _cat/nodes?v&h=name,node.role,disk.used_percent,heap.percent
    GET _cat/allocation?v

    # ILM state
    GET _ilm/status
    GET _ilm/explain/<index-or-pattern>
    GET
    _cat/indices/<pattern>*?h=index,ilm.policy,ilm.phase,docs.count,store.size&v

    # Shards & allocation
    GET _cat/shards?v&h=index,shard,prirep,state,node,store

    # Snapshot health
    GET _snapshot/_all
    GET _snapshot/found-snapshots/_status

    # Autoscaling
    GET _autoscaling/capacity

    # Ingest
    GET _cluster/stats?filter_path=indices.docs,indices.indexing
    GET _nodes/stats/indices/indexing

## §10.2 Common fixes

-----------------

    # Reattach orphan index to policy
    PUT <index>/_settings { "index.lifecycle.name": "<policy>" }

    # Force ILM to retry a stuck step
    POST _ilm/retry/<index>

    # Move an index to a specific ILM step
    POST _ilm/move/<index>
    { "current_step": {...}, "next_step": {...} }

    # Delete a data stream
    DELETE _data_stream/<name>

    # Remove ILM policy from an index
    POST <index>/_ilm/remove

    # Close ML jobs before plan change
    POST _ml/anomaly_detectors/*/_close?force=true

    # Pin @custom pipeline via component template
    PUT _component_template/logs-system@custom
    { "template": { "settings": { "index.default_pipeline":
    "logs-system-@custom" } } }

## §10.3 Key thresholds

-------------------

  **Metric**                    **Normal**   **Watch**        **Act**
  ----------------------------- ------------ ---------------- --------------------------------
  Hot disk %                    \<70% 7      0--80% \>        80%
  Warm disk %                   \<75% 7      5--85% \>        85%
  Cold disk %                   \<75% 7      5--85% \>        85% → §7.2
  Shard count (\<10 nodes) \<   2,500 2,     500--3,500 \>3   ,500 → hygiene pass
  Rollovers / policy / day      1--3         4--10            \>10 → threshold review §6.4
  Docs / day growth w/w         ±5%          ±5--15%          \>±15% → instrumentation audit
  JVM heap %                    \<65% 6      5--80% \>        80%

## §10.4 Aggressive ILM rollover snippet (Phase 2A pattern)

-------------------------------------------------------

    PUT _ilm/policy/<name>
    {
      "policy": {
        "phases": {
          "hot": {
            "min_age": "0ms",
            "actions": {
              "rollover": {
                "max_age": "14d",
                "max_primary_shard_size": "50gb"
              },
              "set_priority": { "priority": 100 }
            }
          },
          ...
        }
      }
    }

Adjust max_age per retention: 14d for 90d retention, 7d for 30d, 3d for
≤14d. Do not add min_* conditions on shared policies.

## §10.5 Override index template snippet

------------------------------------

    PUT _index_template/<name>-override
    {
      "index_patterns": ["<integration-pattern>-*"],
      "priority": 300,
      "composed_of": [...same as integration template...],
      "ignore_missing_component_templates": [...the @custom hooks...],
      "template": { "settings": { "index": { "mode": "logsdb" } } },
      "data_stream": { "hidden": false, "allow_custom_routing": false }
    }

## §10.6 Reroute consolidation pipeline snippet

-------------------------------------------

    PUT _ingest/pipeline/<dataset>@custom
    {
      "processors": [
        { "pipeline": { "name": "<consolidation-pipeline-name>" } }
      ]
    }

10.7 max_shards_per_node ladder commands
-------------------------------------------

    # Inspect
    GET _cluster/settings?include_defaults=true&filter_path=*.cluster.max_shards_per_node

    # Lower in stages
    PUT _cluster/settings { "persistent": { "cluster.max_shards_per_node": "8000" } }
    PUT _cluster/settings { "persistent": { "cluster.max_shards_per_node": "4000" } }

    # Remove (only when cluster is below default 1000/node on every tier)
    PUT _cluster/settings { "persistent": { "cluster.max_shards_per_node": null } }

    # Emergency rollback
    PUT _cluster/settings { "persistent": { "cluster.max_shards_per_node": "10000" } }

